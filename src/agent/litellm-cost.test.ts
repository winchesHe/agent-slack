import { describe, expect, it } from 'vitest'
import { extractCostFromMetadata } from './litellm-cost.ts'

describe('extractCostFromMetadata', () => {
  it('优先读取 litellm.cost', () => {
    expect(extractCostFromMetadata({ litellm: { cost: 0.0123 } })).toBe(0.0123)
  })

  it('回退读取 litellm.response_cost', () => {
    expect(extractCostFromMetadata({ litellm: { response_cost: 0.4 } })).toBe(0.4)
  })

  it('再回退读取 openaiCompat.cost', () => {
    expect(extractCostFromMetadata({ openaiCompat: { cost: 0.001 } })).toBe(0.001)
  })

  it('非对象或无匹配路径时返回 undefined', () => {
    expect(extractCostFromMetadata({})).toBeUndefined()
    expect(extractCostFromMetadata(undefined)).toBeUndefined()
    expect(extractCostFromMetadata(null)).toBeUndefined()
    expect(extractCostFromMetadata('oops')).toBeUndefined()
  })

  it('路径存在但值不是有限数字时返回 undefined', () => {
    expect(extractCostFromMetadata({ litellm: { cost: 'nope' } })).toBeUndefined()
    expect(extractCostFromMetadata({ litellm: { response_cost: Number.NaN } })).toBeUndefined()
  })
})
