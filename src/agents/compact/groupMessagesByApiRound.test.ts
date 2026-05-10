import { describe, expect, it } from 'vitest'
import type { CoreMessage } from 'ai'
import { groupMessagesByApiRound } from './groupMessagesByApiRound.ts'

describe('groupMessagesByApiRound', () => {
  it('按 user message 边界分组', () => {
    const msgs: CoreMessage[] = [
      { role: 'user', content: 'q1' },
      { role: 'assistant', content: 'a1' },
      { role: 'user', content: 'q2' },
      { role: 'assistant', content: 'a2' },
    ]
    const groups = groupMessagesByApiRound(msgs)
    expect(groups).toHaveLength(2)
    expect(groups[0]).toHaveLength(2)
    expect(groups[1]).toHaveLength(2)
  })

  it('tool_use 与 tool_result 保留在同一 group', () => {
    const msgs: CoreMessage[] = [
      { role: 'user', content: 'q1' },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'thinking' },
          { type: 'tool-call', toolCallId: 't1', toolName: 'bash', input: {} },
        ],
      },
      { role: 'tool', content: [{ type: 'tool-result', toolCallId: 't1', output: { type: 'text', value: 'ok' } }] },
      { role: 'assistant', content: 'final' },
      { role: 'user', content: 'q2' },
    ]
    const groups = groupMessagesByApiRound(msgs)
    expect(groups).toHaveLength(2)
    expect(groups[0]).toHaveLength(4)
    expect(groups[1]).toHaveLength(1)
  })

  it('开头不是 user 时仍保留为单组', () => {
    const msgs: CoreMessage[] = [{ role: 'assistant', content: 'standalone' }]
    expect(groupMessagesByApiRound(msgs)).toEqual([msgs])
  })

  it('空输入返回空数组', () => {
    expect(groupMessagesByApiRound([])).toEqual([])
  })
})
