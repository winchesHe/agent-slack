import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { z } from 'zod'
import YAML from 'yaml'

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

export const CHANNEL_TASKS_CONFIG_TEMPLATE = `# Slack 频道任务监听配置。
# 文件缺失时该功能关闭；enabled=false 时即使配置了规则也不会监听执行。
version: 1
enabled: false

# rules 是一组独立触发规则；同一条 Slack 消息可能命中多条规则。
rules:
  - id: example-channel-task
    # 当前规则开关；可临时关闭某条规则而不删除配置。
    enabled: false

    # 人类可读说明，仅用于 dashboard 展示和审计日志。
    description: 示例：监听指定频道里某个用户或 bot 的消息，并让 agent 总结处理

    # 监听的 Slack channel ID 列表。建议使用 C/G 开头的 channel ID，不建议使用频道名。
    channelIds: [C0123456789]

    # 消息来源匹配。三个 ID 字段都是数组；只会匹配显式列出的来源。
    # userIds 匹配普通用户或 bot user ID；botIds/appIds 匹配 subtype=bot_message 的消息。
    source:
      # 是否允许普通 user message（Slack event 通常没有 subtype，带 user 字段）。
      includeUserMessages: true
      # 是否允许“由 bot 发送”的消息（Slack event 通常 subtype=bot_message，带 bot_id/app_id）。
      includeBotMessages: false
      # 允许的 Slack user ID。为空表示不按 user ID 放行；生产建议显式填写。
      userIds: [U0123456789]
      # 允许的 Slack bot ID。需要匹配 bot_message 时填写。
      botIds: []
      # 允许的 Slack app ID。某些 bot 消息更适合按 app_id 匹配。
      appIds: []

    # 消息范围。默认只处理频道根消息；打开 includeThreadReplies 后也会处理 thread 回复。
    message:
      includeRootMessages: true
      includeThreadReplies: false
      # 默认忽略编辑/删除/join/leave 等非新文本消息；需要 bot_message 时把 bot_message 加入 allowSubtypes。
      allowSubtypes: [none]
      # 是否要求存在 text。若未来要处理文件/附件，可设为 false 并扩展 renderer/input builder。
      requireText: true
      # 默认忽略“内容里 @当前 agent”的消息，避免和 app_mention 入口重复执行；这和 includeBotMessages 不是同一概念。
      ignoreAgentMentions: true

    # 可选文本过滤。不配置时，只要频道、来源、消息范围命中就触发。
    match:
      containsAny: []
      regexAny: []

    # 命中后交给主 agent 的固定任务。运行时会把原始 Slack 消息追加到该 prompt 后。
    task:
      prompt: |
        请阅读触发消息，判断是否需要执行后续处理，并给出简洁结论。
      includeOriginalMessage: true
      includePermalink: true

    # 回复策略。本阶段固定为 true：始终在触发消息所属 thread 中回复。
    reply:
      inThread: true

    # 去重策略。默认开启，避免 Slack 重试或进程重连导致重复执行。
    dedupe:
      enabled: true
`
