import './load-e2e-env.ts'

import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import YAML from 'yaml'
import { consola } from 'consola'
import { resolveWorkspacePaths } from '@/workspace/paths.ts'
import type { LiveE2EScenario } from './scenario.ts'
import { runDirectly } from './scenario.ts'
import {
  createLiveE2EContext,
  delay,
  findReplyContaining,
  hasReaction,
  hasUsageMessage,
  readSessionMessages,
  requireEnv,
  waitForThread,
  writeScenarioResult,
} from './scenario-utils.ts'
import type { SlackApiClient } from './slack-api-client.ts'

interface ChannelTaskBotMessageResult {
  botSource?: {
    appId?: string
    botId?: string
  }
  failureMessage?: string
  matched: {
    assistantReplied: boolean
    doneReactionObserved: boolean
    persistedTriggerLedger: boolean
    persistedWrappedInput: boolean
    usageObserved: boolean
  }
  passed: boolean
  rootMessageTs?: string
  runId: string
  workspaceDir?: string
}

interface BotSource {
  appId?: string
  botId?: string
}

async function main(): Promise<void> {
  const runId = randomUUID()
  const result: ChannelTaskBotMessageResult = {
    matched: {
      assistantReplied: false,
      doneReactionObserved: false,
      persistedTriggerLedger: false,
      persistedWrappedInput: false,
      usageObserved: false,
    },
    passed: false,
    runId,
  }

  let ctx: Awaited<ReturnType<typeof createLiveE2EContext>> | undefined
  let workspaceDir: string | undefined
  let caughtError: unknown

  try {
    ctx = await createLiveE2EContext(runId)
    const botSource = await resolveCurrentBotSource(ctx.botClient, ctx.channelId, runId)
    result.botSource = botSource
    workspaceDir = await createChannelTaskWorkspace({
      botSource,
      channelId: ctx.channelId,
      runId,
    })
    const activeWorkspaceDir = workspaceDir
    result.workspaceDir = workspaceDir

    ctx = await createLiveE2EContext(runId, { workspaceDir })
    const activeCtx = ctx
    await activeCtx.application.start()
    await delay(3_000)

    const rootMessage = await activeCtx.botClient.postMessage({
      channel: activeCtx.channelId,
      text: [
        `CHANNEL_TASK_BOT_TRIGGER ${runId}`,
        'This bot message intentionally does not mention the agent.',
      ].join('\n'),
      unfurl_links: false,
      unfurl_media: false,
    })
    result.rootMessageTs = rootMessage.ts

    await waitForThread(activeCtx, rootMessage.ts, async (messages) => {
      const reply = findReplyContaining(messages, rootMessage.ts, `CHANNEL_TASK_BOT_OK ${runId}`)
      result.matched.assistantReplied = Boolean(reply)
      result.matched.usageObserved = hasUsageMessage(messages, rootMessage.ts)
      result.matched.doneReactionObserved = await hasReaction(
        activeCtx.botClient,
        activeCtx.channelId,
        rootMessage.ts,
        'white_check_mark',
      )

      if (result.matched.assistantReplied) {
        const jsonl = await readSessionMessages(rootMessage.ts, {
          workspaceDir: activeWorkspaceDir,
        })
        result.matched.persistedWrappedInput =
          jsonl.includes('[频道任务触发: channel-task-bot-message]') &&
          jsonl.includes(`CHANNEL_TASK_BOT_TRIGGER ${runId}`)
        result.matched.persistedTriggerLedger = await hasTriggerLedgerRecord(
          activeWorkspaceDir,
          rootMessage.ts,
        )
      }

      return (
        result.matched.assistantReplied &&
        result.matched.usageObserved &&
        result.matched.doneReactionObserved &&
        result.matched.persistedWrappedInput &&
        result.matched.persistedTriggerLedger
      )
    })

    assertResult(result)
    result.passed = true
    await writeScenarioResult('channel-task-bot-message', result)
    consola.info('Live channel task bot message E2E passed.')
  } catch (error) {
    result.failureMessage = error instanceof Error ? error.message : String(error)
    caughtError = error
  } finally {
    await writeScenarioResult('channel-task-bot-message', result).catch((error) => {
      consola.error('Failed to persist result:', error)
    })
    if (ctx) {
      await ctx.application.stop().catch((error) => {
        consola.error('Failed to stop application:', error)
      })
    }
    if (workspaceDir) {
      await fs.rm(workspaceDir, { recursive: true, force: true }).catch((error) => {
        consola.error('Failed to remove temporary channel task workspace:', error)
      })
    }
  }

  if (caughtError) {
    throw caughtError
  }
}

