import { describe, expect, it } from 'vitest'
import { parseConfig, DEFAULT_CONFIG } from './config.ts'

describe('parseConfig', () => {
  it('空配置返回默认值', () => {
    expect(parseConfig({})).toEqual(DEFAULT_CONFIG)
  })

  it('合并用户字段', () => {
    const cfg = parseConfig({ agent: { name: 'custom', model: 'claude-sonnet-4-6' } })
    expect(cfg.agent.name).toBe('custom')
    expect(cfg.agent.model).toBe('claude-sonnet-4-6')
    expect(cfg.agent.maxSteps).toBe(DEFAULT_CONFIG.agent.maxSteps)
  })

  it('未知 provider 报错', () => {
    expect(() => parseConfig({ im: { provider: 'discord' } })).toThrow()
  })

  it('向后兼容：旧 config 里的 agent.provider=litellm 被保留', () => {
    const cfg = parseConfig({ agent: { provider: 'litellm', model: 'x' } })
    expect(cfg.agent.model).toBe('x')
    expect(cfg.agent.provider).toBe('litellm')
  })

  it('agent.provider=anthropic 有效', () => {
    const cfg = parseConfig({ agent: { provider: 'anthropic' } })
    expect(cfg.agent.provider).toBe('anthropic')
  })

  it('未设 agent.provider 时默认 litellm', () => {
    const cfg = parseConfig({})
    expect(cfg.agent.provider).toBe('litellm')
  })

  it('agent.provider 非法值报错', () => {
    expect(() => parseConfig({ agent: { provider: 'openai' } })).toThrow()
  })
})
