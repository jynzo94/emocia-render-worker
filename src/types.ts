export type RenderVideoJob = {
  giftCode: string
  renderUrl: string
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