async function resolveCurrentBotSource(
  botClient: SlackApiClient,
  channelId: string,
  runId: string,
): Promise<BotSource> {
  const probe = await botClient.postMessage({
    channel: channelId,
    text: `CHANNEL_TASK_BOT_SOURCE_PROBE ${runId}`,
    unfurl_links: false,
    unfurl_media: false,
  })
  const source: BotSource = {
    ...(probe.message?.app_id ? { appId: probe.message.app_id } : {}),
    ...(probe.message?.bot_id ? { botId: probe.message.bot_id } : {}),
  }
  if (source.botId || source.appId) return source

  const replies = await botClient.conversationReplies({
    channel: channelId,
    inclusive: true,
    limit: 1,
    ts: probe.ts,
  })
  const message = replies.messages?.find((item) => item.ts === probe.ts)
  const resolved: BotSource = {
    ...(message?.app_id ? { appId: message.app_id } : {}),
    ...(message?.bot_id ? { botId: message.bot_id } : {}),
  }
  if (resolved.botId || resolved.appId) return resolved

  throw new Error('无法解析当前 Slack bot 的 bot_id 或 app_id，无法构造 bot message allowlist')
}

async function createChannelTaskWorkspace(args: {
  botSource: BotSource
  channelId: string
  runId: string
}): Promise<string> {
  const workspaceDir = await fs.mkdtemp(path.join(tmpdir(), 'agent-slack-channel-task-bot-'))
  const sourcePaths = resolveWorkspacePaths(process.cwd())
  const targetPaths = resolveWorkspacePaths(workspaceDir)
  await fs.mkdir(targetPaths.root, { recursive: true })

  if (existsSync(sourcePaths.configFile)) {
    await fs.copyFile(sourcePaths.configFile, targetPaths.configFile)
  }
  if (existsSync(sourcePaths.systemFile)) {
    await fs.copyFile(sourcePaths.systemFile, targetPaths.systemFile)
  }

  const channelTasks = {
    version: 1,
    enabled: true,
    rules: [
      {
        id: 'channel-task-bot-message',
        enabled: true,
        channelIds: [args.channelId],
        source: {
          includeUserMessages: false,
          includeBotMessages: true,
          userIds: [],
          botIds: args.botSource.botId ? [args.botSource.botId] : [],
          appIds: args.botSource.appId ? [args.botSource.appId] : [],
        },
        message: {
          includeRootMessages: true,
          includeThreadReplies: false,
          allowSubtypes: ['bot_message'],
          requireText: true,
          ignoreAgentMentions: true,
        },
        match: {
          containsAny: [`CHANNEL_TASK_BOT_TRIGGER ${args.runId}`],
          regexAny: [],
        },
        task: {
          prompt: [
            `请只回复：CHANNEL_TASK_BOT_OK ${args.runId}`,
            '不要调用工具，不要添加其他文字。',
          ].join('\n'),
          includeOriginalMessage: true,
          includePermalink: true,
        },
        reply: { inThread: true },
        dedupe: { enabled: true },
      },
    ],
  }
  await fs.writeFile(targetPaths.channelTasksFile, `${YAML.stringify(channelTasks)}\n`, 'utf8')

  return workspaceDir
}

async function hasTriggerLedgerRecord(workspaceDir: string, messageTs: string): Promise<boolean> {
  const file = resolveWorkspacePaths(workspaceDir).channelTaskTriggersFile
  if (!existsSync(file)) return false
  const raw = await fs.readFile(file, 'utf8')
  return raw
    .split('\n')
    .filter((line) => line.length > 0)
    .some((line) => {
      const record = JSON.parse(line) as { messageTs?: string; ruleId?: string }
      return record.ruleId === 'channel-task-bot-message' && record.messageTs === messageTs
    })
}

function assertResult(result: ChannelTaskBotMessageResult): void {
  const failures: string[] = []
  if (!result.matched.assistantReplied) failures.push('assistant reply not observed')
  if (!result.matched.usageObserved) failures.push('usage message not observed')
  if (!result.matched.doneReactionObserved) failures.push('done reaction not observed')
  if (!result.matched.persistedWrappedInput)
    failures.push('wrapped channel task input not persisted')
  if (!result.matched.persistedTriggerLedger) failures.push('trigger ledger record not persisted')

  if (failures.length > 0) {
    throw new Error(`Live channel task bot message E2E failed: ${failures.join('; ')}`)
  }
}

export const scenario: LiveE2EScenario = {
  id: 'channel-task-bot-message',
  title: 'Channel Task Bot Message',
  description: 'Post a self bot message and verify channel task replies in its thread.',
  keywords: ['channel-task', 'message', 'bot', 'thread'],
  run: main,
}

runDirectly(scenario)
