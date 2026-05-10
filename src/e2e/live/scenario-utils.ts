import fs from 'node:fs/promises'
import path from 'node:path'
import { createApplication } from '@/application/createApplication.ts'
import type { Application } from '@/application/types.ts'
import { resolveWorkspacePaths } from '@/workspace/paths.ts'
import { SlackApiClient, type SlackConversationRepliesResponse } from './slack-api-client.ts'

export interface LiveE2EContext {
  application: Application
  botClient: SlackApiClient
  botUserId: string
  channelId: string
  runId: string
  timeoutMs: number
  triggerClient: SlackApiClient
}

export type SlackThreadMessage = NonNullable<SlackConversationRepliesResponse['messages']>[number]

export async function createLiveE2EContext(
  runId: string,
  options: { workspaceDir?: string } = {},
): Promise<LiveE2EContext> {
  const channelId = requireEnv('SLACK_E2E_CHANNEL_ID')
  const triggerClient = new SlackApiClient(requireEnv('SLACK_E2E_TRIGGER_USER_TOKEN'))
  const botClient = new SlackApiClient(requireEnv('SLACK_BOT_TOKEN'))
  const botIdentity = await botClient.authTest()
  const application = await createApplication({
    workspaceDir: options.workspaceDir ?? process.cwd(),
  })

  return {
    application,
    botClient,
    botUserId: botIdentity.user_id,
    channelId,
    runId,
    timeoutMs: parseTimeoutMs(process.env.SLACK_E2E_TIMEOUT_MS),
    triggerClient,
  }
}

export async function waitForThread(
  ctx: LiveE2EContext,
  rootMessageTs: string,
  inspect: (messages: SlackThreadMessage[]) => boolean | Promise<boolean>,
): Promise<void> {
  const deadline = Date.now() + ctx.timeoutMs
  while (Date.now() < deadline) {
    const replies = await ctx.botClient.conversationReplies({
      channel: ctx.channelId,
      inclusive: true,
      limit: 50,
      ts: rootMessageTs,
    })

    if (await inspect(replies.messages ?? [])) {
      return
    }

    await delay(2_500)
  }
}

export function findReplyContaining(
  messages: SlackThreadMessage[],
  rootMessageTs: string,
  text: string,
  botUserId: string,
): SlackThreadMessage | undefined {
  return messages.find((message) => {
    if (!message.ts || message.ts === rootMessageTs || typeof message.text !== 'string') {
      return false
    }
    if (message.user !== botUserId) {
      return false
    }
    return message.text.includes(text)
  })
}

export function findUsageMessage(
  messages: SlackThreadMessage[],
  rootMessageTs: string,
  botUserId: string,
): SlackThreadMessage | undefined {
  const candidates = messages.filter((message) => {
    if (!message.ts || message.ts === rootMessageTs || typeof message.text !== 'string') {
      return false
    }
    if (message.user !== botUserId) {
      return false
    }
    return isUsageMessage(message)
  })

  return (
    [...candidates].reverse().find((message) => message.text?.includes(':agent_time:')) ??
    candidates.at(-1)
  )
}

export function hasUsageMessage(
  messages: SlackThreadMessage[],
  rootMessageTs: string,
  botUserId: string,
): boolean {
  return findUsageMessage(messages, rootMessageTs, botUserId) !== undefined
}

export function isUsageMessage(message: SlackThreadMessage): boolean {
  if (typeof message.text !== 'string') {
    return false
  }
  return (
    message.text.includes('tokens') &&
    (/^\d+\.\d+s\b/.test(message.text) || message.text.includes(':agent_time:'))
  )
}

export async function hasReaction(
  client: SlackApiClient,
  channelId: string,
  timestamp: string,
  name: string,
): Promise<boolean> {
  const response = await client.getReactions({ channel: channelId, timestamp })
  return Boolean(response.message?.reactions?.some((reaction) => reaction.name === name))
}

export async function readSessionMessages(
  threadTs: string,
  options: { workspaceDir?: string } = {},
): Promise<string> {
  const sessionDir = await findSessionDir(threadTs, options)
  return fs.readFile(path.join(sessionDir, 'messages.jsonl'), 'utf8')
}

