import { describe, expect, it, vi } from 'vitest'
import type { WebClient } from '@slack/web-api'
import type { Logger } from '@/logger/logger.ts'
import {
  buildConfirmBlocks,
  buildConfirmActionId,
  buildConfirmResultBlocks,
  parseConfirmActionId,
  createSlackConfirm,
  type ConfirmItem,
} from './SlackConfirm.ts'

function stubLogger(): Logger {
  const logger: Logger = {
    trace: () => {},
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
    withTag: () => stubLogger(),
  }
  return logger
}

function mockWeb(): { web: WebClient; posted: unknown[] } {
  const posted: unknown[] = []
  const web = {
    chat: {
      postMessage: vi.fn(async (args: unknown) => {
        posted.push(args)
        return { ok: true, ts: 'msg-ts' }
      }),
    },
  } as unknown as WebClient
  return { web, posted }
}

// ── buildConfirmBlocks 纯函数测试 ─────────────────────

describe('buildConfirmBlocks', () => {
  const item: ConfirmItem = {
    id: 'rule-001',
    body: '*规则 1*\n使用 pnpm 而非 npm',
  }

  it('生成 section + actions 两个 block', () => {
    const blocks = buildConfirmBlocks(item, 'self_improve')
    expect(blocks).toHaveLength(2)
    expect(blocks[0]!.type).toBe('section')
    expect(blocks[1]!.type).toBe('actions')
  })

  it('section 包含 item body', () => {
    const blocks = buildConfirmBlocks(item, 'self_improve')
    const section = blocks[0] as Record<string, unknown>
    expect(section.text).toEqual({ type: 'mrkdwn', text: item.body })
  })

  it('actions 包含两个按钮（accept + reject）', () => {
    const blocks = buildConfirmBlocks(item, 'self_improve')
    const actions = blocks[1] as { elements: Array<Record<string, unknown>> }
    expect(actions.elements).toHaveLength(2)
    expect(actions.elements[0]!.action_id).toBe('confirm:self_improve:accept:rule-001')
    expect(actions.elements[0]!.style).toBe('primary')
    expect(actions.elements[1]!.action_id).toBe('confirm:self_improve:reject:rule-001')
    expect(actions.elements[1]!.style).toBe('danger')
  })

  it('有 context 时生成 section + context + actions 三个 block', () => {
    const itemWithCtx: ConfirmItem = { ...item, context: '📎 证据：session-123' }
    const blocks = buildConfirmBlocks(itemWithCtx, 'ns')
    expect(blocks).toHaveLength(3)
    expect(blocks[0]!.type).toBe('section')
    expect(blocks[1]!.type).toBe('context')
    expect(blocks[2]!.type).toBe('actions')
  })

  it('自定义 labels', () => {
    const blocks = buildConfirmBlocks(item, 'deploy', { accept: '🚀 部署', reject: '🛑 取消' })
    const actions = blocks[1] as { elements: Array<{ text: { text: string } }> }
    expect(actions.elements[0]!.text.text).toBe('🚀 部署')
    expect(actions.elements[1]!.text.text).toBe('🛑 取消')
  })

  it('默认 labels 为 ✅ 采纳 / ❌ 跳过', () => {
    const blocks = buildConfirmBlocks(item, 'ns')
    const actions = blocks[1] as { elements: Array<{ text: { text: string } }> }
    expect(actions.elements[0]!.text.text).toBe('✅ 采纳')
    expect(actions.elements[1]!.text.text).toBe('❌ 跳过')
  })
})

// ── buildConfirmActionId / parseConfirmActionId 测试 ──

describe('buildConfirmActionId', () => {
  it('生成格式正确的 action_id', () => {
    expect(buildConfirmActionId('self_improve', 'accept', 'rule-001')).toBe(
      'confirm:self_improve:accept:rule-001',
    )
  })
})

