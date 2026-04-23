import type { Logger } from '@/logger/logger.ts'
import type { ConfirmDecision } from '@/im/types.ts'

// 超时错误：携带已收集的 partial decisions，交由 tool 层决定如何回退
export class ConfirmTimeoutError extends Error {
  constructor(
    public readonly threadTs: string,
    public readonly toolCallId: string,
    public readonly partialDecisions: Map<string, ConfirmDecision>,
  ) {
    super(`ConfirmBridge: thread ${threadTs} 等待超时`)
    this.name = 'ConfirmTimeoutError'
  }
}

// 取消错误：由 cancel() 或 AbortSignal 触发
export class ConfirmAbortError extends Error {
  constructor(
    public readonly threadTs: string,
    public readonly toolCallId: string,
    public readonly reason: string,
    public readonly partialDecisions: Map<string, ConfirmDecision>,
  ) {
    super(`ConfirmBridge: thread ${threadTs} 被取消 (${reason})`)
    this.name = 'ConfirmAbortError'
  }
}

// 单个待决 pending：按 threadTs 维度维护（同 thread 单 pending）
interface ConfirmPending {
  toolCallId: string
  threadTs: string
  // 待收集的 itemId 集合
  remaining: Set<string>
  // 已收到的决定
  decisions: Map<string, ConfirmDecision>
  resolve: (decisions: Map<string, ConfirmDecision>) => void
  reject: (err: Error) => void
  // 清理钩子（timer + abort listener）
  cleanup: () => void
}

export interface ConfirmBridge {
  /** 指定 thread 是否已有 pending（用于并发检查） */
  hasPending(threadTs: string): boolean

  /**
   * 注册 pending 并返回 Promise，待全部 itemIds 收到决定后 resolve。
   * - timeoutMs：到时未收齐则 reject ConfirmTimeoutError（含 partial decisions）
   * - signal：外部取消，reject ConfirmAbortError
   */
  awaitAllDecisions(params: {
    toolCallId: string
    threadTs: string
    itemIds: string[]
    timeoutMs: number
    signal?: AbortSignal
  }): Promise<Map<string, ConfirmDecision>>

  /**
   * 由 SlackConfirm.onDecision 回调驱动：每收到一条决定就调用一次。
   * 命中非当前 pending（toolCallId 不匹配或 thread 无 pending）直接忽略。
   */
  resolveOne(params: {
    toolCallId: string
    threadTs: string
    itemId: string
    decision: ConfirmDecision
  }): void

  /** 人为取消某 thread 的 pending（例如新调用冲突）*/
  cancel(threadTs: string, reason?: string): void
}

export function createConfirmBridge(deps: { logger: Logger }): ConfirmBridge {
  const log = deps.logger.withTag('confirm-bridge')
  const pendingByThread = new Map<string, ConfirmPending>()

  return {
    hasPending(threadTs) {
      return pendingByThread.has(threadTs)
    },

    awaitAllDecisions({ toolCallId, threadTs, itemIds, timeoutMs, signal }) {
      if (pendingByThread.has(threadTs)) {
        return Promise.reject(
          new Error(`ConfirmBridge: thread ${threadTs} 已存在 pending，禁止并发`),
        )
      }

      if (signal?.aborted) {
        return Promise.reject(
          new ConfirmAbortError(threadTs, toolCallId, 'signal already aborted', new Map()),
        )
      }

      return new Promise<Map<string, ConfirmDecision>>((resolve, reject) => {
        let timer: ReturnType<typeof setTimeout> | null = null
        let abortListener: (() => void) | null = null

        const cleanup = () => {
          if (timer) {
            clearTimeout(timer)
            timer = null
          }
          if (abortListener && signal) {
            signal.removeEventListener('abort', abortListener)
            abortListener = null
          }
        }

        const pending: ConfirmPending = {
          toolCallId,
          threadTs,
          remaining: new Set(itemIds),
          decisions: new Map(),
          resolve: (decisions) => {
            cleanup()
            pendingByThread.delete(threadTs)
            resolve(decisions)
          },
          reject: (err) => {
            cleanup()
            pendingByThread.delete(threadTs)
            reject(err)
          },
          cleanup,
        }
        pendingByThread.set(threadTs, pending)

        timer = setTimeout(() => {
          log.warn('pending 超时', { toolCallId, threadTs, collected: pending.decisions.size })
          pending.reject(new ConfirmTimeoutError(threadTs, toolCallId, new Map(pending.decisions)))
        }, timeoutMs)

        if (signal) {
          abortListener = () => {
            log.info('pending 被 AbortSignal 取消', { toolCallId, threadTs })
            pending.reject(
              new ConfirmAbortError(
                threadTs,
                toolCallId,
                'AbortSignal',
                new Map(pending.decisions),
              ),
            )
          }
          signal.addEventListener('abort', abortListener, { once: true })
        }

        log.debug('pending 注册', {
          toolCallId,
          threadTs,
          itemCount: itemIds.length,
          timeoutMs,
        })
      })
    },

    resolveOne({ toolCallId, threadTs, itemId, decision }) {
      const pending = pendingByThread.get(threadTs)
      if (!pending) {
        log.debug('resolveOne 无 pending，忽略', { threadTs, itemId })
        return
      }
      if (pending.toolCallId !== toolCallId) {
        log.warn('resolveOne toolCallId 不匹配，忽略', {
          expected: pending.toolCallId,
          got: toolCallId,
        })
        return
      }
      if (!pending.remaining.has(itemId)) {
        log.debug('resolveOne itemId 不在 remaining，忽略（可能重复点击）', { itemId })
        return
      }

      pending.decisions.set(itemId, decision)
      pending.remaining.delete(itemId)
      log.debug('收到决定', {
        itemId,
        decision,
        remaining: pending.remaining.size,
      })

      if (pending.remaining.size === 0) {
        pending.resolve(pending.decisions)
      }
    },

    cancel(threadTs, reason = 'manual cancel') {
      const pending = pendingByThread.get(threadTs)
      if (!pending) return
      log.info('cancel pending', { threadTs, reason })
      pending.reject(
        new ConfirmAbortError(threadTs, pending.toolCallId, reason, new Map(pending.decisions)),
      )
    },
  }
}
