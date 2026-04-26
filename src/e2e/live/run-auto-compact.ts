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
  readSessionMessages,
  waitForThread,
  writeScenarioResult,
} from './scenario-utils.ts'

interface AutoCompactResult {
  failureMessage?: string
  matched: {
    autoCompactNotVisibleAsReply: boolean
    autoCompactActivityObserved: boolean
    autoCompactStateReset: boolean
    mainReplyContinued: boolean
    persistedAutoCompactSummary: boolean
    persistedStructuredCompactMarker: boolean
    sessionIdle: boolean
    seedReplyObserved: boolean
  }
  passed: boolean
  rootMessageTs?: string
  runId: string
  secondMessageTs?: string
  workspaceDir?: string
}

async function main(): Promise<void> {
  const runId = randomUUID()
  const result: AutoCompactResult = {
    matched: {
      autoCompactNotVisibleAsReply: false,
      autoCompactActivityObserved: false,
      autoCompactStateReset: false,
      mainReplyContinued: false,
      persistedAutoCompactSummary: false,
      persistedStructuredCompactMarker: false,
      sessionIdle: false,
      seedReplyObserved: false,
    },
    passed: false,
    runId,
  }
  const workspaceDir = await createAutoCompactWorkspace()
  result.workspaceDir = workspaceDir

  let ctx: Awaited<ReturnType<typeof createLiveE2EContext>> | undefined
  let caughtError: unknown

  try {
    ctx = await createLiveE2EContext(runId, { workspaceDir })
    await ctx.application.start()
    await delay(3_000)

    const rootMessage = await ctx.triggerClient.postMessage({
      channel: ctx.channelId,
      text: [
        `<@${ctx.botUserId}> AUTO_COMPACT_SEED ${runId}`,
        `Reply exactly: AUTO_COMPACT_READY ${runId}`,
        'Do not use tools.',
      ].join('\n'),
      unfurl_links: false,
      unfurl_media: false,
    })
    result.rootMessageTs = rootMessage.ts

    await waitForThread(ctx, rootMessage.ts, (messages) => {
      const reply = findReplyContaining(messages, rootMessage.ts, `AUTO_COMPACT_READY ${runId}`)
      result.matched.seedReplyObserved = Boolean(reply)
      return result.matched.seedReplyObserved
    })

    const secondMessage = await ctx.triggerClient.postMessage({
      channel: ctx.channelId,
      thread_ts: rootMessage.ts,
      text: [
        `<@${ctx.botUserId}> AUTO_COMPACT_TRIGGER ${runId}`,
        `AUTO_COMPACT_FILLER ${'x'.repeat(1_200)}`,
        `Reply exactly: AUTO_COMPACT_OK ${runId}`,
        'Do not use tools.',
      ].join('\n'),
      unfurl_links: false,
      unfurl_media: false,
    })
    result.secondMessageTs = secondMessage.ts

    await waitForThread(ctx, rootMessage.ts, async (messages) => {
      result.matched.autoCompactActivityObserved ||= messages.some((message) =>
        message.text?.includes('正在整理上下文'),
      )

      const reply = findReplyContaining(messages, rootMessage.ts, `AUTO_COMPACT_OK ${runId}`)
      result.matched.mainReplyContinued = Boolean(reply)
      result.matched.autoCompactNotVisibleAsReply = !messages.some((message) =>
        message.text?.includes('[compact: auto]'),
      )

      if (result.matched.mainReplyContinued) {
        const jsonl = await readSessionMessages(rootMessage.ts, { workspaceDir })
        result.matched.persistedAutoCompactSummary =
          jsonl.includes('[compact: auto]') && jsonl.includes(`AUTO_COMPACT_TRIGGER ${runId}`)
        const compactRecords = await readCompactRecords(rootMessage.ts, workspaceDir)
        result.matched.persistedStructuredCompactMarker = compactRecords.some(
          (record) => record.mode === 'auto' && typeof record.messageId === 'string',
        )

        const meta = await readSessionMeta(rootMessage.ts, workspaceDir)
        result.matched.autoCompactStateReset =
          meta.context?.autoCompact?.failureCount === 0 &&
          meta.context?.autoCompact?.breakerOpen === false
        result.matched.sessionIdle = meta.status === 'idle'
      }

      return (
        result.matched.mainReplyContinued &&
        result.matched.autoCompactNotVisibleAsReply &&
        result.matched.autoCompactActivityObserved &&
        result.matched.persistedAutoCompactSummary &&
        result.matched.persistedStructuredCompactMarker &&
        result.matched.autoCompactStateReset &&
        result.matched.sessionIdle
      )
    })

    assertResult(result)
    result.passed = true
    await writeScenarioResult('auto-compact', result)
    consola.info('Live auto compact E2E passed.')
  } catch (error) {
    result.failureMessage = error instanceof Error ? error.message : String(error)
    caughtError = error
  } finally {
    await writeScenarioResult('auto-compact', result).catch((error) => {
      consola.error('Failed to persist result:', error)
    })
    if (ctx) {
      await ctx.application.stop().catch((error) => {
        consola.error('Failed to stop application:', error)
      })
    }
    await fs.rm(workspaceDir, { recursive: true, force: true }).catch((error) => {
      consola.error('Failed to remove temporary auto compact workspace:', error)
    })
  }

  if (caughtError) {
    throw caughtError
  }
}

