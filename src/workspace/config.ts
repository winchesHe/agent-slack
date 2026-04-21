import { z } from 'zod'

export const ConfigSchema = z.object({
  agent: z
    .object({
      name: z.string().default('default'),
      model: z.string().default(process.env.AGENT_MODEL ?? 'gpt-5.4'),
      maxSteps: z.number().int().positive().default(20),
    })
    .default({}),
  skills: z.object({ enabled: z.array(z.string()).default(['*']) }).default({}),
  im: z
    .object({
      provider: z.literal('slack').default('slack'),
      slack: z.object({ resolveChannelName: z.boolean().default(true) }).default({}),
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
