import type { AgentExecutor } from '@/agent/AgentExecutor.ts'
import type { SessionStore } from '@/store/SessionStore.ts'
import type { InboundMessage, EventSink } from '@/im/types.ts'
import type { Logger } from '@/logger/logger.ts'

export interface ConversationOrchestratorDeps {
  executor: AgentExecutor
  sessionStore: SessionStore
  systemPrompt: string
  logger: Logger
}

export interface ConversationOrchestrator {
  handle(input: InboundMessage, sink: EventSink): Promise<void>
}

export function createConversationOrchestrator(
  deps: ConversationOrchestratorDeps,
): ConversationOrchestrator {
  const log = deps.logger.withTag('orchestrator')
  return {
    async handle(input, sink) {
      const session = await deps.sessionStore.getOrCreate({
        imProvider: input.imProvider,
        channelId: input.channelId,
        channelName: input.channelName,
        threadTs: input.threadTs,
        imUserId: input.userId,
      })
      await deps.sessionStore.setStatus(session.id, 'running')

      const history = await deps.sessionStore.loadMessages(session.id)
      const userMsg = { role: 'user' as const, content: input.text }
      await deps.sessionStore.appendMessage(session.id, userMsg)

      const ctrl = new AbortController()
      let finalText = ''
      try {
        for await (const event of deps.executor.execute({
          systemPrompt: deps.systemPrompt,
          messages: [...history, userMsg],
          abortSignal: ctrl.signal,
        })) {
          sink.emit(event)
          if (event.type === 'step_finish' && event.usage) {
            await deps.sessionStore.accumulateUsage(session.id, event.usage)
          }
          if (event.type === 'done') {
            finalText = event.finalText
            await deps.sessionStore.appendMessage(session.id, {
              role: 'assistant',
              content: finalText,
            })
          }
          if (event.type === 'error') throw event.error
        }
        await deps.sessionStore.setStatus(session.id, 'idle')
        await sink.done()
      } catch (err) {
        log.error('handle failed', err)
        await deps.sessionStore.setStatus(session.id, 'error')
        await sink.fail(err instanceof Error ? err : new Error(String(err)))
      }
    },
  }
}
