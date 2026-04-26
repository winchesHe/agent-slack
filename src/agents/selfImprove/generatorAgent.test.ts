import { describe, expect, it } from 'vitest'
import { createSelfImproveGenerator, type CandidateRule } from './generatorAgent.ts'

function rule(overrides: Partial<CandidateRule>): CandidateRule {
  return {
    id: 'rule-default',
    content: '默认规则内容',
    category: 'workflow',
    confidence: 'medium',
    evidence: 'test',
    ...overrides,
  }
}

describe('createSelfImproveGenerator', () => {
  it('过滤无效/重复规则，并按 confidence + category 排序', () => {
    const generator = createSelfImproveGenerator()

    const result = generator.process(
      [
        rule({
          id: 'medium-workflow',
          content: '运行测试后再交付',
          category: 'workflow',
          confidence: 'medium',
        }),
        rule({
          id: 'high-code',
          content: '不要使用 any，优先 unknown 和类型守卫',
          category: 'code-standards',
          confidence: 'high',
        }),
        rule({
          id: 'duplicate-existing',
          content: '使用 pnpm 管理依赖',
          category: 'workflow',
          confidence: 'high',
        }),
        rule({
          id: 'duplicate-group',
          content: '不要使用 any，优先 unknown 和类型守卫。',
          category: 'code-standards',
          confidence: 'high',
        }),
        rule({ id: 'invalid-empty', content: '' }),
      ],
      '- 使用 pnpm 管理依赖',
    )

    expect(result.map((item) => item.id)).toEqual(['high-code', 'medium-workflow'])
  })
})
