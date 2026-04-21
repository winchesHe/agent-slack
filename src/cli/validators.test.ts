import { describe, expect, it, vi } from 'vitest'
import { validateAnthropic, validateLiteLLM, validateSlack } from './validators.ts'

describe('validateLiteLLM', () => {
  it('200 → ok', async () => {
    const fetcher = vi.fn(async () => new Response('ok', { status: 200 }))
    const r = await validateLiteLLM({ baseUrl: 'http://x', apiKey: 'k', fetcher })
    expect(r.ok).toBe(true)
    expect(fetcher).toHaveBeenCalledOnce()
  })

  it('401 → reason 带状态码', async () => {
    const fetcher = vi.fn(async () => new Response('nope', { status: 401 }))
    const r = await validateLiteLLM({ baseUrl: 'http://x', apiKey: 'k', fetcher })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toMatch(/401/)
  })

  it('network 异常 → ok=false', async () => {
    const fetcher = vi.fn(async () => {
      throw new Error('ECONNREFUSED')
    })
    const r = await validateLiteLLM({ baseUrl: 'http://x', apiKey: 'k', fetcher })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toContain('ECONNREFUSED')
  })

  it('baseUrl 末尾斜杠被规范化', async () => {
    const fetcher = vi.fn(
      async (_url: string | URL, _init?: RequestInit) => new Response('ok', { status: 200 }),
    )
    await validateLiteLLM({
      baseUrl: 'http://x/',
      apiKey: 'k',
      fetcher: fetcher as unknown as typeof fetch,
    })
    expect(fetcher.mock.calls[0]![0]).toBe('http://x/models')
  })
})

describe('validateSlack', () => {
  it('auth.test 成功', async () => {
    const web = { auth: { test: async () => ({ ok: true, team: 'T1', user: 'U1' }) } }
    const r = await validateSlack({ webClientFactory: () => web, botToken: 'x' })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.team).toBe('T1')
      expect(r.user).toBe('U1')
    }
  })

  it('auth.test 抛错 → ok=false 带 reason', async () => {
    const web = {
      auth: {
        test: async () => {
          throw new Error('invalid_auth')
        },
      },
    }
    const r = await validateSlack({ webClientFactory: () => web, botToken: 'x' })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toContain('invalid_auth')
  })

  it('auth.test 返回 ok=false → 使用 error 字段', async () => {
    const web = { auth: { test: async () => ({ ok: false, error: 'token_revoked' }) } }
    const r = await validateSlack({ webClientFactory: () => web, botToken: 'x' })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('token_revoked')
  })
})

describe('validateAnthropic', () => {
  it('sk-ant- 开头 → ok', async () => {
    const r = await validateAnthropic({ apiKey: 'sk-ant-abc123' })
    expect(r.ok).toBe(true)
  })

  it('非法前缀 → ok=false', async () => {
    const r = await validateAnthropic({ apiKey: 'sk-proj-xxx' })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toMatch(/sk-ant-/)
  })

  it('空串 → ok=false', async () => {
    const r = await validateAnthropic({ apiKey: '   ' })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toMatch(/不能为空/)
  })
})
