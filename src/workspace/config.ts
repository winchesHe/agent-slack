import { z } from 'zod'

export const ConfigSchema = z.object({
  agent: z
    .object({
      name: z.string().default('default'),
      model: z.string().default('gpt-5.4'),
      maxSteps: z.number().int().positive().default(50),
      // provider 为唯一权威来源（env 不参与），默认 litellm
      provider: z.enum(['litellm', 'anthropic', 'openai-responses']).default('litellm'),
      // provider='openai-responses' 时实际生效；其他 provider 装配代码不读，但允许写在 yaml 里。
      responses: z
        .object({
          reasoningEffort: z.enum(['low', 'medium', 'high']).default('medium'),
          reasoningSummary: z.enum(['auto', 'concise', 'detailed']).default('auto'),
        })
        .default({}),
      context: z
        .object({
          // 只限制发给模型的历史视图，不裁剪 messages.jsonl。
          // 单位: 字符数 (JSON.stringify(messages).length)，约 3 字符 ≈ 1 token。
          // 默认 900_000 字符 ≈ 300k tokens，匹配 400k token 上下文窗口（GPT-5 长窗口 / 部分 LiteLLM 路由）。
          // 200k 窗口模型建议改为 500_000~600_000；1M 窗口可设 2_000_000+。
          maxApproxChars: z.number().int().positive().default(900_000),
          keepRecentMessages: z.number().int().positive().default(80),
          keepRecentToolResults: z.number().int().positive().default(20),
          autoCompact: z
            .object({
              enabled: z.boolean().default(true),
              triggerRatio: z.number().positive().max(1).default(0.8),
              maxFailures: z.number().int().positive().default(2),
            })
            .default({}),
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
