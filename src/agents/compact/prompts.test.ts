import { describe, expect, it } from 'vitest'
import type { CoreMessage } from 'ai'
import { buildCompactPrompt, COMPACT_SYSTEM_PROMPT } from './prompts.ts'

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

describe('COMPACT_SYSTEM_PROMPT', () => {
  it('包含 9 个编号章节', () => {
    for (const i of [1, 2, 3, 4, 5, 6, 7, 8, 9]) {
      expect(COMPACT_SYSTEM_PROMPT).toMatch(new RegExp(`^${i}\\.`, 'm'))
    }
  })

  it('要求 <analysis> 与 <summary> 双 block', () => {
    expect(COMPACT_SYSTEM_PROMPT).toContain('<analysis>')
    expect(COMPACT_SYSTEM_PROMPT).toContain('<summary>')
  })

  it('NO_TOOLS 双重保护：preamble + trailer 都禁用工具调用', () => {
    const matches = COMPACT_SYSTEM_PROMPT.match(/不要(调用|使用)/g) ?? []
    expect(matches.length).toBeGreaterThanOrEqual(2)
  })

  it('不再设 8 条要点上限', () => {
    expect(COMPACT_SYSTEM_PROMPT).not.toContain('不超过 8 条')
    expect(COMPACT_SYSTEM_PROMPT).not.toContain('最多 8 条')
  })

  it('要求 verbatim 引用最近对话（避免任务漂移）', () => {
    expect(COMPACT_SYSTEM_PROMPT).toContain('verbatim')
  })
})
