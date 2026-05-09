import { describe, it, expect } from 'vitest'
import type { CoreMessage } from 'ai'
import { buildCompactPrompt } from './prompts.ts'

describe('buildCompactPrompt', () => {
  it('does not truncate input below 1M chars (transition mitigation)', () => {
    // 构造 800K chars 的 user message
    const bigContent = 'x'.repeat(800_000)
    const messages: CoreMessage[] = [
      { role: 'user', content: bigContent },
      { role: 'assistant', content: 'ok' },
    ]
    const prompt = buildCompactPrompt({ messages })
    // 关键断言：完整 800K 内容应出现在 prompt 中
    expect(prompt).toContain(bigContent)
    expect(prompt).not.toContain('注意：由于 compact 输入过长')
  })
})
