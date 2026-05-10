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
  findSessionDir,
  preserveWorkspaceLogsForDebug,
  waitForThread,
  writeScenarioResult,
} from './scenario-utils.ts'

interface NoReworkResult {
  failureMessage?: string
  matched: {
    seedReplyObserved: boolean
    fixtureInjected: boolean
    firstTriggerReplyObserved: boolean
    firstCompactSucceeded: boolean
    secondTriggerReplyObserved: boolean
    /** 第二轮 trigger 后 events.jsonl 中 compact_attempt 仍只有 1 条 */
    noSecondCompactAttempt: boolean
  }
  passed: boolean
  rootMessageTs?: string
  firstTriggerTs?: string
  secondTriggerTs?: string
  attemptCountAfterSecondTurn?: number
  runId: string
  workspaceDir?: string
}

const FIXTURE_PATH = path.join(
  process.cwd(),
  'tests',
  'fixtures',
  'compact',
  'large-history-1m.jsonl',
)

async function main(): Promise<void> {
  const runId = randomUUID()
  const result: NoReworkResult = {
    matched: {
      seedReplyObserved: false,
      fixtureInjected: false,
      firstTriggerReplyObserved: false,
      firstCompactSucceeded: false,
      secondTriggerReplyObserved: false,
      noSecondCompactAttempt: false,
    },
    passed: false,
    runId,
  }
  const workspaceDir = await createWorkspace()
  result.workspaceDir = workspaceDir

  let ctx: Awaited<ReturnType<typeof createLiveE2EContext>> | undefined
  let caughtError: unknown

  try {
    ctx = await createLiveE2EContext(runId, { workspaceDir })
    const botUserId = ctx.botUserId
    await ctx.application.start()
    await delay(3_000)

    // Step 1：seed → bot reply → session dir 创建
    const rootMessage = await ctx.triggerClient.postMessage({
      channel: ctx.channelId,
      text: [
        `<@${ctx.botUserId}> NO_REWORK_SEED ${runId}`,
        `Reply exactly: NO_REWORK_READY ${runId}`,
        'Do not use tools.',
      ].join('\n'),
      unfurl_links: false,
      unfurl_media: false,
    })
    result.rootMessageTs = rootMessage.ts

    await waitForThread(ctx, rootMessage.ts, (messages) => {
      const reply = findReplyContaining(
        messages,
        rootMessage.ts,
        `NO_REWORK_READY ${runId}`,
        botUserId,
      )
      result.matched.seedReplyObserved = Boolean(reply)
      return result.matched.seedReplyObserved
    })

    // Step 2：注入 1M fixture
    const sessionDir = await findSessionDir(rootMessage.ts, { workspaceDir })
    const messagesFile = path.join(sessionDir, 'messages.jsonl')
    const existing = await fs.readFile(messagesFile, 'utf8')
    const fixtureContent = await fs.readFile(FIXTURE_PATH, 'utf8')
    const existingLines = existing.split('\n').filter((l) => l.length > 0)
    const seedUser = existingLines[0] ?? ''
    const seedAssistant = existingLines.slice(1).join('\n')
    const fixtureBody = fixtureContent.endsWith('\n') ? fixtureContent : `${fixtureContent}\n`
    await fs.writeFile(
      messagesFile,
      `${seedUser}\n${fixtureBody}${seedAssistant}\n`,
      'utf8',
    )
    result.matched.fixtureInjected = true

    // Step 3：第一轮 trigger → 触发 compact
    const trigger1 = await ctx.triggerClient.postMessage({
      channel: ctx.channelId,
      thread_ts: rootMessage.ts,
      text: [
        `<@${ctx.botUserId}> NO_REWORK_GO_1 ${runId}`,
        `Reply exactly: NO_REWORK_DONE_1 ${runId}`,
        'Do not use tools.',
      ].join('\n'),
      unfurl_links: false,
      unfurl_media: false,
    })
    result.firstTriggerTs = trigger1.ts

    await waitForThread(ctx, rootMessage.ts, async (messages) => {
      const reply = findReplyContaining(
        messages,
        rootMessage.ts,
        `NO_REWORK_DONE_1 ${runId}`,
        botUserId,
      )
      result.matched.firstTriggerReplyObserved = Boolean(reply)
      if (!result.matched.firstTriggerReplyObserved) return false

      const events = await readEventsJsonl(rootMessage.ts, workspaceDir)
      result.matched.firstCompactSucceeded = events.some((e) => e.type === 'compact_succeeded')
      return result.matched.firstCompactSucceeded
    })

    // Step 4：第二轮 trigger（短消息）。compact 后 candidate ≈ boundary (~110 chars)
    // + 当前 trigger（~150 chars）≈ 260 chars，远低于 800K 阈值。不应再次 compact。
    const trigger2 = await ctx.triggerClient.postMessage({
      channel: ctx.channelId,
      thread_ts: rootMessage.ts,
      text: [
        `<@${ctx.botUserId}> NO_REWORK_GO_2 ${runId}`,
        `Reply exactly: NO_REWORK_DONE_2 ${runId}`,
        'Do not use tools.',
      ].join('\n'),
      unfurl_links: false,
      unfurl_media: false,
    })
    result.secondTriggerTs = trigger2.ts

    await waitForThread(ctx, rootMessage.ts, async (messages) => {
      const reply = findReplyContaining(
        messages,
        rootMessage.ts,
        `NO_REWORK_DONE_2 ${runId}`,
        botUserId,
      )
      result.matched.secondTriggerReplyObserved = Boolean(reply)
      if (!result.matched.secondTriggerReplyObserved) return false

      const events = await readEventsJsonl(rootMessage.ts, workspaceDir)
      const attempts = events.filter((e) => e.type === 'compact_attempt')
      result.attemptCountAfterSecondTurn = attempts.length
      result.matched.noSecondCompactAttempt = attempts.length === 1
      return result.matched.noSecondCompactAttempt
    })

    assertResult(result)
    result.passed = true
    await writeScenarioResult('auto-compact-no-rework', result)
    consola.info(
      `Auto compact no-rework: 1 attempt across 2 turns (attempts=${result.attemptCountAfterSecondTurn})`,
    )
  } catch (error) {
    result.failureMessage = error instanceof Error ? error.message : String(error)
    caughtError = error
  } finally {
    await writeScenarioResult('auto-compact-no-rework', result).catch((err) => {
      consola.error('Failed to persist result:', err)
    })
    if (ctx) {
      await ctx.application.stop().catch((err) => {
        consola.error('Failed to stop application:', err)
      })
    }
    if (!result.passed) {
      await preserveWorkspaceLogsForDebug(
        'auto-compact-no-rework',
        runId,
        workspaceDir,
        ctx && result.rootMessageTs
          ? { ctx, rootMessageTs: result.rootMessageTs }
          : undefined,
      ).catch((err) => consola.error('Failed to preserve workspace logs:', err))
    }
    await fs.rm(workspaceDir, { recursive: true, force: true }).catch((err) => {
      consola.error('Failed to remove temporary workspace:', err)
    })
  }

  if (caughtError) {
    throw caughtError
  }
}

