import { afterEach, describe, expect, it, vi } from 'vitest'
import { SessionRunQueue } from './SessionRunQueue.ts'

describe('SessionRunQueue', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('同 session 严格串行', async () => {
    vi.useFakeTimers()

    const q = new SessionRunQueue()
    const started: string[] = []

    const p1 = q.enqueue('s1', async () => {
      started.push('r1')
      await new Promise<void>((resolve) => setTimeout(resolve, 10))
    })

    const p2 = q.enqueue('s1', async () => {
      started.push('r2')
    })

    // flush microtasks：应只启动第一个 runner
    await Promise.resolve()
    expect(started).toEqual(['r1'])
    expect(q.queueDepth('s1')).toBe(2)

    await vi.runAllTimersAsync()
    await Promise.resolve()

    expect(started).toEqual(['r1', 'r2'])
    await expect(p1).resolves.toBeUndefined()
    await expect(p2).resolves.toBeUndefined()
    expect(q.queueDepth('s1')).toBe(0)
  })

  it('不同 session 并行（互不等待）', async () => {
    vi.useFakeTimers()

    const q = new SessionRunQueue()
    const started: string[] = []

    const pA = q.enqueue('a', async () => {
      started.push('a')
      await new Promise<void>((resolve) => setTimeout(resolve, 10))
    })
    const pB = q.enqueue('b', async () => {
      started.push('b')
      await new Promise<void>((resolve) => setTimeout(resolve, 10))
    })

    await Promise.resolve()
    expect(new Set(started)).toEqual(new Set(['a', 'b']))
    expect(q.queueDepth('a')).toBe(1)
    expect(q.queueDepth('b')).toBe(1)

    await vi.runAllTimersAsync()
    await Promise.all([pA, pB])
    expect(q.queueDepth('a')).toBe(0)
    expect(q.queueDepth('b')).toBe(0)
  })

  it('runner 抛错不破坏后续 runner', async () => {
    const q = new SessionRunQueue()
    const order: string[] = []

    const p1 = q.enqueue('s', async () => {
      order.push('bad')
      throw new Error('boom')
    })
    // 立刻挂上断言（也会绑定 reject handler），避免 Vitest 认为这是未处理的 Promise reject。
    const p1Assertion = expect(p1).rejects.toThrow('boom')
    const p2 = q.enqueue('s', async () => {
      order.push('good')
    })

    await p1Assertion
    await expect(p2).resolves.toBeUndefined()
    expect(order).toEqual(['bad', 'good'])
    expect(q.queueDepth('s')).toBe(0)
  })

  it('queueDepth 正确（含正在执行）且空闲后归零/自动 GC', async () => {
    vi.useFakeTimers()

    const q = new SessionRunQueue()
    const p1 = q.enqueue('s', async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 10))
    })

    await Promise.resolve()
    expect(q.queueDepth('s')).toBe(1)

    const p2 = q.enqueue('s', async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 10))
    })
    expect(q.queueDepth('s')).toBe(2)

    // 先推进 10ms：第一个完成后第二个应开始，深度变 1
    await vi.advanceTimersByTimeAsync(10)
    await Promise.resolve()
    expect(q.queueDepth('s')).toBe(1)

    await vi.advanceTimersByTimeAsync(10)
    await Promise.all([p1, p2])
    expect(q.queueDepth('s')).toBe(0)

    // 再次查询仍为 0，说明 key 已被 GC（外部仅能通过 queueDepth 观察）
    expect(q.queueDepth('s')).toBe(0)
  })
})
