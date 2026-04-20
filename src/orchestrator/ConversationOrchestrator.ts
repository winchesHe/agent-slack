import type { AgentExecutor } from '@/agent/AgentExecutor.ts'
import type { SessionStore } from '@/store/SessionStore.ts'
import type { MemoryStore } from '@/store/MemoryStore.ts'
import type { InboundMessage, EventSink } from '@/im/types.ts'
import type { Logger } from '@/logger/logger.ts'
import type { ToolSet, CoreMessage } from 'ai'
import { emitSyntheticFailed } from './emitSyntheticFailed.ts'

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

      const ctrl = new AbortController()
      // 外层 try/finally 保证 sink.finalize() 在任何路径下都被调用，包括 setup 阶段抛错。
      try {
        const session = await deps.sessionStore.getOrCreate({
          imProvider: input.imProvider,
          channelId: input.channelId,
          channelName: input.channelName,
          threadTs: input.threadTs,
          imUserId: input.userId,
        })
        await deps.sessionStore.setStatus(session.id, 'running')

        const history = await deps.sessionStore.loadMessages(session.id)
        const userMsg: CoreMessage = { role: 'user', content: input.text }
        await deps.sessionStore.appendMessage(session.id, userMsg)

        // 组装 per-handle systemPrompt：若用户 memory 存在则提示路径
        const hasMemory = await deps.memoryStore.exists(currentUser.userName, currentUser.userId)
        const memoryPath = deps.memoryStore.pathFor(currentUser.userName, currentUser.userId)
        const memoryHint = hasMemory
          ? `\n\n[用户长期记忆]\n该用户（${currentUser.userName} / ${currentUser.userId}）的长期记忆在：${memoryPath}\n需要时用 bash cat 读取；要更新时先读旧内容再合并为整体，传给 save_memory（它覆盖写入）。`
          : `\n\n[用户长期记忆]\n目前没有关于该用户（${currentUser.userName} / ${currentUser.userId}）的长期记忆。值得记住的信息用 save_memory 保存。`
        const systemPromptWithMemory = `${deps.systemPrompt}${memoryHint}`
        log.trace(`最终 system prompt 正文：\n${systemPromptWithMemory}`)

        // 每次 handle 新建 tools + executor，闭包安全持有 currentUser
        const tools = deps.toolsBuilder(currentUser)
        const executor = deps.executorFactory(tools)

        try {
          for await (const event of executor.execute({
            systemPrompt: systemPromptWithMemory,
            messages: [...history, userMsg],
            abortSignal: ctrl.signal,
          })) {
            await sink.onEvent(event)

            if (event.type === 'usage-info') {
              // tokens 所有 modelUsage 汇总成一次 accumulateUsage（保证 stepCount 只加一次）；
              // costUSD 单次 accumulateCost，防多模型循环放大。
              const totalInput = event.usage.modelUsage.reduce((s, u) => s + u.inputTokens, 0)
              const totalOutput = event.usage.modelUsage.reduce((s, u) => s + u.outputTokens, 0)
              const totalCached = event.usage.modelUsage.reduce(
                (s, u) => s + u.cachedInputTokens,
                0,
              )
              await deps.sessionStore.accumulateUsage(session.id, {
                inputTokens: totalInput,
                outputTokens: totalOutput,
                cachedInputTokens: totalCached,
              })
              if (event.usage.totalCostUSD > 0) {
                await deps.sessionStore.accumulateCost(session.id, event.usage.totalCostUSD)
              }
            }

            if (event.type === 'lifecycle') {
              if (event.phase === 'completed') {
                for (const m of event.finalMessages ?? []) {
                  await deps.sessionStore.appendMessage(session.id, m)
                }
                await deps.sessionStore.setStatus(session.id, 'idle')
              } else if (event.phase === 'stopped') {
                if (event.finalMessages && event.finalMessages.length > 0) {
                  for (const m of event.finalMessages) {
                    await deps.sessionStore.appendMessage(session.id, m)
                  }
                }
                await deps.sessionStore.appendMessage(session.id, {
                  role: 'assistant',
                  content: '[stopped]',
                })
                await deps.sessionStore.setStatus(session.id, 'stopped')
              } else if (event.phase === 'failed') {
                await deps.sessionStore.appendMessage(session.id, {
                  role: 'assistant',
                  content: `[error: ${event.error?.message ?? 'unknown'}]`,
                })
                await deps.sessionStore.setStatus(session.id, 'error')
              }
            }
          }
        } catch (err) {
          log.error('orchestrator handle 内部异常', err)
          await emitSyntheticFailed(sink, err instanceof Error ? err.message : String(err))
          await deps.sessionStore.appendMessage(session.id, {
            role: 'assistant',
            content: `[error: ${err instanceof Error ? err.message : String(err)}]`,
          })
          await deps.sessionStore.setStatus(session.id, 'error')
        }
      } catch (setupErr) {
        // setup 阶段（getOrCreate/loadMessages 等）抛错时记录，finalize 仍在 finally 执行。
        log.error('orchestrator setup failed', setupErr)
        await emitSyntheticFailed(
          sink,
          setupErr instanceof Error ? setupErr.message : String(setupErr),
        )
      } finally {
        await sink.finalize()
      }
    },
  }
}
