import type { AgentExecutor } from '@/agent/AgentExecutor.ts'
import type { SessionStore, Session } from '@/store/SessionStore.ts'
import type { MemoryStore } from '@/store/MemoryStore.ts'
import type { InboundMessage, EventSink, ConfirmSender } from '@/im/types.ts'
import type { Logger } from '@/logger/logger.ts'
import type { ToolSet, CoreMessage } from 'ai'
import path from 'node:path'
import type { SessionRunQueue } from './SessionRunQueue.ts'
import type { AbortRegistry } from './AbortRegistry.ts'
import { emitSyntheticFailed } from './emitSyntheticFailed.ts'
import {
  DEFAULT_MODEL_MESSAGE_BUDGET,
  buildCompactCandidateMessages,
  buildModelMessages,
  estimateMessagesChars,
  type ModelMessageBudget,
} from './modelMessages.ts'
import type { MentionCommandRouter } from './MentionCommandRouter.ts'
import type { ContextCompactor } from './ContextCompactor.ts'
import type { AutoCompactState } from '@/store/SessionStore.ts'

export interface CurrentUser {
  userName: string
  userId: string
}

/** 当次 handle 的 IM 级透传信息（IM-agnostic） */
export interface IMContext {
  /** 当前会话的确认发送器；无 IM 或 IM 不支持确认按钮时为 undefined。 */
  confirm?: ConfirmSender
}

/** tools 根据当前用户和 IM 上下文动态构造。 */
export type ToolsBuilder = (currentUser: CurrentUser, imContext: IMContext) => ToolSet

/** 给定 tools 返回 executor；executor 状态为 per-handle。 */
export type ExecutorFactory = (tools: ToolSet) => AgentExecutor

export interface ConversationOrchestratorDeps {
  toolsBuilder: ToolsBuilder
  executorFactory: ExecutorFactory
  sessionStore: SessionStore
  memoryStore: MemoryStore
  runQueue: SessionRunQueue
  abortRegistry: AbortRegistry<string>
  systemPrompt: string
  modelMessageBudget?: ModelMessageBudget
  mentionCommandRouter?: MentionCommandRouter
  contextCompactor?: ContextCompactor
  logger: Logger
}

export interface ConversationOrchestrator {
  handle(input: InboundMessage, sink: EventSink): Promise<void>
}

