# emocia-render-worker

BullMQ worker that renders paid Emocia cards into silent 9:16 MP4 files for TikTok delivery.

## Development

```bash
bun install
bun run src/index.ts
```

## Production build

```bash
npm run build
npm run start
```

## Required environment variables

- `REDIS_URL`
- `DATABASE_URL`
- `S3_BUCKET`
- `S3_REGION`
- `S3_URL`
- `S3_ACCESS_KEY`
- `S3_SECRET_KEY`
- `VIDEO_EXPORTS_BASE_URL`

## Behavior

- Consumes the `video.render` queue
- Runs with single-job concurrency
- Uses Puppeteer + ffmpeg to render a silent portrait 9:16 MP4
- Uploads the MP4 to object storage and stores the download URL on the gift
# emocia-render-worker
