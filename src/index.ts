import { resetInterruptedVideoExportsOnStartup, worker } from "./worker.js";
import {
  JOB_LOCK_DURATION_MS,
  VIDEO_EXPORT_FPS,
  VIDEO_EXPORT_HEIGHT,
  VIDEO_EXPORT_WIDTH,
  VIDEO_RENDER_QUEUE_NAME,
  WORKER_CONCURRENCY,
} from "./config.js";
import { utils } from "./utils.js";

console.log({
  ts: new Date().toISOString(),
  level: "info",
  event: "video_export.worker_booted",
  queueName: VIDEO_RENDER_QUEUE_NAME,
  concurrency: WORKER_CONCURRENCY,
  lockDurationSec: utils.seconds(JOB_LOCK_DURATION_MS),
  width: VIDEO_EXPORT_WIDTH,
  height: VIDEO_EXPORT_HEIGHT,
  fps: VIDEO_EXPORT_FPS,
});

process.on("uncaughtException", async (error) => {
  console.error({
    ts: new Date().toISOString(),
    level: "error",
    event: "video_export.uncaught_exception",
    error:
      error instanceof Error
        ? {
            name: error.name,
            message: error.message,
            stack: error.stack,
          }
        : { message: String(error) },
  });
  await worker.close().catch(() => undefined);
  process.exit(1);
});

process.on("unhandledRejection", async (reason) => {
  console.error({
    ts: new Date().toISOString(),
    level: "error",
    event: "video_export.unhandled_rejection",
    error:
      reason instanceof Error
        ? {
            name: reason.name,
            message: reason.message,
            stack: reason.stack,
          }
        : { message: String(reason) },
  });
  await worker.close().catch(() => undefined);
  process.exit(1);
});

await resetInterruptedVideoExportsOnStartup();
await worker.run();

console.log({
  ts: new Date().toISOString(),
  level: "info",
  event: "video_export.worker_consuming_started",
  queueName: VIDEO_RENDER_QUEUE_NAME,
});

process.on("SIGINT", async () => {
  await worker.close();
  process.exit(0);
});

process.on("SIGTERM", async () => {
  await worker.close();
  process.exit(0);
});
