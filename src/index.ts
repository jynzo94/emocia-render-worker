import { worker } from './worker.js'

console.log({ event: 'video_export.worker_booted' })

process.on('SIGINT', async () => {
  await worker.close()
  process.exit(0)
})

process.on('SIGTERM', async () => {
  await worker.close()
  process.exit(0)
})
