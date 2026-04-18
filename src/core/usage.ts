export interface StepUsage {
  inputTokens: number
  outputTokens: number
  cachedInputTokens?: number
  reasoningTokens?: number
  costUSD?: number
}

export interface TotalUsage {
  model: string
  durationMs: number
  inputTokens: number
  outputTokens: number
  cachedInputTokens: number
  cacheHitRate?: number
  totalCostUSD?: number
}

export function emptyTotalUsage(model: string): TotalUsage {
  return {
    model,
    durationMs: 0,
    inputTokens: 0,
    outputTokens: 0,
    cachedInputTokens: 0,
  }
}
