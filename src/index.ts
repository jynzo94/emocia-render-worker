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

await resetInterruptedVideoExportsOnStartup();

process.on("SIGINT", async () => {
  await worker.close();
  process.exit(0);
});

process.on("SIGTERM", async () => {
  await worker.close();
  process.exit(0);
});
