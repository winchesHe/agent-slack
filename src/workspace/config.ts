import { z } from 'zod'

export const ConfigSchema = z.object({
  agent: z
    .object({
      name: z.string().default('default'),
      model: z.string().default('gpt-5.4'),
      maxSteps: z.number().int().positive().default(50),
      // provider 为唯一权威来源（env 不参与），默认 litellm
      provider: z.enum(['litellm', 'anthropic']).default('litellm'),
      context: z
        .object({
          // 只限制发给模型的历史视图，不裁剪 messages.jsonl。
          maxApproxChars: z.number().int().positive().default(120_000),
          keepRecentMessages: z.number().int().positive().default(80),
          keepRecentToolResults: z.number().int().positive().default(20),
        })
        .default({}),
    })
    .default({}),
  skills: z.object({ enabled: z.array(z.string()).default(['*']) }).default({}),
  im: z
    .object({
      provider: z.literal('slack').default('slack'),
      slack: z.object({ resolveChannelName: z.boolean().default(true) }).default({}),
    })
    .default({}),
  daemon: z
    .object({
      // daemon + dashboard 共用的 HTTP 端口（127.0.0.1 固定监听）
      port: z.number().int().min(0).max(65535).default(51732),
      host: z.string().default('127.0.0.1'),
    })
    .default({}),
})

export type WorkspaceConfig = z.infer<typeof ConfigSchema>

export const DEFAULT_CONFIG: WorkspaceConfig = ConfigSchema.parse({})

export function parseConfig(raw: unknown): WorkspaceConfig {
  return ConfigSchema.parse(raw)
}

export function isRenderDebugEnabled(): boolean {
  return process.env.SLACK_RENDER_DEBUG === '1'
}
