import { describe, expect, it } from 'vitest'
import { parseConfig, DEFAULT_CONFIG } from './config.ts'

describe('parseConfig', () => {
  it('空配置返回默认值', () => {
    expect(parseConfig({})).toEqual(DEFAULT_CONFIG)
    expect(DEFAULT_CONFIG.agent.model).toBe('gpt-5.5')
    expect(DEFAULT_CONFIG.agent.maxSteps).toBe(50)
    expect(DEFAULT_CONFIG.agent.context).toEqual({
      maxApproxChars: 900_000,
      keepRecentMessages: 80,
      keepRecentToolResults: 20,
      autoCompact: {
        enabled: true,
        triggerRatio: 0.8,
        maxFailures: 2,
      },
    })
  })

  it('合并用户字段', () => {
    const cfg = parseConfig({ agent: { name: 'custom', model: 'claude-sonnet-4-6' } })
    expect(cfg.agent.name).toBe('custom')
    expect(cfg.agent.model).toBe('claude-sonnet-4-6')
    expect(cfg.agent.maxSteps).toBe(DEFAULT_CONFIG.agent.maxSteps)
    expect(cfg.agent.context).toEqual(DEFAULT_CONFIG.agent.context)
  })

  it('合并 agent.context 用户字段', () => {
    const cfg = parseConfig({
      agent: {
        context: {
          maxApproxChars: 10_000,
          keepRecentMessages: 12,
          keepRecentToolResults: 3,
          autoCompact: {
            enabled: false,
            triggerRatio: 0.5,
            maxFailures: 4,
          },
        },
      },
    })
    expect(cfg.agent.context.maxApproxChars).toBe(10_000)
    expect(cfg.agent.context.keepRecentMessages).toBe(12)
    expect(cfg.agent.context.keepRecentToolResults).toBe(3)
    expect(cfg.agent.context.autoCompact).toEqual({
      enabled: false,
      triggerRatio: 0.5,
      maxFailures: 4,
    })
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

  it('agent.provider=openai-responses 解析合法且 responses 子字段取默认', () => {
    const cfg = parseConfig({ agent: { provider: 'openai-responses' } })
    expect(cfg.agent.provider).toBe('openai-responses')
    expect(cfg.agent.responses).toEqual({
      reasoningEffort: 'medium',
      reasoningSummary: 'auto',
    })
  })

  it('agent.responses 接受用户覆盖', () => {
    const cfg = parseConfig({
      agent: {
        provider: 'openai-responses',
        responses: { reasoningEffort: 'low', reasoningSummary: 'detailed' },
      },
    })
    expect(cfg.agent.responses.reasoningEffort).toBe('low')
    expect(cfg.agent.responses.reasoningSummary).toBe('detailed')
  })

  it('reasoningEffort 非法值报错', () => {
    expect(() => parseConfig({ agent: { responses: { reasoningEffort: 'extreme' } } })).toThrow()
  })

  it('agent.provider 非法值报错', () => {
    expect(() => parseConfig({ agent: { provider: 'openai' } })).toThrow()
  })
})
