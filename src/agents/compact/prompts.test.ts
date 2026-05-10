import { describe, expect, it } from 'vitest'
import type { CoreMessage } from 'ai'
import { buildCompactPrompt } from './prompts.ts'

describe('buildCompactPrompt', () => {
  it('完整保留 800K chars 输入，不截断', () => {
    const bigContent = 'x'.repeat(800_000)
    const messages: CoreMessage[] = [
      { role: 'user', content: bigContent },
      { role: 'assistant', content: 'ok' },
    ]
    const prompt = buildCompactPrompt({ messages })
    expect(prompt).toContain(bigContent)
    expect(prompt).not.toContain('注意：由于 compact 输入过长')
  })

  it('永不预截输入；2M chars 同样原样进 prompt（PTL retry 由 ContextCompactor 处理）', () => {
    const huge = 'x'.repeat(2_000_000)
    const prompt = buildCompactPrompt({ messages: [{ role: 'user', content: huge }] })
    expect(prompt).toContain(huge)
  })
})
