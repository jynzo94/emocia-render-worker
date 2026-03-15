import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import puppeteer from "puppeteer";

import {
  config,
  VIDEO_EXPORT_FPS,
  VIDEO_EXPORT_HEIGHT,
  VIDEO_EXPORT_WIDTH,
} from "./config.js";
import type { RenderStateSnapshot, RenderVideoJob } from "./types.js";
import { utils } from "./utils.js";

type RenderWindow = Window & {
  __EMOCIA_RENDER_STATE__?: RenderStateSnapshot;
  __EMOCIA_RENDER_CONTROLLER__?: {
    start: () => Promise<void>;
    seekToMs: (ms: number) => Promise<RenderStateSnapshot | undefined>;
  };
};

function getRenderUrl(giftCode: string) {
  return `${config.appBaseUrl}/gift/${encodeURIComponent(giftCode)}?export=1`;
}

function getViewportConfig() {
  const width = Math.trunc(Number(VIDEO_EXPORT_WIDTH));
  const height = Math.trunc(Number(VIDEO_EXPORT_HEIGHT));

  if (!Number.isFinite(width) || width <= 0) {
    throw new Error(
      `Invalid VIDEO_EXPORT_WIDTH: ${String(VIDEO_EXPORT_WIDTH)}`,
    );
  }

  if (!Number.isFinite(height) || height <= 0) {
    throw new Error(
      `Invalid VIDEO_EXPORT_HEIGHT: ${String(VIDEO_EXPORT_HEIGHT)}`,
    );
  }

  return {
    width,
    height,
    deviceScaleFactor: 1 as const,
  };
}

async function waitForRenderReady(page: puppeteer.Page) {
  await page.waitForFunction(
    () => {
      const renderWindow = window as RenderWindow;
      const state = renderWindow.__EMOCIA_RENDER_STATE__;
      return (
        Boolean(renderWindow.__EMOCIA_RENDER_CONTROLLER__) &&
        Boolean(state) &&
        Number(state?.durationMs ?? 0) > 0
      );
    },
    { timeout: 60_000 },
  );

  return page.evaluate(
    () =>
      (window as RenderWindow).__EMOCIA_RENDER_STATE__ as RenderStateSnapshot,
  );
}

async function seekToMs(page: puppeteer.Page, ms: number) {
  return page.evaluate(async (value) => {
    const controller = (window as RenderWindow).__EMOCIA_RENDER_CONTROLLER__;
    if (!controller) {
      throw new Error("Render controller missing");
    }

    return controller.seekToMs(value);
  }, ms);
}

async function writeFrameToFfmpeg(
  ffmpegStdin: NodeJS.WritableStream,
  frame: Uint8Array,
) {
  await new Promise<void>((resolve, reject) => {
    ffmpegStdin.write(frame, (error) => {
      if (error) {
        reject(error);
        return;
      }

      resolve();
    });
  });
}

async function finalizeFfmpeg(params: {
  ffmpeg: ReturnType<typeof spawn>;
  stderrChunks: string[];
}) {
  const stdin = params.ffmpeg.stdin;
  if (!stdin) {
    throw new Error("ffmpeg stdin unavailable");
  }

  if (!stdin.destroyed) {
    stdin.end();
  }

  await new Promise<void>((resolve, reject) => {
    params.ffmpeg.once("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }

      reject(
        new Error(
          `ffmpeg exited with code ${code}. ${params.stderrChunks.join("").trim()}`.trim(),
        ),
      );
    });
    params.ffmpeg.once("error", reject);
  });
}

