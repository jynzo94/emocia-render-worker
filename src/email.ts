import { BrevoClient } from '@getbrevo/brevo'

import { config } from './config.js'

const brevo = new BrevoClient({ apiKey: config.brevoApiKey })

function buildHtml(downloadUrl: string, giftUrl: string) {
  return `
    <div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;padding:24px;">
      <p>Hello,</p>
      <p>Your TikTok-ready Emocia video is ready.</p>
      <p>The exported file is a portrait 9:16 MP4.</p>
      <p><a href="${downloadUrl}" style="display:inline-block;padding:12px 20px;border-radius:999px;background:#111;color:#fff;text-decoration:none;font-weight:700;">Download video</a></p>
      <p>Direct download link:<br /><a href="${downloadUrl}">${downloadUrl}</a></p>
      <p>Original card:<br /><a href="${giftUrl}">${giftUrl}</a></p>
    </div>
  `.trim()
}

function buildText(downloadUrl: string, giftUrl: string) {
  return [
    'Hello,',
    '',
    'Your TikTok-ready Emocia video is ready.',
    'The exported file is a portrait 9:16 MP4.',
    '',
    'Download link:',
    downloadUrl,
    '',
    'Original card:',
    giftUrl,
  ].join('\n')
}

export async function sendReadyEmail(params: {
  recipientEmail: string
  downloadUrl: string
  giftUrl: string
}) {
  console.log({
    ts: new Date().toISOString(),
    level: 'info',
    event: 'video_export.email_sending',
    recipientEmail: params.recipientEmail,
    giftUrl: params.giftUrl,
  })

  await brevo.transactionalEmails.sendTransacEmail({
    sender: {
      name: 'Emocia',
      email: 'admin@emocia.net',
    },
    to: [{ email: params.recipientEmail }],
    subject: 'Your TikTok video is ready',
    htmlContent: buildHtml(params.downloadUrl, params.giftUrl),
    textContent: buildText(params.downloadUrl, params.giftUrl),
  })

  console.log({
    ts: new Date().toISOString(),
    level: 'info',
    event: 'video_export.email_sent',
    recipientEmail: params.recipientEmail,
    giftUrl: params.giftUrl,
  })
}