async function createAutoCompactWorkspace(): Promise<string> {
  const workspaceDir = await fs.mkdtemp(path.join(tmpdir(), 'agent-slack-auto-compact-'))
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
      maxApproxChars: 1_000,
      keepRecentMessages: 3,
      keepRecentToolResults: 20,
      autoCompact: {
        enabled: true,
        triggerRatio: 0.5,
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

async function readSessionMeta(
  threadTs: string,
  workspaceDir: string,
): Promise<{
  context?: { autoCompact?: { breakerOpen?: boolean; failureCount?: number } }
  status?: string
}> {
  const sessionDir = await findSessionDir(threadTs, { workspaceDir })
  const raw = await fs.readFile(path.join(sessionDir, 'meta.json'), 'utf8')
  return JSON.parse(raw) as {
    context?: { autoCompact?: { breakerOpen?: boolean; failureCount?: number } }
    status?: string
  }
}

async function readCompactRecords(
  threadTs: string,
  workspaceDir: string,
): Promise<Array<{ messageId?: string; mode?: string }>> {
  const sessionDir = await findSessionDir(threadTs, { workspaceDir })
  const file = path.join(sessionDir, 'compact.jsonl')
  if (!existsSync(file)) {
    return []
  }
  const raw = await fs.readFile(file, 'utf8')
  return raw
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as { messageId?: string; mode?: string })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function assertResult(result: AutoCompactResult): void {
  const failures: string[] = []
  if (!result.matched.seedReplyObserved) failures.push('seed reply not observed')
  if (!result.matched.mainReplyContinued) failures.push('main reply did not continue')
  if (!result.matched.autoCompactActivityObserved) {
    failures.push('auto compact activity state not observed')
  }
  if (!result.matched.persistedAutoCompactSummary) {
    failures.push('auto compact summary not persisted')
  }
  if (!result.matched.persistedStructuredCompactMarker) {
    failures.push('structured compact marker not persisted')
  }
  if (!result.matched.autoCompactNotVisibleAsReply) {
    failures.push('auto compact summary should not be visible as Slack reply')
  }
  if (!result.matched.autoCompactStateReset) failures.push('auto compact state not reset')
  if (!result.matched.sessionIdle) failures.push('session did not become idle before cleanup')

  if (failures.length > 0) {
    throw new Error(`Live auto compact E2E failed: ${failures.join('; ')}`)
  }
}

export const scenario: LiveE2EScenario = {
  id: 'auto-compact',
  title: 'Auto Compact',
  description: 'Force auto compact by message-count budget and verify the main reply continues.',
  keywords: ['compact', 'auto', 'context'],
  run: main,
}

runDirectly(scenario)