export async function findSessionDir(
  threadTs: string,
  options: { workspaceDir?: string } = {},
): Promise<string> {
  const slackSessionsDir = path.join(
    resolveWorkspacePaths(options.workspaceDir ?? process.cwd()).sessionsDir,
    'slack',
  )
  const entries = await fs.readdir(slackSessionsDir, { withFileTypes: true })
  const match = entries.find((entry) => entry.isDirectory() && entry.name.endsWith(`.${threadTs}`))

  if (!match) {
    throw new Error(`未找到 Slack session: ${threadTs}`)
  }

  return path.join(slackSessionsDir, match.name)
}

/**
 * 删除指定 thread 对应的 Slack session 目录。
 * 用于 e2e scenario 在 finally 中调用，避免 workspace session 膨胀。
 *
 * 行为约定：
 * - threadTs 为 undefined（如早期失败未记录到 rootMessageTs）时直接返回。
 * - 找不到 session 目录（未生成或已清理）视为成功，不抛错。
 * - 设置 SLACK_E2E_KEEP_SESSION 为真值（1 / true / yes / on）时跳过清理，便于调试保留现场。
 */
export async function cleanupSlackSessionForThread(
  threadTs: string | undefined,
  options: { workspaceDir?: string } = {},
): Promise<void> {
  if (!threadTs) {
    return
  }
  if (isTruthyEnv(process.env.SLACK_E2E_KEEP_SESSION)) {
    return
  }

  let sessionDir: string
  try {
    sessionDir = await findSessionDir(threadTs, options)
  } catch {
    return
  }

  await fs.rm(sessionDir, { recursive: true, force: true })
}

function isTruthyEnv(value: string | undefined): boolean {
  if (!value) {
    return false
  }
  const normalized = value.trim().toLowerCase()
  return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on'
}

export async function writeScenarioResult(scenarioId: string, result: unknown): Promise<void> {
  const resultPath = process.env.SLACK_E2E_RESULT_PATH?.trim() || '.agent-slack/e2e/result.json'
  const absolutePath = path
    .resolve(process.cwd(), resultPath)
    .replace(/result\.json$/, `${scenarioId}-result.json`)
  await fs.mkdir(path.dirname(absolutePath), { recursive: true })
  await fs.writeFile(absolutePath, `${JSON.stringify(result, null, 2)}\n`, 'utf8')
}

/**
 * 把 workspace 的 logs/ 目录复制到 .agent-slack/e2e/logs/<scenarioId>-<runId>/，
 * 用于失败诊断。在 temp workspace 被 fs.rm 之前调用。同时会把当前 Slack thread
 * 全量 dump 成 thread-<rootMessageTs>.json，便于看 bot 实际回复了什么。
 *
 * 设计：仅复制 logs（含 agent-YYYY-MM-DD.log），不复制 sessions/jsonl 等大文件，
 * 避免 .agent-slack/e2e/ 体积失控。多次跑同一 scenario 会覆盖（按 runId 区分目录）。
 */
export async function preserveWorkspaceLogsForDebug(
  scenarioId: string,
  runId: string,
  workspaceDir: string,
  threadDump?: { ctx: LiveE2EContext; rootMessageTs: string },
): Promise<void> {
  const sourcePaths = resolveWorkspacePaths(workspaceDir)
  const sourceLogsDir = sourcePaths.logsDir
  const targetDir = path.resolve(
    process.cwd(),
    `.agent-slack/e2e/logs/${scenarioId}-${runId}`,
  )
  try {
    await fs.cp(sourceLogsDir, targetDir, { recursive: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error
    }
    // logs dir 还没生成（例如 application.start 失败前）——继续 dump thread
    await fs.mkdir(targetDir, { recursive: true })
  }

  if (threadDump) {
    try {
      const replies = await threadDump.ctx.botClient.conversationReplies({
        channel: threadDump.ctx.channelId,
        inclusive: true,
        limit: 100,
        ts: threadDump.rootMessageTs,
      })
      const dumpPath = path.join(targetDir, `thread-${threadDump.rootMessageTs}.json`)
      await fs.writeFile(
        dumpPath,
        `${JSON.stringify(replies.messages ?? [], null, 2)}\n`,
        'utf8',
      )
    } catch {
      // dump 失败不影响主流程
    }
  }
}

export function requireEnv(key: string): string {
  const value = process.env[key]?.trim()
  if (!value) {
    throw new Error(`缺少环境变量 ${key}`)
  }
  return value
}

export function parseTimeoutMs(value: string | undefined): number {
  const parsed = Number(value ?? '120000')
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`SLACK_E2E_TIMEOUT_MS 必须是正整数毫秒值，当前值：${value}`)
  }
  return Math.floor(parsed)
}

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}
