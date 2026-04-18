import { describe, expect, it, beforeEach } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { resolveWorkspacePaths } from '@/workspace/paths.ts'
import { createSessionStore } from './SessionStore.ts'

let cwd: string

beforeEach(() => {
  cwd = mkdtempSync(path.join(tmpdir(), 'ss-'))
})

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
    const store = createSessionStore(resolveWorkspacePaths(cwd))
    const s = await store.getOrCreate({
      imProvider: 'slack',
      channelId: 'C1',
      channelName: 'c',
      threadTs: 't1',
      imUserId: 'U1',
    })
    await store.appendMessage(s.id, { role: 'user', content: 'hi' })
    await store.appendMessage(s.id, { role: 'assistant', content: 'hello' })
    const msgs = await store.loadMessages(s.id)
    expect(msgs).toHaveLength(2)
    expect(msgs[0]).toMatchObject({ role: 'user', content: 'hi' })
  })

  it('accumulateUsage 累加', async () => {
    const store = createSessionStore(resolveWorkspacePaths(cwd))
    const s = await store.getOrCreate({
      imProvider: 'slack',
      channelId: 'C1',
      channelName: 'c',
      threadTs: 't2',
      imUserId: 'U1',
    })
    await store.accumulateUsage(s.id, { inputTokens: 10, outputTokens: 5 })
    await store.accumulateUsage(s.id, { inputTokens: 3, outputTokens: 2, costUSD: 0.01 })
    const reloaded = await store.getOrCreate({
      imProvider: 'slack',
      channelId: 'C1',
      channelName: 'c',
      threadTs: 't2',
      imUserId: 'U1',
    })
    expect(reloaded.meta.usage.inputTokens).toBe(13)
    expect(reloaded.meta.usage.outputTokens).toBe(7)
    expect(reloaded.meta.usage.totalCostUSD).toBeCloseTo(0.01)
  })
})