export function createConversationOrchestrator(
  deps: ConversationOrchestratorDeps,
): ConversationOrchestrator {
  const log = deps.logger.withTag('orchestrator')
  const modelMessageBudget = deps.modelMessageBudget ?? DEFAULT_MODEL_MESSAGE_BUDGET

  /** 与 SessionStore 保持一致的 session key 推导规则，用于在首次建档前先进入串行队列。 */
  const sessionKeyFor = (input: InboundMessage): string =>
    `${input.imProvider}:${input.channelId}:${input.threadTs}`

  const autoCompactConfig = modelMessageBudget.autoCompact

  const shouldTriggerAutoCompact = (candidateMessages: CoreMessage[]): boolean => {
    if (!autoCompactConfig?.enabled || candidateMessages.length < 2) {
      return false
    }

    const triggerRatio = Math.min(Math.max(autoCompactConfig.triggerRatio, 0.01), 1)
    const charThreshold = Math.max(1, Math.ceil(modelMessageBudget.maxApproxChars * triggerRatio))
    const messageThreshold = Math.max(
      1,
      Math.ceil(modelMessageBudget.keepRecentMessages * triggerRatio),
    )

    return (
      estimateMessagesChars(candidateMessages) >= charThreshold ||
      candidateMessages.length >= messageThreshold
    )
  }

  const recordAutoCompactFailure = async (
    session: Session,
    previousState: AutoCompactState,
    error: unknown,
  ): Promise<void> => {
    const failureCount = previousState.failureCount + 1
    const maxFailures = autoCompactConfig?.maxFailures ?? 2
    const now = new Date().toISOString()
    const message = error instanceof Error ? error.message : String(error)

    await deps.sessionStore.setAutoCompactState(session.id, {
      ...previousState,
      failureCount,
      breakerOpen: failureCount >= maxFailures,
      lastAttemptAt: now,
      lastFailureAt: now,
      lastFailureMessage: message,
    })
  }

  /**
   * 错误补偿时两个落盘动作都要尝试，避免前一个失败导致 session 永远停在 running。
   */
  const persistErrorState = async (sessionId: string, errorMessage: string): Promise<void> => {
    const results = await Promise.allSettled([
      deps.sessionStore.appendMessage(sessionId, {
        role: 'assistant',
        content: `[error: ${errorMessage}]`,
      }),
      deps.sessionStore.setStatus(sessionId, 'error'),
    ])

    for (const result of results) {
      if (result.status === 'rejected') {
        log.error('orchestrator 错误补偿落盘失败', result.reason)
      }
    }
  }

  /** synthetic failed 只做尽力通知，不能反过来打断错误补偿。 */
  const emitSyntheticFailedBestEffort = async (
    sink: EventSink,
    errorMessage: string,
  ): Promise<void> => {
    try {
      await emitSyntheticFailed(sink, errorMessage)
    } catch (notifyErr) {
      log.error('orchestrator synthetic failed 通知失败', notifyErr)
    }
  }

  return {
    async handle(input, sink) {
      const currentUser: CurrentUser = { userName: input.userName, userId: input.userId }
      const sessionKey = sessionKeyFor(input)
      let finalized = false
      const finalizeSink = async (): Promise<void> => {
        if (finalized) {
          return
        }
        finalized = true
        await sink.finalize()
      }

      // finalize 必须纳入同 session 队列，否则上一轮 usage/ending 可能与下一轮回复交错。
      try {
        await deps.runQueue.enqueue(sessionKey, async () => {
          let session: Session | undefined
          try {
            session = await deps.sessionStore.getOrCreate({
              imProvider: input.imProvider,
              channelId: input.channelId,
              channelName: input.channelName,
              threadTs: input.threadTs,
              imUserId: input.userId,
            })
            await deps.sessionStore.setStatus(session.id, 'running')

            const history = await deps.sessionStore.loadMessages(session.id)
            const userMsg: CoreMessage = { role: 'user', content: input.text }
            const mentionCommand = deps.mentionCommandRouter?.match(input.text)
            if (mentionCommand && deps.mentionCommandRouter) {
              await deps.sessionStore.appendMessage(session.id, userMsg)
              const commandResult = await deps.mentionCommandRouter.execute({
                command: mentionCommand,
                input,
                session,
                history,
              })
              await sink.onEvent({ type: 'assistant-message', text: commandResult.responseText })
              for (const message of commandResult.finalMessages) {
                await deps.sessionStore.appendMessage(session.id, message)
              }
              await sink.onEvent({
                type: 'lifecycle',
                phase: 'completed',
                finalMessages: commandResult.finalMessages,
              })
              await deps.sessionStore.setStatus(session.id, 'idle')
              return
            }

            await deps.sessionStore.appendMessage(session.id, userMsg)

            let modelHistory = history
            if (deps.contextCompactor && autoCompactConfig?.enabled) {
              const autoCompactState = await deps.sessionStore.getAutoCompactState(session.id)
              const candidateMessages = buildCompactCandidateMessages({
                history,
                userMessage: userMsg,
              })

              if (!autoCompactState.breakerOpen && shouldTriggerAutoCompact(candidateMessages)) {
                let autoCompactActivitySent = false
                await sink.onEvent({
                  type: 'activity-state',
                  state: {
                    status: '正在整理上下文…',
                    activities: ['自动压缩历史上下文，完成后继续处理本轮请求'],
                  },
                })
                autoCompactActivitySent = true

                try {
                  await deps.sessionStore.setAutoCompactState(session.id, {
                    ...autoCompactState,
                    lastAttemptAt: new Date().toISOString(),
                  })
                  const compactResult = await deps.contextCompactor.autoCompact({
                    session,
                    messages: candidateMessages,
                    trigger: 'budget',
                  })

                  if (compactResult.status === 'compacted') {
                    for (const message of compactResult.finalMessages) {
                      await deps.sessionStore.appendMessage(session.id, message)
                    }
                    await deps.sessionStore.setAutoCompactState(session.id, {
                      failureCount: 0,
                      breakerOpen: false,
                      lastAttemptAt: new Date().toISOString(),
                      lastSuccessAt: new Date().toISOString(),
                    })
                    modelHistory = await deps.sessionStore.loadMessages(session.id)
                  }
                } catch (error) {
                  log.warn('auto compact 失败，回退到模型视图裁剪', error)
                  await recordAutoCompactFailure(session, autoCompactState, error)
                } finally {
                  if (autoCompactActivitySent) {
                    await sink.onEvent({ type: 'activity-state', state: { clear: true } })
                  }
                }
              }
            }

            const modelMessages = buildModelMessages({
              history: modelHistory,
              userMessage: userMsg,
              budget: modelMessageBudget,
              messagesJsonlPath: path.join(session.dir, 'messages.jsonl'),
            })

            // 组装 per-handle systemPrompt：若用户 memory 存在则提示路径
            const hasMemory = await deps.memoryStore.exists(
              currentUser.userName,
              currentUser.userId,
            )
            const memoryPath = deps.memoryStore.pathFor(currentUser.userName, currentUser.userId)
            const memoryHint = hasMemory
              ? `\n\n[用户长期记忆]\n该用户（${currentUser.userName} / ${currentUser.userId}）的长期记忆在：${memoryPath}\n需要时用 bash cat 读取；要更新时先读旧内容再合并为整体，传给 save_memory（它覆盖写入）。`
              : `\n\n[用户长期记忆]\n目前没有关于该用户（${currentUser.userName} / ${currentUser.userId}）的长期记忆。值得记住的信息用 save_memory 保存。`
            const systemPromptWithMemory = `${deps.systemPrompt}${memoryHint}`
            log.trace(`最终 system prompt 正文：\n${systemPromptWithMemory}`)

            // 每次 handle 新建 tools + executor，闭包安全持有 currentUser
            const imContext: IMContext = {
              ...(input.confirmSender ? { confirm: input.confirmSender } : {}),
            }
            const tools = deps.toolsBuilder(currentUser, imContext)
            const executor = deps.executorFactory(tools)
            const ctrl = deps.abortRegistry.create(input.messageTs)

            try {
              for await (const event of executor.execute({
                systemPrompt: systemPromptWithMemory,
                messages: modelMessages,
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
                    if (event.reason === 'max_steps' && event.summary) {
                      await deps.sessionStore.appendMessage(session.id, {
                        role: 'assistant',
                        content: event.summary,
                      })
                    }
                    await deps.sessionStore.appendMessage(session.id, {
                      role: 'assistant',
                      content: event.reason === 'max_steps' ? '[stopped: max_steps]' : '[stopped]',
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
            } finally {
              deps.abortRegistry.delete(input.messageTs)
            }
          } catch (err) {
            if (!session) {
              log.error('orchestrator setup failed', err)
              await emitSyntheticFailedBestEffort(
                sink,
                err instanceof Error ? err.message : String(err),
              )
              return
            }
            log.error('orchestrator runner 异常', err)
            const errorMessage = err instanceof Error ? err.message : String(err)
            await persistErrorState(session.id, errorMessage)
            await emitSyntheticFailedBestEffort(sink, errorMessage)
          } finally {
            await finalizeSink()
          }
        })
      } catch (setupErr) {
        // enqueue 自身异常时只做 best-effort 通知，finalize 仍在 finally 执行。
        log.error('orchestrator setup failed', setupErr)
        await emitSyntheticFailedBestEffort(
          sink,
          setupErr instanceof Error ? setupErr.message : String(setupErr),
        )
      } finally {
        await finalizeSink()
      }
    },
  }
}