export async function renderVideo(
  job: RenderVideoJob,
  onProgress?: (progress: number) => Promise<void> | void,
) {
  const tempDir = await mkdtemp(
    path.join(tmpdir(), `emocia-render-${job.giftCode}-`),
  );
  const outputPath = path.join(tempDir, "output.mp4");
  const startedAt = Date.now();
  const viewport = getViewportConfig();

  console.log({
    ts: new Date().toISOString(),
    level: "info",
    event: "video_export.render_started",
    giftCode: job.giftCode,
    renderUrl: getRenderUrl(job.giftCode),
    width: viewport.width,
    height: viewport.height,
    fps: VIDEO_EXPORT_FPS,
    tempDir,
  });

  const browser = await getBrowser();

  let page: puppeteer.Page | null = null;
  try {
    page = await browser.newPage();
    console.log({
      ts: new Date().toISOString(),
      level: "info",
      event: "video_export.viewport_config",
      giftCode: job.giftCode,
      width: viewport.width,
      height: viewport.height,
      fps: VIDEO_EXPORT_FPS,
    });

    await onProgress?.(0);
    try {
      await page.setViewport(viewport);
    } catch (error) {
      console.error({
        ts: new Date().toISOString(),
        level: "error",
        event: "video_export.viewport_config_failed",
        giftCode: job.giftCode,
        viewport,
        rawWidth: VIDEO_EXPORT_WIDTH,
        rawHeight: VIDEO_EXPORT_HEIGHT,
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

    const navigationStartedAt = Date.now();
    console.log({
      ts: new Date().toISOString(),
      level: "info",
      event: "video_export.render_navigate_started",
      giftCode: job.giftCode,
      renderUrl: getRenderUrl(job.giftCode),
    });
    await page.goto(getRenderUrl(job.giftCode), {
      waitUntil: "domcontentloaded",
      timeout: 60_000,
    });
    console.log({
      ts: new Date().toISOString(),
      level: "info",
      event: "video_export.render_navigate_completed",
      giftCode: job.giftCode,
      durationSec: utils.seconds(Date.now() - navigationStartedAt),
    });

    const ready = await waitForRenderReady(page);
    if (!ready?.durationMs) {
      throw new Error("Render duration missing");
    }

    console.log({
      ts: new Date().toISOString(),
      level: "info",
      event: "video_export.render_ready",
      giftCode: job.giftCode,
      durationSec: utils.seconds(ready.durationMs),
      progress: ready.progress,
      estimatedTotalFrames: Math.max(
        1,
        Math.ceil((ready.durationMs * VIDEO_EXPORT_FPS) / 1000),
      ),
    });

    await page.evaluate(async () => {
      const controller = (window as RenderWindow).__EMOCIA_RENDER_CONTROLLER__;
      if (!controller) {
        throw new Error("Render controller missing");
      }
      await controller.start();
    });

    const totalFrames = Math.max(
      1,
      Math.ceil((ready.durationMs * VIDEO_EXPORT_FPS) / 1000),
    );
    const ffmpegArgs = [
      "-y",
      "-f",
      "image2pipe",
      "-framerate",
      String(VIDEO_EXPORT_FPS),
      "-vcodec",
      "mjpeg",
      "-i",
      "pipe:0",
      "-c:v",
      "libx264",
      "-preset",
      "superfast",
      "-pix_fmt",
      "yuv420p",
      outputPath,
    ];
    const ffmpeg = spawn("ffmpeg", ffmpegArgs, {
      stdio: ["pipe", "ignore", "pipe"],
    });
    const stderrChunks: string[] = [];

    ffmpeg.stderr?.on("data", (chunk) => {
      stderrChunks.push(String(chunk));
    });

    console.log({
      ts: new Date().toISOString(),
      level: "info",
      event: "video_export.frame_capture_started",
      giftCode: job.giftCode,
      totalFrames,
      durationSec: utils.seconds(ready.durationMs),
      fps: VIDEO_EXPORT_FPS,
    });

    const frameCaptureStartedAt = Date.now();
    let totalSeekDurationMs = 0;
    let totalScreenshotDurationMs = 0;
    let totalPipeWriteDurationMs = 0;

    for (let frameIndex = 0; frameIndex < totalFrames; frameIndex += 1) {
      const elapsedMs = Math.min(
        ready.durationMs,
        Math.round((frameIndex / VIDEO_EXPORT_FPS) * 1000),
      );

      const seekStartedAt = Date.now();
      await seekToMs(page, elapsedMs);
      totalSeekDurationMs += Date.now() - seekStartedAt;

      const screenshotStartedAt = Date.now();
      const frame = await page.screenshot({
        type: "jpeg",
        quality: 80,
      });
      totalScreenshotDurationMs += Date.now() - screenshotStartedAt;

      const pipeWriteStartedAt = Date.now();
      await writeFrameToFfmpeg(ffmpeg.stdin, frame);
      totalPipeWriteDurationMs += Date.now() - pipeWriteStartedAt;

      await onProgress?.(
        Math.max(1, Math.min(99, Math.round(((frameIndex + 1) / totalFrames) * 100))),
      );

      if ((frameIndex + 1) % 100 === 0 || frameIndex === totalFrames - 1) {
        const processedFrames = frameIndex + 1;
        const elapsedCaptureMs = Date.now() - frameCaptureStartedAt;

        console.log({
          ts: new Date().toISOString(),
          level: "info",
          event: "video_export.frame_capture_progress",
          giftCode: job.giftCode,
          processedFrames,
          totalFrames,
          progressPercent: Math.round((processedFrames / totalFrames) * 100),
          elapsedSec: utils.seconds(elapsedCaptureMs),
          estimatedRemainingSec: utils.seconds(
            Math.max(
              0,
              Math.round((elapsedCaptureMs / processedFrames) * (totalFrames - processedFrames)),
            ),
          ),
          avgFrameSec: utils.seconds(elapsedCaptureMs / processedFrames),
          avgSeekSec: utils.seconds(totalSeekDurationMs / processedFrames),
          avgScreenshotSec: utils.seconds(totalScreenshotDurationMs / processedFrames),
          avgPipeWriteSec: utils.seconds(totalPipeWriteDurationMs / processedFrames),
        });
      }
    }

    const frameCaptureDurationMs = Date.now() - frameCaptureStartedAt;
    console.log({
      ts: new Date().toISOString(),
      level: "info",
      event: "video_export.frame_capture_completed",
      giftCode: job.giftCode,
      totalFrames,
      streamingTo: "ffmpeg.stdin",
      durationSec: utils.seconds(frameCaptureDurationMs),
      avgFrameSec: utils.seconds(frameCaptureDurationMs / totalFrames),
      seekDurationSec: utils.seconds(totalSeekDurationMs),
      screenshotDurationSec: utils.seconds(totalScreenshotDurationMs),
      pipeWriteDurationSec: utils.seconds(totalPipeWriteDurationMs),
      avgSeekSec: utils.seconds(totalSeekDurationMs / totalFrames),
      avgScreenshotSec: utils.seconds(totalScreenshotDurationMs / totalFrames),
      avgPipeWriteSec: utils.seconds(totalPipeWriteDurationMs / totalFrames),
    });

    const ffmpegStartedAt = Date.now();
    console.log({
      ts: new Date().toISOString(),
      level: "info",
      event: "video_export.ffmpeg_started",
      giftCode: job.giftCode,
      outputPath,
      mode: "image2pipe",
    });
    await finalizeFfmpeg({ ffmpeg, stderrChunks });

    const outputBuffer = await readFile(outputPath);
    await onProgress?.(100);
    console.log({
      ts: new Date().toISOString(),
      level: "info",
      event: "video_export.ffmpeg_completed",
      giftCode: job.giftCode,
      outputPath,
      bytes: outputBuffer.byteLength,
      durationSec: utils.seconds(Date.now() - ffmpegStartedAt),
      renderDurationSec: utils.seconds(Date.now() - startedAt),
    });

    return outputBuffer;
  } catch (error) {
    console.error({
      ts: new Date().toISOString(),
      level: "error",
      event: "video_export.render_failed",
      giftCode: job.giftCode,
      renderDurationSec: utils.seconds(Date.now() - startedAt),
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
  } finally {
    await page?.close().catch(() => undefined);
    await rm(tempDir, { recursive: true, force: true });
    console.log({
      ts: new Date().toISOString(),
      level: "info",
      event: "video_export.render_cleanup_completed",
      giftCode: job.giftCode,
      tempDir,
      renderDurationSec: utils.seconds(Date.now() - startedAt),
    });
  }
}
let browserPromise: Promise<puppeteer.Browser> | null = null;

async function getBrowser() {
  if (browserPromise) {
    const browser = await browserPromise;
    if (browser.isConnected()) {
      return browser;
    }
  }

  browserPromise = puppeteer.launch({
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--autoplay-policy=no-user-gesture-required",
    ],
  });

  const browser = await browserPromise;
  browser.on("disconnected", () => {
    browserPromise = null;
  });

  return browser;
}
