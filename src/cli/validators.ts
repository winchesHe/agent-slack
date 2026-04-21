// CLI 侧凭证/环境校验工具：Slack auth.test + LiteLLM /health
import { WebClient } from '@slack/web-api'

export type ValidationResult = { ok: true; [k: string]: unknown } | { ok: false; reason: string }

export interface ValidateLiteLLMArgs {
  baseUrl: string
  apiKey: string
  fetcher?: typeof fetch
}

export async function validateLiteLLM(args: ValidateLiteLLMArgs): Promise<ValidationResult> {
  const f = args.fetcher ?? fetch
  try {
    const res = await f(`${args.baseUrl.replace(/\/$/, '')}/models`, {
      headers: { Authorization: `Bearer ${args.apiKey}` },
    })
    if (res.status >= 200 && res.status < 300) return { ok: true }
    return { ok: false, reason: `HTTP ${res.status}` }
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) }
  }
}

// WebClient 仅用其 auth.test 子接口，使用最小结构类型方便 mock
export interface AuthTestClient {
  auth: { test: () => Promise<{ ok?: boolean; team?: string; user?: string; error?: string }> }
}

export interface ValidateSlackArgs {
  botToken: string
  webClientFactory?: (token: string) => AuthTestClient
}

export async function validateSlack(args: ValidateSlackArgs): Promise<ValidationResult> {
  const factory =
    args.webClientFactory ?? ((t: string) => new WebClient(t) as unknown as AuthTestClient)
  try {
    const web = factory(args.botToken)
    const r = await web.auth.test()
    if (r.ok) return { ok: true, team: r.team, user: r.user }
    return { ok: false, reason: r.error ?? 'auth.test returned ok=false' }
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) }
  }
}
