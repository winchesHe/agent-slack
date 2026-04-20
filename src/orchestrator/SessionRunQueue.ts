export type SessionRunner<T> = () => T | Promise<T>

interface SessionQueueState {
  /** 串行链路的尾巴：永远 resolve（用于保证后续 runner 不被前序错误阻断）。 */
  tail: Promise<void>
  /** 队列深度：包含正在执行的那个。 */
  depth: number
}

/**
 * SessionRunQueue：按 sessionId 做严格串行执行；不同 session 之间允许并行。
 *
 * 关键语义：
 * - enqueue(sessionId, runner)：同 session 串行，不同 session 并行
 * - queueDepth(sessionId)：返回深度（包含正在执行的那个）
 * - runner 抛错不影响后续 runner（链路尾巴必须吞掉错误，返回给调用方的 Promise 仍应 reject）
 * - 队列空闲后自动 GC key，避免 map 无限增长
 */
export class SessionRunQueue {
  private readonly states = new Map<string, SessionQueueState>()

  enqueue<T>(sessionId: string, runner: SessionRunner<T>): Promise<T> {
    let state = this.states.get(sessionId)
    if (!state) {
      state = { tail: Promise.resolve(), depth: 0 }
      this.states.set(sessionId, state)
    }

    state.depth += 1

    // 基于 tail 串行化；这里返回的 runPromise 会把 runner 的异常暴露给调用者。
    const runPromise = state.tail.then(() => runner())

    // 更新 tail：必须吞掉错误，确保后续 runner 总能接上链路。
    state.tail = runPromise.then(
      () => {},
      () => {},
    )

    const cleanup = () => {
      state!.depth -= 1
      if (state!.depth === 0) {
        // 仅当当前 map 仍指向同一个 state 时才删除，避免并发重入下误删新 state。
        const cur = this.states.get(sessionId)
        if (cur === state) this.states.delete(sessionId)
      }
    }

    // 注意：不要裸用 finally() 并忽略返回值；那会生成一个同样会 reject 的新 Promise，导致 Unhandled Rejection。
    void runPromise.then(
      () => cleanup(),
      () => cleanup(),
    )

    return runPromise
  }

  queueDepth(sessionId: string): number {
    return this.states.get(sessionId)?.depth ?? 0
  }
}
