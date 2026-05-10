import { generateText, type LanguageModel } from 'ai'
import type { Logger } from '@/logger/logger.ts'
import { buildCompactPrompt, COMPACT_SYSTEM_PROMPT } from './prompts.ts'
import type { CompactAgent } from './types.ts'

export interface CompactAgentDeps {
  model: LanguageModel
  logger: Logger
}

const DEFAULT_MAX_OUTPUT_TOKENS = 20_000

export function createCompactAgent(deps: CompactAgentDeps): CompactAgent {
  const log = deps.logger.withTag('compact:agent')

  return {
    async summarize(input) {
      const result = await generateText({
        model: deps.model,
        system: COMPACT_SYSTEM_PROMPT,
        prompt: buildCompactPrompt(input),
        maxTokens: input.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
        ...(input.signal ? { abortSignal: input.signal } : {}),
      })

      const summary = result.text.trim()
      log.info('compact summary generated', {
        inputMessages: input.messages.length,
        summaryChars: summary.length,
        promptTokens: result.usage.promptTokens,
        completionTokens: result.usage.completionTokens,
      })
      return {
        summary,
        usage: {
          inputTokens: result.usage.promptTokens ?? 0,
          outputTokens: result.usage.completionTokens ?? 0,
          // generateText 当前不暴露 cache token；Chunk 6 接入真实值。
          cachedInputTokens: 0,
        },
      }
    },
  }
}
