import { Queue, Worker } from "bullmq";

import {
  config,
  JOB_LOCK_DURATION_MS,
  JOB_STALLED_INTERVAL_MS,
  VIDEO_RENDER_QUEUE_NAME,
  WORKER_CONCURRENCY,
} from "./config.js";
import { getGiftsCollection } from "./mongo.js";
import { renderVideo } from "./render.js";
import { uploadVideoObject } from "./storage.js";
import type { RenderVideoJob } from "./types.js";
import { utils } from "./utils.js";

// This Queue instance points to the same Redis-backed `video.render` queue as the Worker
// below. It is only used for startup cleanup/reset operations, not for job processing.
const recoveryQueue = new Queue<RenderVideoJob>(VIDEO_RENDER_QUEUE_NAME, {
  connection: { url: config.redisUrl },
  defaultJobOptions: {
    attempts: 3,
    backoff: {
      type: "exponential",
      delay: 15_000,
    },
    removeOnComplete: 100,
    removeOnFail: 100,
  },
});

function truncateError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return message.slice(0, 500);
}

async function markGiftStatus(
  giftCode: string,
  update: Record<string, unknown>,
) {
  const gifts = await getGiftsCollection();
  console.log({
    ts: new Date().toISOString(),
    level: "info",
    event: "video_export.db_status_update",
    giftCode,
    fields: Object.keys(update),
    update,
  });
  await gifts.updateOne({ code: giftCode }, { $set: update });
}

export async function resetInterruptedVideoExportsOnStartup() {
  // In the current single-worker deployment model, a restart means any in-flight
  // render was interrupted. Clear queue state and mark queued/processing gifts as failed
  // so the UI can recover cleanly and the user can retry.
  await recoveryQueue.drain(true);
  const cleanedWaiting = await recoveryQueue.clean(0, 10_000, "wait");
  const cleanedActive = await recoveryQueue.clean(0, 10_000, "active");
  const cleanedDelayed = await recoveryQueue.clean(0, 10_000, "delayed");
  const cleanedPrioritized = await recoveryQueue.clean(0, 10_000, "prioritized");

  console.log({
    ts: new Date().toISOString(),
    level: "info",
    event: "video_export.startup_queue_cleared",
    cleanedWaiting: cleanedWaiting.length,
    cleanedActive: cleanedActive.length,
    cleanedDelayed: cleanedDelayed.length,
    cleanedPrioritized: cleanedPrioritized.length,
  });

  const gifts = await getGiftsCollection();
  const result = await gifts.updateMany(
    {
      videoExportStatus: { $in: ["queued", "processing"] },
    },
    {
      $set: {
        videoExportStatus: "failed",
        videoExportFailedAt: new Date(),
        videoExportError: "Video generation was interrupted by worker restart. Please try again.",
      },
    },
  );

  console.log({
    ts: new Date().toISOString(),
    level: "info",
    event: "video_export.startup_interrupted_exports_failed",
    matchedCount: result.matchedCount,
    modifiedCount: result.modifiedCount,
    errorMessage: "Video generation was interrupted by worker restart. Please try again.",
  });
}

export const worker = new Worker<RenderVideoJob>(
  VIDEO_RENDER_QUEUE_NAME,
  async (job) => {
    const startedAt = Date.now();

    console.log({
      ts: new Date().toISOString(),
      level: "info",
      event: "video_export.job_started",
      jobId: job.id,
      queueName: job.queueName,
      attemptsMade: job.attemptsMade,
      giftCode: job.data.giftCode,
      fingerprint: job.data.fingerprint,
      renderUrl: job.data.renderUrl,
      outputObjectKey: job.data.outputObjectKey,
    });

    await markGiftStatus(job.data.giftCode, {
      videoExportStatus: "processing",
      videoExportProcessingAt: new Date(),
      videoExportError: null,
    });

    try {
      const renderStartedAt = Date.now();
      const videoBuffer = await renderVideo(job.data);
      console.log({
        ts: new Date().toISOString(),
        level: "info",
      event: "video_export.render_buffer_ready",
      jobId: job.id,
      giftCode: job.data.giftCode,
      bytes: videoBuffer.byteLength,
      durationSec: utils.seconds(Date.now() - renderStartedAt),
    });

      const uploadStartedAt = Date.now();
      const downloadUrl = await uploadVideoObject({
        objectKey: job.data.outputObjectKey,
        body: videoBuffer,
      });

      await markGiftStatus(job.data.giftCode, {
        videoExportStatus: "completed",
        videoExportCompletedAt: new Date(),
        videoExportFailedAt: null,
        videoExportError: null,
        videoExportFileKey: job.data.outputObjectKey,
        videoExportUrl: downloadUrl,
        videoExportFingerprint: job.data.fingerprint,
      });

      console.log({
        ts: new Date().toISOString(),
        level: "info",
        event: "video_export.job_succeeded",
        jobId: job.id,
        giftCode: job.data.giftCode,
        downloadUrl,
        renderDurationSec: utils.seconds(Date.now() - renderStartedAt),
        uploadDurationSec: utils.seconds(Date.now() - uploadStartedAt),
        durationSec: utils.seconds(Date.now() - startedAt),
      });

      return { ok: true, downloadUrl };
    } catch (error) {
      await markGiftStatus(job.data.giftCode, {
        videoExportStatus: "failed",
        videoExportFailedAt: new Date(),
        videoExportError: truncateError(error),
      });

      console.error({
        ts: new Date().toISOString(),
        level: "error",
        event: "video_export.job_failed",
        jobId: job.id,
        giftCode: job.data.giftCode,
        fingerprint: job.data.fingerprint,
        durationSec: utils.seconds(Date.now() - startedAt),
        error:
          error instanceof Error
            ? (error.stack ?? error.message)
            : String(error),
      });

      throw error;
    }
  },
  {
    connection: { url: config.redisUrl },
    concurrency: WORKER_CONCURRENCY,
    // Keep dead-worker recovery reasonably fast without tying the Redis lock
    // lifetime to the full render timeout for long-running jobs.
    lockDuration: JOB_LOCK_DURATION_MS,
    stalledInterval: JOB_STALLED_INTERVAL_MS,
    maxStalledCount: 1,
  },
);

worker.on("completed", (job) => {
  console.log({
    ts: new Date().toISOString(),
    level: "info",
    event: "video_export.job_completed",
    jobId: job.id,
    giftCode: job.data.giftCode,
    attemptsMade: job.attemptsMade,
  });
});

worker.on("failed", async (job, error) => {
  console.error({
    ts: new Date().toISOString(),
    level: "error",
    event: "video_export.worker_failed",
    jobId: job?.id,
    giftCode: job?.data.giftCode,
    attemptsMade: job?.attemptsMade,
    error: error?.stack ?? error?.message ?? String(error),
  });

  if (!job) return;
});
