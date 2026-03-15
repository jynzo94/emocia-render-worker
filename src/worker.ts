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

function getVideoObjectKey(giftCode: string) {
  return `gifts/${giftCode}/video/video.mp4`;
}

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
  // In the current single-worker deployment model, a restart invalidates any
  // in-flight queue state. Clear BullMQ first so retries cannot attach to stale jobs.
  const countsBefore = await recoveryQueue.getJobCounts(
    "wait",
    "active",
    "delayed",
    "prioritized",
    "failed",
    "completed",
  );
  await recoveryQueue.obliterate({ force: true });

  console.log({
    ts: new Date().toISOString(),
    level: "info",
    event: "video_export.startup_queue_cleared",
    waitingBefore: countsBefore.wait ?? 0,
    activeBefore: countsBefore.active ?? 0,
    delayedBefore: countsBefore.delayed ?? 0,
    prioritizedBefore: countsBefore.prioritized ?? 0,
    failedBefore: countsBefore.failed ?? 0,
    completedBefore: countsBefore.completed ?? 0,
  });

  const gifts = await getGiftsCollection();
  const result = await gifts.updateMany(
    {
      videoExportStatus: { $in: ["queued", "processing"] },
    },
    {
      $set: {
        videoExportStatus: "failed",
      },
    },
  );

  console.log({
    ts: new Date().toISOString(),
    level: "info",
    event: "video_export.startup_interrupted_exports_failed",
    matchedCount: result.matchedCount,
    modifiedCount: result.modifiedCount,
    reason: "worker_restart_reset",
  });
}

export const worker = new Worker<RenderVideoJob>(
  VIDEO_RENDER_QUEUE_NAME,
  async (job) => {
    const startedAt = Date.now();
    let lastReportedProgress = -1;

    console.log({
      ts: new Date().toISOString(),
      level: "info",
      event: "video_export.job_started",
      jobId: job.id,
      queueName: job.queueName,
      attemptsMade: job.attemptsMade,
      giftCode: job.data.giftCode,
      renderUrl: `${config.appBaseUrl}/gift/${encodeURIComponent(job.data.giftCode)}?export=1`,
      outputObjectKey: getVideoObjectKey(job.data.giftCode),
    });

    await markGiftStatus(job.data.giftCode, {
      videoExportStatus: "processing",
    });
    await job.updateProgress(0);

    try {
      const renderStartedAt = Date.now();
      const videoBuffer = await renderVideo(job.data, async (progress) => {
        const normalizedProgress = Math.max(
          0,
          Math.min(100, Math.round(progress)),
        );

        if (normalizedProgress === lastReportedProgress) {
          return;
        }

        lastReportedProgress = normalizedProgress;
        await job.updateProgress(normalizedProgress);
      });
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
      const outputObjectKey = getVideoObjectKey(job.data.giftCode);
      await uploadVideoObject({
        objectKey: outputObjectKey,
        body: videoBuffer,
      });

      await markGiftStatus(job.data.giftCode, {
        videoExportStatus: "completed",
        videoExportFileKey: outputObjectKey,
      });

      console.log({
        ts: new Date().toISOString(),
        level: "info",
        event: "video_export.job_succeeded",
        jobId: job.id,
        giftCode: job.data.giftCode,
        renderDurationSec: utils.seconds(Date.now() - renderStartedAt),
        uploadDurationSec: utils.seconds(Date.now() - uploadStartedAt),
        durationSec: utils.seconds(Date.now() - startedAt),
      });

      return { ok: true };
    } catch (error) {
      await markGiftStatus(job.data.giftCode, {
        videoExportStatus: "failed",
      });

      console.error({
        ts: new Date().toISOString(),
        level: "error",
        event: "video_export.job_marked_failed",
        jobId: job.id,
        giftCode: job.data.giftCode,
        reason: "render_or_upload_failed",
        errorMessage: truncateError(error),
        error:
          error instanceof Error
            ? {
                name: error.name,
                message: error.message,
                stack: error.stack,
              }
            : { message: String(error) },
      });

      console.error({
        ts: new Date().toISOString(),
        level: "error",
        event: "video_export.job_failed",
        jobId: job.id,
        giftCode: job.data.giftCode,
        durationSec: utils.seconds(Date.now() - startedAt),
        error:
          error instanceof Error
            ? {
                name: error.name,
                message: error.message,
                stack: error.stack,
              }
            : { message: String(error) },
      });

      throw error;
    }
  },
  {
    connection: { url: config.redisUrl },
    concurrency: WORKER_CONCURRENCY,
    autorun: false,
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
    error:
      error instanceof Error
        ? {
            name: error.name,
            message: error.message,
            stack: error.stack,
          }
        : { message: String(error) },
  });

  if (!job) return;
});
