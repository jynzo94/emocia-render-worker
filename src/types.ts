export type RenderVideoJob = {
  giftCode: string
}

type RenderStatus = 'idle' | 'ready' | 'started' | 'finished'

export type RenderStateSnapshot = {
  status: RenderStatus
  durationMs: number
  progress: number
  error?: string
}
