import { utils } from "./utils.js";

function requireEnv(name: string) {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

export const config = {
  redisUrl: requireEnv("REDIS_URL"),
  databaseUrl: requireEnv("DATABASE_URL"),
  appBaseUrl: requireEnv("NEXT_PUBLIC_URL").replace(/\/+$/, ""),
  storageBucket: requireEnv("S3_BUCKET"),
  storageRegion: requireEnv("S3_REGION"),
  storageEndpoint: requireEnv("S3_URL"),
  storageAccessKey: requireEnv("S3_ACCESS_KEY"),
  storageSecretKey: requireEnv("S3_SECRET_KEY"),
};

export const VIDEO_RENDER_QUEUE_NAME = "video.render";
export const WORKER_CONCURRENCY = 1;
export const JOB_LOCK_DURATION_MS = utils.minutes(10);
export const JOB_STALLED_INTERVAL_MS = utils.ms(30);
export const VIDEO_EXPORT_WIDTH = 720;
export const VIDEO_EXPORT_HEIGHT = 1280;
export const VIDEO_EXPORT_FPS = 30;
