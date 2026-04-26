import { randomUUID } from 'node:crypto'
import type { CoreMessage } from 'ai'
import type { AgentExecutionEvent } from '@/core/events.ts'
import type { Logger } from '@/logger/logger.ts'
import type { Session } from '@/store/SessionStore.ts'
import { formatCompactSummary, type CompactAgent } from '@/agents/compact/index.ts'

export type ManualCompactTrigger = 'mention_command'
export type AutoCompactTrigger = 'budget'
type CompletedFinalMessages = Extract<
  Extract<AgentExecutionEvent, { type: 'lifecycle' }>,
  { phase: 'completed' }
>['finalMessages']

export type ManualCompactResult =
  | {
      status: 'compacted'
      responseText: string
      finalMessages: CompletedFinalMessages
    }
  | {
      status: 'skipped'
      responseText: string
      finalMessages: CompletedFinalMessages
    }

export interface ManualCompactArgs {
  session: Session
  history: CoreMessage[]
  trigger: ManualCompactTrigger
  userId: string
}

export interface AutoCompactArgs {
  session: Session
  messages: CoreMessage[]
  trigger: AutoCompactTrigger
}

export type AutoCompactResult =
  | {
      status: 'compacted'
      finalMessages: CompletedFinalMessages
    }
  | {
      status: 'skipped'
      reason: string
      finalMessages: CompletedFinalMessages
    }

export interface ContextCompactor {
  manualCompact(args: ManualCompactArgs): Promise<ManualCompactResult>
  autoCompact(args: AutoCompactArgs): Promise<AutoCompactResult>
}

export interface ContextCompactorDeps {
  compactAgent: CompactAgent
  logger: Logger
}

function assistantMessage(content: string): CompletedFinalMessages[number] {
  return { id: randomUUID(), role: 'assistant', content }
}

export function createContextCompactor(deps: ContextCompactorDeps): ContextCompactor {
  const log = deps.logger.withTag('context:compact')

  return {
    async manualCompact(args) {
      const compactableMessages = args.history.filter(
        (message) =>
          !(
            message.role === 'assistant' &&
            typeof message.content === 'string' &&
            message.content.startsWith('[compact:')
          ),
      )

      if (compactableMessages.length < 2) {
        const responseText = '当前线程还没有足够的历史上下文可压缩。'
        return {
          status: 'skipped',
          responseText,
          finalMessages: [assistantMessage(responseText)],
        }
      }

      const summary = await deps.compactAgent.summarize({
        messages: compactableMessages,
      })
      const compactMessage = formatCompactSummary({ summary })
      const responseText = compactMessage

      log.info('manual compact completed', {
        historyMessages: args.history.length,
        trigger: args.trigger,
        userId: args.userId,
      })

      return {
        status: 'compacted',
        responseText,
        finalMessages: [assistantMessage(compactMessage)],
      }
    },

    async autoCompact(args) {
      if (args.messages.length < 2) {
        return {
          status: 'skipped',
          reason: 'not_enough_messages',
          finalMessages: [],
        }
      }

      const summary = await deps.compactAgent.summarize({
        messages: args.messages,
      })
      const compactMessage = formatCompactSummary({ mode: 'auto', summary })

      log.info('auto compact completed', {
        historyMessages: args.messages.length,
        trigger: args.trigger,
        sessionId: args.session.id,
      })

      return {
        status: 'compacted',
        finalMessages: [assistantMessage(compactMessage)],
      }
    },
  }
}
