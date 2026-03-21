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

function getVideoObjectKey(cardCode: string) {
  return `gifts/${cardCode}/video/video.mp4`;
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

async function markCardStatus(
  cardCode: string,
  update: Record<string, unknown>,
) {
  const gifts = await getGiftsCollection();
  console.log({
    ts: new Date().toISOString(),
    level: "info",
    event: "video_export.db_status_update",
    cardCode,
    fields: Object.keys(update),
    update,
  });
  await gifts.updateOne({ code: cardCode }, { $set: update });
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
    const { cardCode } = job.data;

    console.log({
      ts: new Date().toISOString(),
      level: "info",
      event: "video_export.job_started",
      jobId: job.id,
      queueName: job.queueName,
      attemptsMade: job.attemptsMade,
      cardCode,
      renderUrl: `${config.appBaseUrl}/card/${encodeURIComponent(cardCode)}?export=1`,
      outputObjectKey: getVideoObjectKey(cardCode),
    });

    await markCardStatus(cardCode, {
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
        cardCode,
        bytes: videoBuffer.byteLength,
        durationSec: utils.seconds(Date.now() - renderStartedAt),
      });

      const uploadStartedAt = Date.now();
      const outputObjectKey = getVideoObjectKey(cardCode);
      await uploadVideoObject({
        objectKey: outputObjectKey,
        body: videoBuffer,
      });

      await markCardStatus(cardCode, {
        videoExportStatus: "completed",
        videoExportFileKey: outputObjectKey,
      });

      console.log({
        ts: new Date().toISOString(),
        level: "info",
        event: "video_export.job_succeeded",
        jobId: job.id,
        cardCode,
        renderDurationSec: utils.seconds(Date.now() - renderStartedAt),
        uploadDurationSec: utils.seconds(Date.now() - uploadStartedAt),
        durationSec: utils.seconds(Date.now() - startedAt),
      });

      return { ok: true };
    } catch (error) {
      await markCardStatus(cardCode, {
        videoExportStatus: "failed",
      });

      console.error({
        ts: new Date().toISOString(),
        level: "error",
        event: "video_export.job_marked_failed",
        jobId: job.id,
        cardCode,
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
        cardCode,
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
  const { cardCode } = job.data;
  console.log({
    ts: new Date().toISOString(),
    level: "info",
    event: "video_export.job_completed",
    jobId: job.id,
    cardCode,
    attemptsMade: job.attemptsMade,
  });
});

worker.on("failed", async (job, error) => {
  const cardCode = job?.data.cardCode;
  console.error({
    ts: new Date().toISOString(),
    level: "error",
    event: "video_export.worker_failed",
    jobId: job?.id,
    cardCode,
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
