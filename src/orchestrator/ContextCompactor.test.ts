import { describe, expect, it, vi } from 'vitest'
import type { CompactAgent } from '@/agents/compact/index.ts'
import type { Logger } from '@/logger/logger.ts'
import type { Session } from '@/store/SessionStore.ts'
import { createContextCompactor } from './ContextCompactor.ts'

function logger(): Logger {
  return {
    trace: () => {},
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
    withTag: () => logger(),
  }
}

function session(): Session {
  return {
    id: 'slack:C:t',
    dir: '/workspace/.agent-slack/sessions/slack/c.C.t',
    meta: {
      schemaVersion: 1,
      imProvider: 'slack',
      channelId: 'C',
      channelName: 'c',
      threadTs: 't',
      imUserId: 'U',
      agentName: 'default',
      createdAt: '2026-04-26T00:00:00.000Z',
      updatedAt: '2026-04-26T00:00:00.000Z',
      status: 'running',
      usage: {
        inputTokens: 0,
        outputTokens: 0,
        cachedInputTokens: 0,
        totalCostUSD: 0,
        stepCount: 0,
      },
    },
  }
}

describe('ContextCompactor', () => {
  it('历史不足时跳过 compact 并返回可持久化回复', async () => {
    const compactAgent: CompactAgent = {
      summarize: vi.fn(),
    }
    const compactor = createContextCompactor({ compactAgent, logger: logger() })

    const result = await compactor.manualCompact({
      session: session(),
      history: [{ role: 'user', content: 'hi' }],
      trigger: 'mention_command',
      userId: 'U',
    })

    expect(result.status).toBe('skipped')
    expect(result.responseText).toContain('没有足够的历史上下文')
    expect(result.finalMessages).toHaveLength(1)
    expect(compactAgent.summarize).not.toHaveBeenCalled()
  })

  it('调用 compact agent 生成摘要并返回 compact message', async () => {
    const compactAgent: CompactAgent = {
      summarize: vi.fn(
        async () =>
          '摘要内容\n完整会话记录：/workspace/.agent-slack/sessions/slack/c.C.t/messages.jsonl',
      ),
    }
    const compactor = createContextCompactor({ compactAgent, logger: logger() })

    const result = await compactor.manualCompact({
      session: session(),
      history: [
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: 'hello' },
      ],
      trigger: 'mention_command',
      userId: 'U',
    })

    expect(result.status).toBe('compacted')
    expect(result.responseText).toContain('摘要内容')
    expect(result.responseText).not.toContain('messages.jsonl')
    expect(result.responseText).not.toContain('/workspace/')
    expect(result.finalMessages).toHaveLength(1)
    expect(result.finalMessages[0]).toMatchObject({
      role: 'assistant',
      content: '[compact: manual]\n摘要内容',
    })
    expect(result.finalMessages[0]?.id).toEqual(expect.any(String))
  })

  it('compact message 会过滤低价值握手内容', async () => {
    const compactAgent: CompactAgent = {
      summarize: vi.fn(async () =>
        [
          '用户正在排查 compact 显示顺序。',
          '- COMPACT_COMMAND_READY abc',
          '- Reply exactly: COMPACT_COMMAND_READY abc',
          '- Do not use tools.',
        ].join('\n'),
      ),
    }
    const compactor = createContextCompactor({ compactAgent, logger: logger() })

    const result = await compactor.manualCompact({
      session: session(),
      history: [
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: 'hello' },
      ],
      trigger: 'mention_command',
      userId: 'U',
    })

    expect(result.responseText).toContain('用户正在排查 compact 显示顺序。')
    expect(result.responseText).not.toContain('COMPACT_COMMAND_READY')
    expect(result.responseText).not.toContain('Reply exactly')
    expect(result.responseText).not.toContain('Do not use tools')
  })

  it('autoCompact 生成不可直接展示的 auto summary finalMessage', async () => {
    const compactAgent: CompactAgent = {
      summarize: vi.fn(async () => '自动摘要'),
    }
    const compactor = createContextCompactor({ compactAgent, logger: logger() })

    const result = await compactor.autoCompact({
      session: session(),
      messages: [
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: 'hello' },
      ],
      trigger: 'budget',
    })

    expect(result.status).toBe('compacted')
    expect(result.finalMessages).toHaveLength(1)
    expect(result.finalMessages[0]).toMatchObject({
      role: 'assistant',
      content: '[compact: auto]\n自动摘要',
    })
    expect(compactAgent.summarize).toHaveBeenCalledWith({
      messages: [
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: 'hello' },
      ],
    })
  })

  it('autoCompact 历史不足时跳过且不调用模型', async () => {
    const compactAgent: CompactAgent = {
      summarize: vi.fn(),
    }
    const compactor = createContextCompactor({ compactAgent, logger: logger() })

    const result = await compactor.autoCompact({
      session: session(),
      messages: [{ role: 'user', content: 'hi' }],
      trigger: 'budget',
    })

    expect(result).toEqual({
      status: 'skipped',
      reason: 'not_enough_messages',
      finalMessages: [],
    })
    expect(compactAgent.summarize).not.toHaveBeenCalled()
  })
})
