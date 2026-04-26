import { describe, expect, it, beforeEach } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { CoreMessage } from 'ai'
import { resolveWorkspacePaths } from '@/workspace/paths.ts'
import { createSessionStore } from './SessionStore.ts'

let cwd: string

beforeEach(() => {
  cwd = mkdtempSync(path.join(tmpdir(), 'ss-'))
})

async function createStoreWithSession(threadTs: string) {
  const store = createSessionStore(resolveWorkspacePaths(cwd))
  const session = await store.getOrCreate({
    imProvider: 'slack',
    channelId: 'C1',
    channelName: 'general',
    threadTs,
    imUserId: 'U1',
  })
  return { store, session }
}

describe('SessionStore', () => {
  it('getOrCreate 新建并持久化 meta', async () => {
    const store = createSessionStore(resolveWorkspacePaths(cwd))
    const s = await store.getOrCreate({
      imProvider: 'slack',
      channelId: 'C1',
      channelName: 'general',
      threadTs: '12345',
      imUserId: 'U1',
    })
    expect(s.meta.channelId).toBe('C1')
    expect(s.meta.status).toBe('idle')

    const again = await store.getOrCreate({
      imProvider: 'slack',
      channelId: 'C1',
      channelName: 'should-not-change',
      threadTs: '12345',
      imUserId: 'U1',
    })
    expect(again.meta.channelName).toBe('general')
  })

  it('append + loadMessages 顺序保持', async () => {
    const { store, session } = await createStoreWithSession('t1')
    await store.appendMessage(session.id, { role: 'user', content: 'hi' })
    await store.appendMessage(session.id, { role: 'assistant', content: 'hello' })
    const msgs = await store.loadMessages(session.id)
    expect(msgs).toHaveLength(2)
    expect(msgs[0]).toMatchObject({ role: 'user', content: 'hi' })
  })

  it('append + loadMessages 保留 assistant tool-call 与 tool-result 原样顺序', async () => {
    const { store, session } = await createStoreWithSession('t-tool')
    const messages: CoreMessage[] = [
      {
        role: 'assistant',
        content: [
          { type: 'text', text: '先查一下。' },
          {
            type: 'tool-call',
            toolCallId: 'call_1',
            toolName: 'search_docs',
            args: { query: 'tool 持久化' },
          },
        ],
      },
      {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: 'call_1',
            toolName: 'search_docs',
            result: {
              matches: [{ title: '设计文档', score: 0.98 }],
            },
          },
        ],
      },
    ]

    for (const message of messages) {
      await store.appendMessage(session.id, message)
    }

    const msgs = await store.loadMessages(session.id)
    expect(msgs).toEqual(messages)
  })

  it('setStatus 接受 stopped', async () => {
    const { store, session } = await createStoreWithSession('t2')
    await store.setStatus(session.id, 'stopped')
    const reloaded = await store.getOrCreate({
      imProvider: 'slack',
      channelId: 'C1',
      channelName: 'general',
      threadTs: 't2',
      imUserId: 'U1',
    })
    expect(reloaded.meta.status).toBe('stopped')
  })

  it('accumulateUsage 仅累加 token 与 stepCount，不再累加 cost', async () => {
    const { store, session } = await createStoreWithSession('t3')
    await store.accumulateUsage(session.id, {
      inputTokens: 10,
      outputTokens: 5,
      cachedInputTokens: 4,
      costUSD: 0.01,
    })
    await store.accumulateUsage(session.id, {
      inputTokens: 3,
      outputTokens: 2,
      cachedInputTokens: 1,
    })
    const reloaded = await store.getOrCreate({
      imProvider: 'slack',
      channelId: 'C1',
      channelName: 'general',
      threadTs: 't3',
      imUserId: 'U1',
    })
    expect(reloaded.meta.usage.inputTokens).toBe(13)
    expect(reloaded.meta.usage.outputTokens).toBe(7)
    expect(reloaded.meta.usage.cachedInputTokens).toBe(5)
    expect(reloaded.meta.usage.stepCount).toBe(2)
    expect(reloaded.meta.usage.totalCostUSD).toBe(0)
  })

  it('accumulateCost 独立累加 USD', async () => {
    const { store, session } = await createStoreWithSession('t4')
    await store.accumulateCost(session.id, 0.01)
    await store.accumulateCost(session.id, 0.025)
    const reloaded = await store.getOrCreate({
      imProvider: 'slack',
      channelId: 'C1',
      channelName: 'general',
      threadTs: 't4',
      imUserId: 'U1',
    })
    expect(reloaded.meta.usage.totalCostUSD).toBeCloseTo(0.035)
  })

  it('auto compact 状态默认向后兼容旧 meta，并可持久化更新', async () => {
    const { store, session } = await createStoreWithSession('t-auto-compact')

    await expect(store.getAutoCompactState(session.id)).resolves.toEqual({
      failureCount: 0,
      breakerOpen: false,
    })

    await store.setAutoCompactState(session.id, {
      failureCount: 2,
      breakerOpen: true,
      lastAttemptAt: '2026-04-26T00:00:00.000Z',
      lastFailureAt: '2026-04-26T00:00:01.000Z',
      lastFailureMessage: 'compact failed',
    })

    await expect(store.getAutoCompactState(session.id)).resolves.toEqual({
      failureCount: 2,
      breakerOpen: true,
      lastAttemptAt: '2026-04-26T00:00:00.000Z',
      lastFailureAt: '2026-04-26T00:00:01.000Z',
      lastFailureMessage: 'compact failed',
    })

    const reloaded = await store.getOrCreate({
      imProvider: 'slack',
      channelId: 'C1',
      channelName: 'general',
      threadTs: 't-auto-compact',
      imUserId: 'U1',
    })
    expect(reloaded.meta.context?.autoCompact?.breakerOpen).toBe(true)
  })

  it('按多个 model 循环 accumulateUsage 后只通过一次 accumulateCost 记账', async () => {
    const { store, session } = await createStoreWithSession('t5')
    const modelSteps = [
      { inputTokens: 10, outputTokens: 3, cachedInputTokens: 2, costUSD: 0.02 },
      { inputTokens: 7, outputTokens: 4, cachedInputTokens: 1, costUSD: 0.02 },
      { inputTokens: 5, outputTokens: 2, cachedInputTokens: 0, costUSD: 0.02 },
    ]
    for (const step of modelSteps) {
      await store.accumulateUsage(session.id, step)
    }
    await store.accumulateCost(session.id, 0.02)
    const reloaded = await store.getOrCreate({
      imProvider: 'slack',
      channelId: 'C1',
      channelName: 'general',
      threadTs: 't5',
      imUserId: 'U1',
    })
    expect(reloaded.meta.usage.inputTokens).toBe(22)
    expect(reloaded.meta.usage.outputTokens).toBe(9)
    expect(reloaded.meta.usage.cachedInputTokens).toBe(3)
    expect(reloaded.meta.usage.stepCount).toBe(3)
    expect(reloaded.meta.usage.totalCostUSD).toBeCloseTo(0.02)
  })
})
