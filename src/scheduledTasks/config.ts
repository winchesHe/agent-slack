import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { Cron } from 'croner'
import YAML from 'yaml'
import { z } from 'zod'
import { generateScheduledTasksYaml } from '@/workspace/templates/index.ts'

const idSchema = z
  .string()
  .min(1)
  .regex(/^[a-zA-Z0-9_-]+$/)

const SlackTargetSchema = z.object({
  im: z.literal('slack'),
  channelId: z
    .string()
    .regex(/^[CG][A-Z0-9]+$/, 'channelId 须以 C/G 开头（大写）'),
})

const WechatTargetSchema = z.object({
  im: z.literal('wechat'),
  to: z.string().min(1),
})

const TargetSchema = z.discriminatedUnion('im', [SlackTargetSchema, WechatTargetSchema])

export const ScheduledTaskRuleSchema = z.object({
  id: idSchema,
  enabled: z.boolean().default(true),
  description: z.string().optional(),
  cron: z
    .string()
    .min(1)
    .superRefine((value, ctx) => {
      try {
        // paused:true 让 croner 不真注册调度，避免 schema 阶段产生副作用。
        const c = new Cron(value, { paused: true })
        c.stop()
      } catch (e) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `非法 cron: ${(e as Error).message}`,
        })
      }
    }),
  timezone: z.string().optional(),
  prompt: z.string().trim().min(1),
  target: TargetSchema,
})

export const ScheduledTasksConfigSchema = z
  .object({
    version: z.literal(1).default(1),
    enabled: z.boolean().default(false),
    tasks: z.array(ScheduledTaskRuleSchema).default([]),
  })
  .superRefine((config, ctx) => {
    const seen = new Set<string>()
    for (const [index, task] of config.tasks.entries()) {
      if (seen.has(task.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['tasks', index, 'id'],
          message: `重复的任务 id：${task.id}`,
        })
      }
      seen.add(task.id)
    }
  })

export type ScheduledTasksConfig = z.infer<typeof ScheduledTasksConfigSchema>
export type ScheduledTaskRule = z.infer<typeof ScheduledTaskRuleSchema>

export function parseScheduledTasksConfig(raw: unknown): ScheduledTasksConfig {
  return ScheduledTasksConfigSchema.parse(raw)
}

export async function loadScheduledTasksConfigFile(
  file: string,
): Promise<ScheduledTasksConfig | undefined> {
  if (!existsSync(file)) return undefined
  return parseScheduledTasksConfig(YAML.parse(await readFile(file, 'utf8')))
}

// 模板从 `src/workspace/templates/scheduledTasks.ts` 生成；正文源在 `examples/scheduled-tasks.example.yaml`。
// dashboard / upgrade 都经 generator 取，杜绝多处漂移。
export const SCHEDULED_TASKS_CONFIG_TEMPLATE = generateScheduledTasksYaml({ mode: 'workspace' })
