import { Worker } from 'bullmq'

import { config, VIDEO_RENDER_QUEUE_NAME, WORKER_CONCURRENCY } from './config.js'
import { sendReadyEmail } from './email.js'
import { getGiftsCollection } from './mongo.js'
import { renderVideo } from './render.js'
import { uploadVideoObject } from './storage.js'
import type { RenderVideoJob } from './types.js'

function truncateError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error)
  return message.slice(0, 500)
}

async function markGiftStatus(giftCode: string, update: Record<string, unknown>) {
  const gifts = await getGiftsCollection()
  console.log({
    ts: new Date().toISOString(),
    level: 'info',
    event: 'video_export.db_status_update',
    giftCode,
    fields: Object.keys(update),
  })
  await gifts.updateOne({ code: giftCode }, { $set: update })
}

export const worker = new Worker<RenderVideoJob>(
  VIDEO_RENDER_QUEUE_NAME,
  async (job) => {
    const startedAt = Date.now()

    console.log({
      ts: new Date().toISOString(),
      level: 'info',
      event: 'video_export.job_started',
      jobId: job.id,
      queueName: job.queueName,
      attemptsMade: job.attemptsMade,
      giftCode: job.data.giftCode,
      fingerprint: job.data.fingerprint,
      recipientEmail: job.data.recipientEmail,
    })

    await markGiftStatus(job.data.giftCode, {
      videoExportStatus: 'processing',
      videoExportProcessingAt: new Date(),
      videoExportRequestedEmail: job.data.recipientEmail,
      videoExportError: null,
    })

    try {
      const videoBuffer = await renderVideo(job.data)
      console.log({
        ts: new Date().toISOString(),
        level: 'info',
        event: 'video_export.render_buffer_ready',
        jobId: job.id,
        giftCode: job.data.giftCode,
        bytes: videoBuffer.byteLength,
      })

      const downloadUrl = await uploadVideoObject({
        objectKey: job.data.outputObjectKey,
        body: videoBuffer,
      })

      await markGiftStatus(job.data.giftCode, {
        videoExportStatus: 'completed',
        videoExportCompletedAt: new Date(),
        videoExportFailedAt: null,
        videoExportError: null,
        videoExportFileKey: job.data.outputObjectKey,
        videoExportUrl: downloadUrl,
        videoExportFingerprint: job.data.fingerprint,
      })

      const gifts = await getGiftsCollection()
      const gift = await gifts.findOne(
        { code: job.data.giftCode },
        { projection: { videoExportPendingEmails: 1 } },
      )

      const recipients = Array.from(
        new Set(
          ((gift?.videoExportPendingEmails as string[] | undefined) ?? job.data.pendingEmails ?? [job.data.recipientEmail])
            .map((email) => email.trim().toLowerCase())
            .filter(Boolean),
        ),
      )

      console.log({
        ts: new Date().toISOString(),
        level: 'info',
        event: 'video_export.recipients_resolved',
        jobId: job.id,
        giftCode: job.data.giftCode,
        recipientCount: recipients.length,
        recipients,
      })

      const giftUrl = `${config.appBaseUrl}/gift/${encodeURIComponent(job.data.giftCode)}`

      for (const recipientEmail of recipients) {
        await sendReadyEmail({
          recipientEmail,
          downloadUrl,
          giftUrl,
        })
      }

      await gifts.updateOne(
        { code: job.data.giftCode },
        {
          $set: {
            videoExportPendingEmails: [],
            videoExportRequestedEmail: job.data.recipientEmail,
          },
        },
      )

      console.log({
        ts: new Date().toISOString(),
        level: 'info',
        event: 'video_export.job_succeeded',
        jobId: job.id,
        giftCode: job.data.giftCode,
        downloadUrl,
        durationMs: Date.now() - startedAt,
      })

      return { ok: true, downloadUrl }
    } catch (error) {
      await markGiftStatus(job.data.giftCode, {
        videoExportStatus: 'failed',
        videoExportFailedAt: new Date(),
        videoExportError: truncateError(error),
      })

      console.error({
        ts: new Date().toISOString(),
        level: 'error',
        event: 'video_export.job_failed',
        jobId: job.id,
        giftCode: job.data.giftCode,
        fingerprint: job.data.fingerprint,
        recipientEmail: job.data.recipientEmail,
        durationMs: Date.now() - startedAt,
        error: error instanceof Error ? error.stack ?? error.message : String(error),
      })

      throw error
    }
  },
  {
    connection: { url: config.redisUrl },
    concurrency: WORKER_CONCURRENCY,
  },
)

worker.on('completed', (job) => {
  console.log({
    ts: new Date().toISOString(),
    level: 'info',
    event: 'video_export.job_completed',
    jobId: job.id,
    giftCode: job.data.giftCode,
    attemptsMade: job.attemptsMade,
  })
})

worker.on('failed', (job, error) => {
  console.error({
    ts: new Date().toISOString(),
    level: 'error',
    event: 'video_export.worker_failed',
    jobId: job?.id,
    giftCode: job?.data.giftCode,
    attemptsMade: job?.attemptsMade,
    error: error?.stack ?? error?.message ?? String(error),
  })
})
