import { describe, it, expect } from 'vitest'
import { createWechatRenderer, splitText } from './WechatRenderer.ts'
import type { AgentExecutionEvent } from '@/core/events.ts'
import type { Logger } from '@/logger/logger.ts'

const stubLogger = (): Logger => {
  const make = (): Logger => ({
    trace: () => {},
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
    withTag: () => make(),
  })
  return make()
}

describe('WechatRenderer', () => {
  it('仅有 final assistant text → 单段', () => {
    const r = createWechatRenderer({ logger: stubLogger() })
    r.onEvent({ type: 'assistant-message', text: '你好' } as AgentExecutionEvent)
    r.onEvent({ type: 'lifecycle', phase: 'completed', finalMessages: [] } as AgentExecutionEvent)
    expect(r.flush()).toEqual(['你好'])
  })

  it('多段 assistant 文本拼接，间用 \\n\\n', () => {
    const r = createWechatRenderer({ logger: stubLogger() })
    r.onEvent({ type: 'assistant-message', text: '第一段' } as AgentExecutionEvent)
    r.onEvent({ type: 'assistant-message', text: '第二段' } as AgentExecutionEvent)
    r.onEvent({ type: 'lifecycle', phase: 'completed', finalMessages: [] } as AgentExecutionEvent)
    expect(r.flush()).toEqual(['第一段\n\n第二段'])
  })

  it('含工具调用 → 摘要前缀放在最前面（去重 + 字典序）', () => {
    const r = createWechatRenderer({ logger: stubLogger() })
    r.onEvent({
      type: 'activity-state',
      state: { status: 's', activities: [], newToolCalls: ['read_file', 'bash'] },
    } as AgentExecutionEvent)
    r.onEvent({
      type: 'activity-state',
      state: { status: 's', activities: [], newToolCalls: ['bash'] }, // 重复 bash 应去重
    } as AgentExecutionEvent)
    r.onEvent({ type: 'assistant-message', text: '完成了' } as AgentExecutionEvent)
    r.onEvent({ type: 'lifecycle', phase: 'completed', finalMessages: [] } as AgentExecutionEvent)
    const segments = r.flush()
    expect(segments[0]).toBe('🔧 使用了工具: bash, read_file')
    expect(segments[1]).toBe('完成了')
  })

  it('clear 状态不应记录工具调用', () => {
    const r = createWechatRenderer({ logger: stubLogger() })
    r.onEvent({
      type: 'activity-state',
      state: { clear: true },
    } as AgentExecutionEvent)
    r.onEvent({ type: 'assistant-message', text: '完成' } as AgentExecutionEvent)
    r.onEvent({ type: 'lifecycle', phase: 'completed', finalMessages: [] } as AgentExecutionEvent)
    expect(r.flush()).toEqual(['完成'])
  })

  it('失败态 → 末段追加错误提示', () => {
    const r = createWechatRenderer({ logger: stubLogger() })
    r.onEvent({ type: 'assistant-message', text: '试图处理...' } as AgentExecutionEvent)
    r.onEvent({
      type: 'lifecycle',
      phase: 'failed',
      error: { message: 'rate limit exceeded\n  at line 42' },
    } as AgentExecutionEvent)
    const segments = r.flush()
    expect(segments[segments.length - 1]).toBe('⚠️ 处理失败：rate limit exceeded')
  })

  it('无任何输出 → 占位文本"（本轮无输出）"', () => {
    const r = createWechatRenderer({ logger: stubLogger() })
    r.onEvent({ type: 'lifecycle', phase: 'completed', finalMessages: [] } as AgentExecutionEvent)
    expect(r.flush()).toEqual(['（本轮无输出）'])
  })

  it('STARTING_MESSAGE 是 "开始处理..."', () => {
    const r = createWechatRenderer({ logger: stubLogger() })
    expect(r.STARTING_MESSAGE).toBe('开始处理...')
  })
})

describe('splitText', () => {
  it('短文本不切', () => {
    expect(splitText('hello', 100)).toEqual(['hello'])
  })

  it('优先按 \\n\\n 切', () => {
    const text = 'a'.repeat(50) + '\n\n' + 'b'.repeat(50) + '\n\n' + 'c'.repeat(50)
    const chunks = splitText(text, 60)
    expect(chunks.length).toBeGreaterThan(1)
    expect(chunks[0]).toBe('a'.repeat(50))
  })

  it('无 \\n\\n 时回退到 \\n 切', () => {
    const text = 'aaaa\nbbbb\ncccc\ndddd'
    const chunks = splitText(text, 6)
    // 期望按行切
    expect(chunks.every((c) => c.length <= 6)).toBe(true)
    expect(chunks.join('').replace(/\n/g, '')).toBe('aaaabbbbccccdddd')
  })

  it('硬切兜底（超长无换行字符串）', () => {
    const text = 'a'.repeat(100)
    const chunks = splitText(text, 30)
    expect(chunks.every((c) => c.length <= 30)).toBe(true)
    expect(chunks.join('')).toBe(text)
  })
})
