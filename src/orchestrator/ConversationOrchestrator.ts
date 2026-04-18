import type { AgentExecutor } from '@/agent/AgentExecutor.ts'
import type { SessionStore } from '@/store/SessionStore.ts'
import type { MemoryStore } from '@/store/MemoryStore.ts'
import type { InboundMessage, EventSink } from '@/im/types.ts'
import type { Logger } from '@/logger/logger.ts'
import type { ToolSet } from 'ai'

export interface CurrentUser {
  userName: string
  userId: string
}

/** tools 根据当前用户动态构造。 */
export type ToolsBuilder = (currentUser: CurrentUser) => ToolSet

/** 给定 tools 返回 executor；executor 状态为 per-handle。 */
export type ExecutorFactory = (tools: ToolSet) => AgentExecutor

export interface ConversationOrchestratorDeps {
  toolsBuilder: ToolsBuilder
  executorFactory: ExecutorFactory
  sessionStore: SessionStore
  memoryStore: MemoryStore
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
      const currentUser: CurrentUser = { userName: input.userName, userId: input.userId }

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

      // 组装 per-handle systemPrompt：若用户 memory 存在则提示路径
      const hasMemory = await deps.memoryStore.exists(currentUser.userName, currentUser.userId)
      const memoryPath = deps.memoryStore.pathFor(currentUser.userName, currentUser.userId)
      const memoryHint = hasMemory
        ? `\n\n[用户长期记忆]\n该用户（${currentUser.userName} / ${currentUser.userId}）的长期记忆在：${memoryPath}\n需要时用 bash cat 读取；要更新时先读旧内容再合并为整体，传给 save_memory（它覆盖写入）。`
        : `\n\n[用户长期记忆]\n目前没有关于该用户（${currentUser.userName} / ${currentUser.userId}）的长期记忆。值得记住的信息用 save_memory 保存。`
      const systemPromptWithMemory = `${deps.systemPrompt}${memoryHint}`

      // 每次 handle 新建 tools + executor，闭包安全持有 currentUser
      const tools = deps.toolsBuilder(currentUser)
      const executor = deps.executorFactory(tools)

      const ctrl = new AbortController()
      let finalText = ''
      try {
        for await (const event of executor.execute({
          systemPrompt: systemPromptWithMemory,
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