async function createWorkspace(): Promise<string> {
  const workspaceDir = await fs.mkdtemp(path.join(tmpdir(), 'agent-slack-no-rework-'))
  const sourcePaths = resolveWorkspacePaths(process.cwd())
  const targetPaths = resolveWorkspacePaths(workspaceDir)
  await fs.mkdir(targetPaths.root, { recursive: true })

  const sourceConfig = existsSync(sourcePaths.configFile)
    ? YAML.parse(await fs.readFile(sourcePaths.configFile, 'utf8'))
    : {}
  const config = isRecord(sourceConfig) ? sourceConfig : {}
  const agent = isRecord(config.agent) ? config.agent : {}
  const context = isRecord(agent.context) ? agent.context : {}
  config.agent = {
    ...agent,
    context: {
      ...context,
      maxApproxChars: 1_000_000,
      keepRecentMessages: 80,
      keepRecentToolResults: 20,
      autoCompact: {
        enabled: true,
        triggerRatio: 0.8,
        maxFailures: 2,
      },
    },
  }
  await fs.writeFile(targetPaths.configFile, `${YAML.stringify(config)}\n`, 'utf8')
  if (existsSync(sourcePaths.systemFile)) {
    await fs.copyFile(sourcePaths.systemFile, targetPaths.systemFile)
  }
  return workspaceDir
}

async function readEventsJsonl(
  threadTs: string,
  workspaceDir: string,
): Promise<Array<{ type: string; [k: string]: unknown }>> {
  const sessionDir = await findSessionDir(threadTs, { workspaceDir })
  const file = path.join(sessionDir, 'events.jsonl')
  if (!existsSync(file)) return []
  const raw = await fs.readFile(file, 'utf8')
  return raw
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as { type: string; [k: string]: unknown })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function assertResult(result: NoReworkResult): void {
  const failures: string[] = []
  if (!result.matched.seedReplyObserved) failures.push('seed reply not observed')
  if (!result.matched.fixtureInjected) failures.push('fixture not injected')
  if (!result.matched.firstTriggerReplyObserved) failures.push('first trigger reply not observed')
  if (!result.matched.firstCompactSucceeded) {
    failures.push('first compact_succeeded event missing')
  }
  if (!result.matched.secondTriggerReplyObserved) {
    failures.push('second trigger reply not observed')
  }
  if (!result.matched.noSecondCompactAttempt) {
    failures.push(
      `expected exactly 1 compact_attempt across 2 turns, got ${result.attemptCountAfterSecondTurn}`,
    )
  }
  if (failures.length > 0) {
    throw new Error(`Live auto-compact-no-rework E2E failed: ${failures.join('; ')}`)
  }
}

export const scenario: LiveE2EScenario = {
  id: 'auto-compact-no-rework',
  title: 'Auto Compact No Rework',
  description:
    'After auto compact succeeds, send a small follow-up turn and verify no second compact_attempt is triggered.',
  keywords: ['compact', 'no-rework', 'idempotent'],
  run: main,
}

runDirectly(scenario)
