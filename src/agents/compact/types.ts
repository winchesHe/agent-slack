import type { CoreMessage } from 'ai'

export interface CompactAgentInput {
  messages: CoreMessage[]
  signal?: AbortSignal
  /**
   * 单次 compact 调用允许的最大输出 token 数。默认 20_000，对齐 free-code
   * COMPACT_MAX_OUTPUT_TOKENS。100K 输入大致压到 30K 输出范围内。
   */
  maxOutputTokens?: number
}

export interface CompactAgentUsage {
  inputTokens: number
  outputTokens: number
  cachedInputTokens: number
}

export interface CompactAgentOutput {
  summary: string
  usage: CompactAgentUsage
}

export interface CompactAgent {
  summarize(input: CompactAgentInput): Promise<CompactAgentOutput>
}
