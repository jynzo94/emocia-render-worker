function requireEnv(name: string) {
  const value = process.env[name]?.trim()
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`)
  }
  return value
}

export const config = {
  redisUrl: requireEnv('REDIS_URL'),
  databaseUrl: requireEnv('DATABASE_URL'),
  storageBucket: requireEnv('S3_BUCKET'),
  storageRegion: requireEnv('S3_REGION'),
  storageEndpoint: requireEnv('S3_URL'),
  storageAccessKey: requireEnv('S3_ACCESS_KEY'),
  storageSecretKey: requireEnv('S3_SECRET_KEY'),
  videoExportsBaseUrl: requireEnv('VIDEO_EXPORTS_BASE_URL').replace(/\/+$/, ''),
  appBaseUrl: requireEnv('NEXT_PUBLIC_URL').replace(/\/+$/, ''),
  brevoApiKey: requireEnv('BREVO_API_KEY'),
}

export const VIDEO_RENDER_QUEUE_NAME = 'video.render'
export const WORKER_CONCURRENCY = 1
export const JOB_TIMEOUT_MS = 10 * 60 * 1000
