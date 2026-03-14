# Video Export Logs

This file explains the structured logs emitted by `emocia-render-worker`.

All logs follow the same base shape:

```json
{
  "ts": "2026-03-15T12:00:00.000Z",
  "level": "info",
  "event": "video_export.some_event"
}
```

Common fields:
- `ts`: UTC timestamp
- `level`: `info` or `error`
- `event`: stable event name
- `giftCode`: gift/card code when relevant
- `jobId`: BullMQ job id when relevant
- `durationMs`: elapsed time in milliseconds for the current operation

## Startup

### `video_export.worker_booted`
Worker process started.

Fields:
- `ts`
- `level`
- `event`

### `video_export.worker_boot_config`
Effective runtime config used by the worker.

Fields:
- `queueName`
- `concurrency`
- `jobTimeoutMs`
- `lockDurationMs`
- `width`
- `height`
- `fps`

### `video_export.startup_queue_cleared`
Startup cleanup removed jobs from the Redis queue.

Fields:
- `cleanedWaiting`
- `cleanedActive`
- `cleanedDelayed`
- `cleanedPrioritized`

### `video_export.startup_interrupted_exports_failed`
Mongo gifts stuck in `queued` or `processing` were marked `failed` on worker boot.

Fields:
- `matchedCount`
- `modifiedCount`
- `errorMessage`

## Job Lifecycle

### `video_export.job_started`
A BullMQ job started processing.

Fields:
- `jobId`
- `queueName`
- `attemptsMade`
- `giftCode`
- `fingerprint`
- `renderUrl`
- `outputObjectKey`

### `video_export.db_status_update`
Mongo export fields were updated.

Fields:
- `giftCode`
- `fields`: keys updated
- `update`: full update payload written with `$set`

### `video_export.job_succeeded`
The whole worker job completed successfully.

Fields:
- `jobId`
- `giftCode`
- `downloadUrl`
- `renderDurationMs`: render pipeline only
- `uploadDurationMs`: upload only
- `durationMs`: whole worker job duration

### `video_export.job_completed`
BullMQ `completed` event.

Fields:
- `jobId`
- `giftCode`
- `attemptsMade`

### `video_export.job_failed`
The job failed inside the processor.

Fields:
- `jobId`
- `giftCode`
- `fingerprint`
- `durationMs`
- `error`

### `video_export.worker_failed`
BullMQ worker-level failed event.

Fields:
- `jobId`
- `giftCode`
- `attemptsMade`
- `error`

## Render Pipeline

### `video_export.render_started`
Render pipeline started.

Fields:
- `giftCode`
- `renderUrl`
- `width`
- `height`
- `fps`
- `frameCaptureFormat`
- `frameCaptureQuality`
- `videoEncoder`
- `videoEncoderPreset`
- `tempDir`

### `video_export.viewport_config`
Viewport values passed into Puppeteer before `page.setViewport(...)`.

Fields:
- `giftCode`
- `width`
- `height`
- `fps`

### `video_export.render_navigate_started`
Browser navigation to the render URL started.

Fields:
- `giftCode`
- `renderUrl`

### `video_export.render_navigate_completed`
Browser navigation finished.

Fields:
- `giftCode`
- `durationMs`

### `video_export.render_ready`
The page exposed the render controller and total duration metadata.

Fields:
- `giftCode`
- `durationMs`: animation duration reported by the player
- `progress`
- `estimatedTotalFrames`

### `video_export.frame_capture_started`
Frame-by-frame export started.

Fields:
- `giftCode`
- `totalFrames`
- `durationMs`: animation duration from the player
- `fps`

### `video_export.frame_capture_progress`
Periodic progress during frame capture, emitted every 100 frames and on the last frame.

Fields:
- `giftCode`
- `processedFrames`
- `totalFrames`
- `progressPercent`
- `elapsedMs`
- `estimatedRemainingMs`
- `avgFrameMs`
- `avgSeekMs`
- `avgScreenshotMs`
- `avgPipeWriteMs`

Use this event to identify the bottleneck:
- high `avgSeekMs`: timeline seeking is expensive
- high `avgScreenshotMs`: browser screenshotting is expensive
- high `avgPipeWriteMs`: ffmpeg stdin backpressure is expensive

### `video_export.frame_capture_completed`
All frames were captured and piped into ffmpeg.

Fields:
- `giftCode`
- `totalFrames`
- `streamingTo`
- `durationMs`
- `avgFrameMs`
- `seekDurationMs`
- `screenshotDurationMs`
- `pipeWriteDurationMs`
- `avgSeekMs`
- `avgScreenshotMs`
- `avgPipeWriteMs`

### `video_export.ffmpeg_started`
ffmpeg started finalizing the MP4.

Fields:
- `giftCode`
- `outputPath`
- `mode`
- `frameCaptureFormat`
- `frameCaptureQuality`
- `videoEncoder`
- `videoEncoderPreset`

### `video_export.ffmpeg_completed`
ffmpeg finished and the output file was read back into memory.

Fields:
- `giftCode`
- `outputPath`
- `bytes`
- `durationMs`
- `renderDurationMs`

### `video_export.render_buffer_ready`
The final MP4 buffer is ready in memory and the next step is upload.

Fields:
- `jobId`
- `giftCode`
- `bytes`
- `durationMs`

### `video_export.render_failed`
Render pipeline failed before upload.

Fields:
- `giftCode`
- `error`
- `renderDurationMs`

### `video_export.render_cleanup_completed`
Temporary render files were cleaned up.

Fields:
- `giftCode`
- `tempDir`
- `renderDurationMs`

## Upload

### `video_export.upload_started`
Upload to object storage started.

Fields:
- `objectKey`
- `bytes`
- `bucket`

### `video_export.upload_completed`
Upload finished successfully.

Fields:
- `objectKey`
- `bytes`
- `downloadUrl`
- `durationMs`

## How To Read A Run

For a single export, the most useful events are:
1. `video_export.job_started`
2. `video_export.render_ready`
3. `video_export.frame_capture_progress`
4. `video_export.frame_capture_completed`
5. `video_export.ffmpeg_completed`
6. `video_export.upload_completed`
7. `video_export.job_succeeded`

Most important timing fields:
- total job time: `video_export.job_succeeded.durationMs`
- render-only time: `video_export.job_succeeded.renderDurationMs`
- frame capture bottleneck: `video_export.frame_capture_completed.durationMs`
- upload time: `video_export.upload_completed.durationMs`
