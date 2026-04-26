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
): SlackThreadMessage | undefined {
  return messages.find((message) => {
    if (!message.ts || message.ts === rootMessageTs || typeof message.text !== 'string') {
      return false
    }
    return message.text.includes(text)
  })
}

export function findUsageMessage(
  messages: SlackThreadMessage[],
  rootMessageTs: string,
): SlackThreadMessage | undefined {
  const candidates = messages.filter((message) => {
    if (!message.ts || message.ts === rootMessageTs || typeof message.text !== 'string') {
      return false
    }
    return isUsageMessage(message)
  })

  return (
    [...candidates].reverse().find((message) => message.text?.includes(':agent_time:')) ??
    candidates.at(-1)
  )
}

export function hasUsageMessage(messages: SlackThreadMessage[], rootMessageTs: string): boolean {
  return findUsageMessage(messages, rootMessageTs) !== undefined
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

export async function writeScenarioResult(scenarioId: string, result: unknown): Promise<void> {
  const resultPath = process.env.SLACK_E2E_RESULT_PATH?.trim() || '.agent-slack/e2e/result.json'
  const absolutePath = path
    .resolve(process.cwd(), resultPath)
    .replace(/result\.json$/, `${scenarioId}-result.json`)
  await fs.mkdir(path.dirname(absolutePath), { recursive: true })
  await fs.writeFile(absolutePath, `${JSON.stringify(result, null, 2)}\n`, 'utf8')
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
