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
    /** events.jsonl 出现 compact_attempt + compact_succeeded */
    compactEventsEmitted: boolean
    mainReplyContinued: boolean
    persistedAutoCompactSummary: boolean
    persistedStructuredCompactMarker: boolean
    sessionIdle: boolean
    seedReplyObserved: boolean
  }
  passed: boolean
  preCompactApproxChars?: number
  postCompactApproxChars?: number
  willRetriggerNextTurn?: boolean
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
      compactEventsEmitted: false,
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
    const botUserId = ctx.botUserId
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
      const reply = findReplyContaining(
        messages,
        rootMessage.ts,
        `AUTO_COMPACT_READY ${runId}`,
        botUserId,
      )
      result.matched.seedReplyObserved = Boolean(reply)
      return result.matched.seedReplyObserved
    })

    // filler ≤ 4K：Slack chat.postMessage > 4K 会被服务端切多条消息，bot 只见第一段
    // → user 消息中的"Reply exactly: AUTO_COMPACT_OK"会被切到后续 non-mention 消息里
    // → bot 不会按预期回复。1.2K 既够触发 trigger（threshold=500），又确保单消息送达。
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
      result.matched.autoCompactActivityObserved ||= messages.some(
        (message) => message.user === botUserId && message.text?.includes('正在整理上下文'),
      )

      const reply = findReplyContaining(
        messages,
        rootMessage.ts,
        `AUTO_COMPACT_OK ${runId}`,
        botUserId,
      )
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

        // events.jsonl: 必须有 compact_attempt + compact_succeeded（按时序）。
        // willRetriggerNextTurn=false 是"压缩到位"的硬证据。
        const events = await readEventsJsonl(rootMessage.ts, workspaceDir)
        const attempts = events.filter((e) => e.type === 'compact_attempt')
        const succeeded = events.filter((e) => e.type === 'compact_succeeded')
        result.matched.compactEventsEmitted = attempts.length >= 1 && succeeded.length >= 1
        const succeededEv = succeeded[0] as
          | {
              preCompactApproxChars?: number
              postCompactApproxChars?: number
              willRetriggerNextTurn?: boolean
            }
          | undefined
        if (succeededEv) {
          if (typeof succeededEv.preCompactApproxChars === 'number') {
            result.preCompactApproxChars = succeededEv.preCompactApproxChars
          }
          if (typeof succeededEv.postCompactApproxChars === 'number') {
            result.postCompactApproxChars = succeededEv.postCompactApproxChars
          }
          if (typeof succeededEv.willRetriggerNextTurn === 'boolean') {
            result.willRetriggerNextTurn = succeededEv.willRetriggerNextTurn
          }
        }
      }

      return (
        result.matched.mainReplyContinued &&
        result.matched.autoCompactNotVisibleAsReply &&
        result.matched.autoCompactActivityObserved &&
        result.matched.persistedAutoCompactSummary &&
        result.matched.persistedStructuredCompactMarker &&
        result.matched.autoCompactStateReset &&
        result.matched.sessionIdle &&
        result.matched.compactEventsEmitted
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
    if (!result.passed) {
      await preserveWorkspaceLogsForDebug(
        'auto-compact',
        runId,
        workspaceDir,
        ctx && result.rootMessageTs
          ? { ctx, rootMessageTs: result.rootMessageTs }
          : undefined,
      ).catch((error) => consola.error('Failed to preserve workspace logs:', error))
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
  // 阈值设计：
  //   maxApproxChars=1_000, triggerRatio=0.5 → 阈值 500
  //   candidate（~1.3K：seed+assistant+1.2K filler）> 500 → trigger 触发
  // 注意：新 9 章节 prompt 摘要 3-5K chars ≫ 阈值 500，所以本场景的 willRetrigger=true
  // 是预期；"压缩到位"（willRetrigger=false）由 compact-effectiveness e2e 用 1M
  // fixture + 大阈值场景验证。本 e2e 只确认埋点 + 主流程跑通。
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
  if (!result.matched.compactEventsEmitted) {
    failures.push('events.jsonl missing compact_attempt + compact_succeeded')
  }

  if (failures.length > 0) {
    throw new Error(`Live auto compact E2E failed: ${failures.join('; ')}`)
  }
}

export const scenario: LiveE2EScenario = {
  id: 'auto-compact',
  title: 'Auto Compact',
  description:
    'Force auto compact by approximate character budget; verify main reply continues, summary persisted, events.jsonl emits compact_attempt + compact_succeeded.',
  keywords: ['compact', 'auto', 'context'],
  run: main,
}

runDirectly(scenario)
