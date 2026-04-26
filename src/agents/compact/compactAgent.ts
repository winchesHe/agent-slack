import { generateText, type LanguageModel } from 'ai'
import type { Logger } from '@/logger/logger.ts'
import { buildCompactPrompt, COMPACT_SYSTEM_PROMPT } from './prompts.ts'
import type { CompactAgent } from './types.ts'

export interface CompactAgentDeps {
  model: LanguageModel
  logger: Logger
}

export function createCompactAgent(deps: CompactAgentDeps): CompactAgent {
  const log = deps.logger.withTag('compact:agent')

  return {
    async summarize(input) {
      const result = await generateText({
        model: deps.model,
        system: COMPACT_SYSTEM_PROMPT,
        prompt: buildCompactPrompt(input),
      })

      const summary = result.text.trim()
      log.info('compact summary generated', {
        inputMessages: input.messages.length,
        summaryChars: summary.length,
      })
      return summary
    },
  }
}
