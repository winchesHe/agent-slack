import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { z } from 'zod'
import YAML from 'yaml'
import { generateChannelTasksYaml } from '@/workspace/templates/index.ts'

const idSchema = z
  .string()
  .min(1)
  .regex(/^[a-zA-Z0-9_-]+$/)
const idArraySchema = z.array(z.string().min(1)).default([])

const SourceSchema = z
  .object({
    includeUserMessages: z.boolean().default(true),
    includeBotMessages: z.boolean().default(false),
    userIds: idArraySchema,
    botIds: idArraySchema,
    appIds: idArraySchema,
  })
  .default({})

const MessageSchema = z
  .object({
    includeRootMessages: z.boolean().default(true),
    includeThreadReplies: z.boolean().default(false),
    allowSubtypes: z.array(z.enum(['none', 'bot_message'])).default(['none']),
    requireText: z.boolean().default(true),
    ignoreAgentMentions: z.boolean().default(true),
  })
  .default({})

const MatchSchema = z
  .object({
    containsAny: z.array(z.string().min(1)).default([]),
    regexAny: z.array(z.string().min(1)).default([]),
  })
  .default({})

const TaskSchema = z.object({
  prompt: z.string().trim().min(1),
  includeOriginalMessage: z.boolean().default(true),
  includePermalink: z.boolean().default(true),
})

const ReplySchema = z
  .object({
    inThread: z.literal(true).default(true),
  })
  .default({})

const DedupeSchema = z
  .object({
    enabled: z.boolean().default(true),
  })
  .default({})

export const ChannelTaskRuleSchema = z
  .object({
    id: idSchema,
    enabled: z.boolean().default(true),
    description: z.string().optional(),
    channelIds: idArraySchema,
    source: SourceSchema,
    message: MessageSchema,
    match: MatchSchema,
    task: TaskSchema,
    reply: ReplySchema,
    dedupe: DedupeSchema,
  })
  .superRefine((rule, ctx) => {
    if (!rule.enabled) return

    if (rule.channelIds.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['channelIds'],
        message: '启用的规则必须至少配置一个 channelId',
      })
    }

    const canMatchUser = rule.source.includeUserMessages && rule.source.userIds.length > 0
    const canMatchBot =
      rule.source.includeBotMessages &&
      (rule.source.botIds.length > 0 || rule.source.appIds.length > 0)

    if (!canMatchUser && !canMatchBot) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['source'],
        message: '启用的规则必须至少配置一个可匹配的 userIds、botIds 或 appIds',
      })
    }

    for (const [index, pattern] of rule.match.regexAny.entries()) {
      try {
        new RegExp(pattern)
      } catch {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['match', 'regexAny', index],
          message: `非法正则表达式：${pattern}`,
        })
      }
    }
  })

export const ChannelTasksConfigSchema = z
  .object({
    version: z.literal(1).default(1),
    enabled: z.boolean().default(false),
    rules: z.array(ChannelTaskRuleSchema).default([]),
  })
  .superRefine((config, ctx) => {
    const seen = new Set<string>()
    for (const [index, rule] of config.rules.entries()) {
      if (seen.has(rule.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['rules', index, 'id'],
          message: `重复的规则 id：${rule.id}`,
        })
      }
      seen.add(rule.id)
    }
  })

export type ChannelTasksConfig = z.infer<typeof ChannelTasksConfigSchema>
export type ChannelTaskRule = z.infer<typeof ChannelTaskRuleSchema>
export type ChannelTaskMessageSubtype = ChannelTaskRule['message']['allowSubtypes'][number]

export function parseChannelTasksConfig(raw: unknown): ChannelTasksConfig {
  return ChannelTasksConfigSchema.parse(raw)
}

export async function loadChannelTasksConfigFile(
  configFile: string,
): Promise<ChannelTasksConfig | undefined> {
  if (!existsSync(configFile)) return undefined
  return parseChannelTasksConfig(YAML.parse(await readFile(configFile, 'utf8')))
}

// 模板从 `src/workspace/templates/channelTasks.ts` 单一权威生成（含两个示例规则）。
// 历史上这里曾内联一份单规则模板，与根目录 channel-tasks.example.yaml 不同步；
// 现已废弃内联模板，dashboard/upgrade 都从 generator 取，杜绝两份漂移。
export const CHANNEL_TASKS_CONFIG_TEMPLATE = generateChannelTasksYaml({ mode: 'workspace' })
