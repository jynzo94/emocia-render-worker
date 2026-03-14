export type RenderVideoJob = {
  giftCode: string
  renderUrl: string
  fps: number
  width: number
  height: number
  fingerprint: string
  outputObjectKey: string
}

type RenderStatus = 'idle' | 'ready' | 'started' | 'finished'

export type RenderStateSnapshot = {
  status: RenderStatus
  durationMs: number
  progress: number
  error?: string
}
