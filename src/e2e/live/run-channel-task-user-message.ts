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
import { SlackApiClient } from './slack-api-client.ts'
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

interface ChannelTaskUserMessageResult {
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

async function main(): Promise<void> {
  const runId = randomUUID()
  const result: ChannelTaskUserMessageResult = {
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

  const triggerIdentity = await new SlackApiClient(
    requireEnv('SLACK_E2E_TRIGGER_USER_TOKEN'),
  ).authTest()
  const workspaceDir = await createChannelTaskWorkspace({
    channelId: requireEnv('SLACK_E2E_CHANNEL_ID'),
    runId,
    triggerUserId: triggerIdentity.user_id,
  })
  result.workspaceDir = workspaceDir

  let ctx: Awaited<ReturnType<typeof createLiveE2EContext>> | undefined
  let caughtError: unknown

  try {
    ctx = await createLiveE2EContext(runId, { workspaceDir })
    const activeCtx = ctx
    await activeCtx.application.start()
    await delay(3_000)

    const rootMessage = await activeCtx.triggerClient.postMessage({
      channel: activeCtx.channelId,
      text: [
        `CHANNEL_TASK_USER_TRIGGER ${runId}`,
        'This message intentionally does not mention the agent.',
      ].join('\n'),
      unfurl_links: false,
      unfurl_media: false,
    })
    result.rootMessageTs = rootMessage.ts

    await waitForThread(activeCtx, rootMessage.ts, async (messages) => {
      const reply = findReplyContaining(messages, rootMessage.ts, `CHANNEL_TASK_OK ${runId}`)
      result.matched.assistantReplied = Boolean(reply)
      result.matched.usageObserved = hasUsageMessage(messages, rootMessage.ts)
      result.matched.doneReactionObserved = await hasReaction(
        activeCtx.botClient,
        activeCtx.channelId,
        rootMessage.ts,
        'white_check_mark',
      )

      if (result.matched.assistantReplied) {
        const jsonl = await readSessionMessages(rootMessage.ts, { workspaceDir })
        result.matched.persistedWrappedInput =
          jsonl.includes('[频道任务触发: channel-task-user-message]') &&
          jsonl.includes(`CHANNEL_TASK_USER_TRIGGER ${runId}`)
        result.matched.persistedTriggerLedger = await hasTriggerLedgerRecord(
          workspaceDir,
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
    await writeScenarioResult('channel-task-user-message', result)
    consola.info('Live channel task user message E2E passed.')
  } catch (error) {
    result.failureMessage = error instanceof Error ? error.message : String(error)
    caughtError = error
  } finally {
    await writeScenarioResult('channel-task-user-message', result).catch((error) => {
      consola.error('Failed to persist result:', error)
    })
    if (ctx) {
      await ctx.application.stop().catch((error) => {
        consola.error('Failed to stop application:', error)
      })
    }
    await fs.rm(workspaceDir, { recursive: true, force: true }).catch((error) => {
      consola.error('Failed to remove temporary channel task workspace:', error)
    })
  }

  if (caughtError) {
    throw caughtError
  }
}

async function createChannelTaskWorkspace(args: {
  channelId: string
  runId: string
  triggerUserId: string
}): Promise<string> {
  const workspaceDir = await fs.mkdtemp(path.join(tmpdir(), 'agent-slack-channel-task-'))
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
        id: 'channel-task-user-message',
        enabled: true,
        channelIds: [args.channelId],
        source: {
          includeUserMessages: true,
          includeBotMessages: false,
          userIds: [args.triggerUserId],
          botIds: [],
          appIds: [],
        },
        message: {
          includeRootMessages: true,
          includeThreadReplies: false,
          allowSubtypes: ['none'],
          requireText: true,
          ignoreAgentMentions: true,
        },
        task: {
          prompt: [
            `请只回复：CHANNEL_TASK_OK ${args.runId}`,
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
      return record.ruleId === 'channel-task-user-message' && record.messageTs === messageTs
    })
}

function assertResult(result: ChannelTaskUserMessageResult): void {
  const failures: string[] = []
  if (!result.matched.assistantReplied) failures.push('assistant reply not observed')
  if (!result.matched.usageObserved) failures.push('usage message not observed')
  if (!result.matched.doneReactionObserved) failures.push('done reaction not observed')
  if (!result.matched.persistedWrappedInput)
    failures.push('wrapped channel task input not persisted')
  if (!result.matched.persistedTriggerLedger) failures.push('trigger ledger record not persisted')

  if (failures.length > 0) {
    throw new Error(`Live channel task user message E2E failed: ${failures.join('; ')}`)
  }
}

export const scenario: LiveE2EScenario = {
  id: 'channel-task-user-message',
  title: 'Channel Task User Message',
  description: 'Post a non-mention user message and verify channel task replies in its thread.',
  keywords: ['channel-task', 'message', 'user', 'thread'],
  run: main,
}

runDirectly(scenario)
