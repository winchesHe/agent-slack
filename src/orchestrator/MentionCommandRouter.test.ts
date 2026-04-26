import { describe, expect, it, vi } from 'vitest'
import { createMentionCommandRouter } from './MentionCommandRouter.ts'
import type { ContextCompactor } from './ContextCompactor.ts'

function routerWithMockCompactor() {
  const compactor: ContextCompactor = {
    manualCompact: vi.fn(async () => ({
      status: 'compacted' as const,
      responseText: 'ok',
      finalMessages: [{ id: 'msg-compact', role: 'assistant' as const, content: 'ok' }],
    })),
    autoCompact: vi.fn(async () => ({
      status: 'skipped' as const,
      reason: 'not_needed',
      finalMessages: [],
    })),
  }
  return { router: createMentionCommandRouter({ compactor }), compactor }
}

describe('MentionCommandRouter', () => {
  it('匹配 compact 控制命令', () => {
    const { router } = routerWithMockCompactor()

    expect(router.match('/compact')).toBe('compact')
    expect(router.match(' compact ')).toBe('compact')
    expect(router.match('压缩上下文')).toBe('compact')
    expect(router.match('帮我压缩当前上下文')).toBe('compact')
  })

  it('不把未知命令前缀当成真实命令', () => {
    const { router } = routerWithMockCompactor()

    expect(router.match('/unknown compact')).toBeUndefined()
    expect(router.match('帮我改代码')).toBeUndefined()
  })
})