describe('parseConfirmActionId', () => {
  it('解析合法 action_id', () => {
    const result = parseConfirmActionId('confirm:self_improve:accept:rule-001')
    expect(result).toEqual({ namespace: 'self_improve', decision: 'accept', itemId: 'rule-001' })
  })

  it('解析 reject', () => {
    const result = parseConfirmActionId('confirm:deploy:reject:pr-456')
    expect(result).toEqual({ namespace: 'deploy', decision: 'reject', itemId: 'pr-456' })
  })

  it('itemId 含冒号时仍能正确解析', () => {
    const result = parseConfirmActionId('confirm:ns:accept:id:with:colons')
    expect(result).toEqual({ namespace: 'ns', decision: 'accept', itemId: 'id:with:colons' })
  })

  it('非法格式返回 undefined', () => {
    expect(parseConfirmActionId('not-a-confirm')).toBeUndefined()
    expect(parseConfirmActionId('confirm:ns:invalid:id')).toBeUndefined()
  })
})

// ── buildConfirmResultBlocks 测试 ─────────────────────

describe('buildConfirmResultBlocks', () => {
  it('accept 时显示 ✅ 已采纳', () => {
    const original = [
      { type: 'section', text: { type: 'mrkdwn', text: '规则 1' } },
      { type: 'actions', elements: [] },
    ]
    const result = buildConfirmResultBlocks(original, 'accept')
    expect(result).toHaveLength(2)
    expect(result[0]!.type).toBe('section')
    expect(result[1]!.type).toBe('context')
    expect((result[1] as { elements: Array<{ text: string }> }).elements[0]!.text).toBe('✅ 已采纳')
  })

  it('reject 时显示 ❌ 已跳过', () => {
    const original = [
      { type: 'section', text: { type: 'mrkdwn', text: '规则 1' } },
      { type: 'context', elements: [{ type: 'mrkdwn', text: '证据' }] },
      { type: 'actions', elements: [] },
    ]
    const result = buildConfirmResultBlocks(original, 'reject')
    // section + 原 context + 结果 context
    expect(result).toHaveLength(3)
    expect(result[0]!.type).toBe('section')
    expect(result[1]!.type).toBe('context')
    expect(result[2]!.type).toBe('context')
    expect((result[2] as { elements: Array<{ text: string }> }).elements[0]!.text).toBe('❌ 已跳过')
  })
})

// ── createSlackConfirm 集成测试 ───────────────────────

describe('createSlackConfirm', () => {
  it('send 发送消息并注册 callback', async () => {
    const { web, posted } = mockWeb()
    const confirm = createSlackConfirm({ logger: stubLogger() })
    const cb = vi.fn()

    await confirm.send({
      web,
      channelId: 'C123',
      threadTs: 'ts-1',
      items: [
        { id: 'rule-1', body: '规则 1' },
        { id: 'rule-2', body: '规则 2' },
      ],
      namespace: 'test_ns',
      onDecision: cb,
    })

    // 发了 2 条消息
    expect(posted).toHaveLength(2)
    // callback 已注册
    expect(confirm.getCallback('test_ns')).toBe(cb)
  })

  it('getCallback 对未注册 namespace 返回 undefined', () => {
    const confirm = createSlackConfirm({ logger: stubLogger() })
    expect(confirm.getCallback('nonexistent')).toBeUndefined()
  })

  it('postMessage 失败时不抛错，继续发送后续 items', async () => {
    const web = {
      chat: {
        postMessage: vi
          .fn()
          .mockRejectedValueOnce(new Error('rate limited'))
          .mockResolvedValueOnce({ ok: true, ts: 'ts-2' }),
      },
    } as unknown as WebClient
    const confirm = createSlackConfirm({ logger: stubLogger() })

    await confirm.send({
      web,
      channelId: 'C123',
      threadTs: 'ts-1',
      items: [
        { id: 'rule-1', body: '规则 1' },
        { id: 'rule-2', body: '规则 2' },
      ],
      namespace: 'ns',
      onDecision: vi.fn(),
    })

    // 两次调用都执行了
    expect(web.chat.postMessage).toHaveBeenCalledTimes(2)
  })
})
