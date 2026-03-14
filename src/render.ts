import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import puppeteer from 'puppeteer'

import type { RenderStateSnapshot, RenderVideoJob } from './types.js'

type RenderWindow = Window & {
  __EMOCIA_RENDER_STATE__?: RenderStateSnapshot
  __EMOCIA_RENDER_CONTROLLER__?: {
    start: () => Promise<void>
    seekToMs: (ms: number) => Promise<RenderStateSnapshot | undefined>
  }
}

async function waitForRenderReady(page: puppeteer.Page) {
  await page.waitForFunction(
    () => {
      const renderWindow = window as RenderWindow
      const state = renderWindow.__EMOCIA_RENDER_STATE__
      return (
        Boolean(renderWindow.__EMOCIA_RENDER_CONTROLLER__) &&
        Boolean(state) &&
        Number(state?.durationMs ?? 0) > 0
      )
    },
    { timeout: 60_000 },
  )

  return page.evaluate(() => (window as RenderWindow).__EMOCIA_RENDER_STATE__ as RenderStateSnapshot)
}

async function seekToMs(page: puppeteer.Page, ms: number) {
  return page.evaluate(async (value) => {
    const controller = (window as RenderWindow).__EMOCIA_RENDER_CONTROLLER__
    if (!controller) {
      throw new Error('Render controller missing')
    }

    return controller.seekToMs(value)
  }, ms)
}

async function writeFrameToFfmpeg(ffmpegStdin: NodeJS.WritableStream, frame: Uint8Array) {
  await new Promise<void>((resolve, reject) => {
    ffmpegStdin.write(frame, (error) => {
      if (error) {
        reject(error)
        return
      }

      resolve()
    })
  })
}

async function finalizeFfmpeg(params: {
  ffmpeg: ReturnType<typeof spawn>
  stderrChunks: string[]
}) {
  const stdin = params.ffmpeg.stdin
  if (!stdin) {
    throw new Error('ffmpeg stdin unavailable')
  }

  if (!stdin.destroyed) {
    stdin.end()
  }

  await new Promise<void>((resolve, reject) => {
    params.ffmpeg.once('close', (code) => {
      if (code === 0) {
        resolve()
        return
      }

      reject(
        new Error(
          `ffmpeg exited with code ${code}. ${params.stderrChunks.join('').trim()}`.trim(),
        ),
      )
    })
    params.ffmpeg.once('error', reject)
  })
}

