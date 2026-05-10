import { describe, expect, it, vi } from 'vitest'
import type { CoreMessage } from 'ai'
import type { CompactAgent } from '@/agents/compact/index.ts'
import type { CompactAgentOutput } from '@/agents/compact/types.ts'
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

function output(summary: string, inputTokens = 100, outputTokens = 50): CompactAgentOutput {
  return {
    summary,
    usage: { inputTokens, outputTokens, cachedInputTokens: 0 },
  }
}

const messagesJsonlPath = '/workspace/.agent-slack/sessions/slack/c.C.t/messages.jsonl'

describe('ContextCompactor', () => {
  it('历史不足时跳过 compact 并返回可持久化回复', async () => {
    const compactAgent: CompactAgent = {
      summarize: vi.fn(),
    }
    const compactor = createContextCompactor({ compactAgent, logger: logger(), keepRecentToolResults: 20 })

    const result = await compactor.manualCompact({
      session: session(),
      history: [{ role: 'user', content: 'hi' }],
      trigger: 'mention_command',
      userId: 'U',
      messagesJsonlPath,
    })

    expect(result.status).toBe('skipped')
    expect(result.responseText).toContain('没有足够的历史上下文')
    expect(result.finalMessages).toHaveLength(1)
    expect(compactAgent.summarize).not.toHaveBeenCalled()
  })

  it('调用 compact agent 生成摘要并返回 compact message（含 [compact: manual] 头）', async () => {
    const compactAgent: CompactAgent = {
      summarize: vi.fn(async () => output('<summary>摘要正文</summary>')),
    }
    const compactor = createContextCompactor({ compactAgent, logger: logger(), keepRecentToolResults: 20 })

    const result = await compactor.manualCompact({
      session: session(),
      history: [
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: 'hello' },
      ],
      trigger: 'mention_command',
      userId: 'U',
      messagesJsonlPath,
    })

    expect(result.status).toBe('compacted')
    expect(result.responseText).toContain('摘要正文')
    expect(result.finalMessages).toHaveLength(1)
    expect(result.finalMessages[0]).toMatchObject({
      role: 'assistant',
      content: '[compact: manual]\n摘要正文',
    })
    expect(result.finalMessages[0]?.id).toEqual(expect.any(String))
  })

  it('autoCompact 生成不可直接展示的 auto summary finalMessage', async () => {
    const compactAgent: CompactAgent = {
      summarize: vi.fn(async () => output('自动摘要')),
    }
    const compactor = createContextCompactor({ compactAgent, logger: logger(), keepRecentToolResults: 20 })

    const result = await compactor.autoCompact({
      session: session(),
      messages: [
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: 'hello' },
      ],
      trigger: 'budget',
      messagesJsonlPath,
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
    const compactor = createContextCompactor({ compactAgent, logger: logger(), keepRecentToolResults: 20 })

    const result = await compactor.autoCompact({
      session: session(),
      messages: [{ role: 'user', content: 'hi' }],
      trigger: 'budget',
      messagesJsonlPath,
    })

    expect(result).toEqual({
      status: 'skipped',
      reason: 'not_enough_messages',
      finalMessages: [],
    })
    expect(compactAgent.summarize).not.toHaveBeenCalled()
  })

  it('入口预处理：剥图 + 旧 tool_result 占位（autoCompact）', async () => {
    const compactAgent: CompactAgent = {
      summarize: vi.fn(async ({ messages }) => {
        const flat = JSON.stringify(messages)
        expect(flat).not.toContain('base64data')
        expect(flat).toContain('[image]')
        expect(flat).toContain('[旧工具结果已压缩]')
        expect(flat).toContain('messages.jsonl')
        return output('摘要')
      }),
    }
    const compactor = createContextCompactor({
      compactAgent,
      logger: logger(),
      keepRecentToolResults: 2,
    })

    const messages: CoreMessage[] = [
      { role: 'user', content: [{ type: 'image', image: 'base64data' }] },
    ]
    for (let i = 0; i < 5; i += 1) {
      messages.push({
        role: 'assistant',
        content: [{ type: 'tool-call', toolCallId: `t${i}`, toolName: 'bash', args: {} }],
      })
      messages.push({
        role: 'tool',
        content: [
          { type: 'tool-result', toolCallId: `t${i}`, toolName: 'bash', result: `output ${i}` },
        ],
      })
    }

    const result = await compactor.autoCompact({
      session: session(),
      messages,
      trigger: 'budget',
      messagesJsonlPath,
    })

    expect(result.status).toBe('compacted')
    expect(compactAgent.summarize).toHaveBeenCalledOnce()
  })

  it('PTL retry：prompt_too_long 时按 API round 砍头重试，第 3 次成功', async () => {
    let attempts = 0
    const compactAgent: CompactAgent = {
      summarize: vi.fn(async () => {
        attempts += 1
        if (attempts <= 2) {
          const err = new Error('prompt is too long')
          ;(err as { name: string }).name = 'PROMPT_TOO_LONG'
          throw err
        }
        return output('final')
      }),
    }
    const compactor = createContextCompactor({
      compactAgent,
      logger: logger(),
      keepRecentToolResults: 20,
    })

    // 4 个 user message → 4 组，可砍 3 次
    const messages: CoreMessage[] = []
    for (let i = 0; i < 4; i += 1) {
      messages.push({ role: 'user', content: `q${i}` })
      messages.push({ role: 'assistant', content: `a${i}` })
    }

    const result = await compactor.autoCompact({
      session: session(),
      messages,
      trigger: 'budget',
      messagesJsonlPath,
    })

    expect(attempts).toBe(3)
    expect(result.status).toBe('compacted')
    expect(compactAgent.summarize).toHaveBeenCalledTimes(3)
  })

  it('PTL retry 超出 MAX_PTL_RETRIES 后抛出 prompt_too_long', async () => {
    const compactAgent: CompactAgent = {
      summarize: vi.fn(async () => {
        const err = new Error('prompt is too long')
        ;(err as { name: string }).name = 'PROMPT_TOO_LONG'
        throw err
      }),
    }
    const compactor = createContextCompactor({
      compactAgent,
      logger: logger(),
      keepRecentToolResults: 20,
    })

    // 6 个 user message → 6 组，足够触发 3 次砍头然后再失败抛出
    const messages: CoreMessage[] = []
    for (let i = 0; i < 6; i += 1) {
      messages.push({ role: 'user', content: `q${i}` })
      messages.push({ role: 'assistant', content: `a${i}` })
    }

    await expect(
      compactor.autoCompact({
        session: session(),
        messages,
        trigger: 'budget',
        messagesJsonlPath,
      }),
    ).rejects.toMatchObject({ name: 'PROMPT_TOO_LONG' })

    // 1 次 + 3 次 retry = 4 次
    expect(compactAgent.summarize).toHaveBeenCalledTimes(4)
  })
})