export async function renderVideo(job: RenderVideoJob) {
  const tempDir = await mkdtemp(path.join(tmpdir(), `emocia-render-${job.giftCode}-`))
  const outputPath = path.join(tempDir, 'output.mp4')
  const startedAt = Date.now()

  console.log({
    ts: new Date().toISOString(),
    level: 'info',
    event: 'video_export.render_started',
    giftCode: job.giftCode,
    renderUrl: job.renderUrl,
    width: job.width,
    height: job.height,
    fps: job.fps,
    tempDir,
  })

  const browser = await getBrowser()

  let page: puppeteer.Page | null = null
  try {
    page = await browser.newPage()
    await page.setViewport({
      width: job.width,
      height: job.height,
      deviceScaleFactor: 1,
    })

    const navigationStartedAt = Date.now()
    console.log({
      ts: new Date().toISOString(),
      level: 'info',
      event: 'video_export.render_navigate_started',
      giftCode: job.giftCode,
      renderUrl: job.renderUrl,
    })
    await page.goto(job.renderUrl, { waitUntil: 'networkidle2', timeout: 60_000 })
    console.log({
      ts: new Date().toISOString(),
      level: 'info',
      event: 'video_export.render_navigate_completed',
      giftCode: job.giftCode,
      durationMs: Date.now() - navigationStartedAt,
    })

    const ready = await waitForRenderReady(page)
    if (!ready?.durationMs) {
      throw new Error('Render duration missing')
    }

    console.log({
      ts: new Date().toISOString(),
      level: 'info',
      event: 'video_export.render_ready',
      giftCode: job.giftCode,
      durationMs: ready.durationMs,
      progress: ready.progress,
    })

    await page.evaluate(async () => {
      const controller = (window as RenderWindow).__EMOCIA_RENDER_CONTROLLER__
      if (!controller) {
        throw new Error('Render controller missing')
      }
      await controller.start()
    })

    const totalFrames = Math.max(1, Math.ceil((ready.durationMs / 1000) * job.fps) + 1)
    const ffmpegArgs = [
      "-y",
      "-f",
      "image2pipe",
      "-framerate",
      String(job.fps),
      "-vcodec",
      "mjpeg",
      "-i",
      "pipe:0",
      "-c:v",
      "libx264",
      "-preset",
      "veryfast",
      "-pix_fmt",
      "yuv420p",
      outputPath,
    ]
    const ffmpeg = spawn('ffmpeg', ffmpegArgs, {
      stdio: ['pipe', 'ignore', 'pipe'],
    })
    const stderrChunks: string[] = []

    ffmpeg.stderr?.on('data', (chunk) => {
      stderrChunks.push(String(chunk))
    })

    console.log({
      ts: new Date().toISOString(),
      level: 'info',
      event: 'video_export.frame_capture_started',
      giftCode: job.giftCode,
      totalFrames,
      durationMs: ready.durationMs,
      fps: job.fps,
    })

    const frameCaptureStartedAt = Date.now()
    for (let frameIndex = 0; frameIndex < totalFrames; frameIndex += 1) {
      const elapsedMs = Math.min(ready.durationMs, Math.round((frameIndex / job.fps) * 1000))
      await seekToMs(page, elapsedMs)
      const frame = await page.screenshot({
        type: 'jpeg',
        quality: 80,
      })
      await writeFrameToFfmpeg(ffmpeg.stdin, frame)
    }

    console.log({
      ts: new Date().toISOString(),
      level: 'info',
      event: 'video_export.frame_capture_completed',
      giftCode: job.giftCode,
      totalFrames,
      streamingTo: 'ffmpeg.stdin',
      durationMs: Date.now() - frameCaptureStartedAt,
    })

    const ffmpegStartedAt = Date.now()
    console.log({
      ts: new Date().toISOString(),
      level: 'info',
      event: 'video_export.ffmpeg_started',
      giftCode: job.giftCode,
      outputPath,
      mode: 'image2pipe',
    })
    await finalizeFfmpeg({ ffmpeg, stderrChunks })

    const outputBuffer = await readFile(outputPath)
    console.log({
      ts: new Date().toISOString(),
      level: 'info',
      event: 'video_export.ffmpeg_completed',
      giftCode: job.giftCode,
      outputPath,
      bytes: outputBuffer.byteLength,
      durationMs: Date.now() - ffmpegStartedAt,
      renderDurationMs: Date.now() - startedAt,
    })

    return outputBuffer
  } catch (error) {
    console.error({
      ts: new Date().toISOString(),
      level: 'error',
      event: 'video_export.render_failed',
      giftCode: job.giftCode,
      error: error instanceof Error ? error.message : String(error),
      renderDurationMs: Date.now() - startedAt,
    })
    throw error
  } finally {
    await page?.close().catch(() => undefined)
    await rm(tempDir, { recursive: true, force: true })
    console.log({
      ts: new Date().toISOString(),
      level: 'info',
      event: 'video_export.render_cleanup_completed',
      giftCode: job.giftCode,
      tempDir,
      renderDurationMs: Date.now() - startedAt,
    })
  }
}
let browserPromise: Promise<puppeteer.Browser> | null = null

async function getBrowser() {
  if (browserPromise) {
    const browser = await browserPromise
    if (browser.isConnected()) {
      return browser
    }
  }

  browserPromise = puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--autoplay-policy=no-user-gesture-required'],
  })

  const browser = await browserPromise
  browser.on('disconnected', () => {
    browserPromise = null
  })

  return browser
}
