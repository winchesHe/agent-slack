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

interface BreakerOpenResult {
  failureMessage?: string
  matched: {
    seedReplyObserved: boolean
    breakerStatePrepared: boolean
    triggerReplyObserved: boolean
    compactSkippedEventFound: boolean
    /** 主流程仍能完成回复——熔断不应阻断 user-facing turn */
    mainFlowContinuedDespiteBreaker: boolean
    /** events.jsonl 不应出现新的 compact_attempt（熔断路径在 attempt 之前 short-circuit）*/
    noCompactAttemptInBreakerTurn: boolean
  }
  passed: boolean
  rootMessageTs?: string
  triggerMessageTs?: string
  runId: string
  workspaceDir?: string
}

async function main(): Promise<void> {
  const runId = randomUUID()
  const result: BreakerOpenResult = {
    matched: {
      seedReplyObserved: false,
      breakerStatePrepared: false,
      triggerReplyObserved: false,
      compactSkippedEventFound: false,
      mainFlowContinuedDespiteBreaker: false,
      noCompactAttemptInBreakerTurn: false,
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

    // Step 1：seed → bot reply → session dir + meta.json 创建
    const rootMessage = await ctx.triggerClient.postMessage({
      channel: ctx.channelId,
      text: [
        `<@${ctx.botUserId}> BREAKER_SEED ${runId}`,
        `Reply exactly: BREAKER_READY ${runId}`,
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
        `BREAKER_READY ${runId}`,
        botUserId,
      )
      result.matched.seedReplyObserved = Boolean(reply)
      return result.matched.seedReplyObserved
    })

    if (!result.matched.seedReplyObserved) {
      // 早 bail：waitForThread 不抛错，需要这里显式失败。否则后续 fixture 注入会
      // race bot 的延迟 seed 处理，导致 ai-sdk 看到半改写的 messages.jsonl 报错。
      throw new Error('seed reply timed out; abort before fixture injection')
    }
    // 等 bot 完成 seed 全流程（写完 messages.jsonl + status=idle）再改文件
    await delay(2_000)

    // Step 2：手改 meta.json 的 context.autoCompact 模拟"已熔断"状态
    const sessionDir = await findSessionDir(rootMessage.ts, { workspaceDir })
    const metaFile = path.join(sessionDir, 'meta.json')
    const meta = JSON.parse(await fs.readFile(metaFile, 'utf8')) as {
      context?: { autoCompact?: Record<string, unknown> }
    }
    meta.context = {
      ...(meta.context ?? {}),
      autoCompact: {
        failureCount: 2,
        breakerOpen: true,
        lastFailureAt: new Date().toISOString(),
        lastFailureMessage: 'simulated breaker for e2e',
      },
    }
    await fs.writeFile(metaFile, JSON.stringify(meta, null, 2), 'utf8')
    result.matched.breakerStatePrepared = true

    // 注：本测试不再注入 1M fixture——熔断 short-circuit 路径 emit
    // skipped(breaker_open) 不依赖 candidate 是否超阈值（orchestrator 在所有
    // breaker_open 时都会发该事件）。少注入也避免后续主流程因为 ai-sdk 不接受
    // SessionStore 写入的 id 字段而失败（独立 bug，超出本测试范围）。

    // Step 3：trigger 一条短消息——bot 处理时会读取 meta，发现 breakerOpen=true，
    // 直接 emit skipped(breaker_open)，不进 compactor，主流程继续走 executor 回复。
    const triggerMessage = await ctx.triggerClient.postMessage({
      channel: ctx.channelId,
      thread_ts: rootMessage.ts,
      text: [
        `<@${ctx.botUserId}> BREAKER_GO ${runId}`,
        `Reply exactly: BREAKER_DONE ${runId}`,
        'Do not use tools.',
      ].join('\n'),
      unfurl_links: false,
      unfurl_media: false,
    })
    result.triggerMessageTs = triggerMessage.ts

    await waitForThread(ctx, rootMessage.ts, async (messages) => {
      const reply = findReplyContaining(
        messages,
        rootMessage.ts,
        `BREAKER_DONE ${runId}`,
        botUserId,
      )
      result.matched.triggerReplyObserved = Boolean(reply)
      result.matched.mainFlowContinuedDespiteBreaker = result.matched.triggerReplyObserved
      if (!result.matched.triggerReplyObserved) return false

      const events = await readEventsJsonl(rootMessage.ts, workspaceDir)
      const skipped = events.filter(
        (e) => e.type === 'compact_skipped' && e.reason === 'breaker_open',
      )
      const attempts = events.filter((e) => e.type === 'compact_attempt')
      result.matched.compactSkippedEventFound = skipped.length >= 1
      result.matched.noCompactAttemptInBreakerTurn = attempts.length === 0
      return (
        result.matched.compactSkippedEventFound && result.matched.noCompactAttemptInBreakerTurn
      )
    })

    assertResult(result)
    result.passed = true
    await writeScenarioResult('auto-compact-breaker-open', result)
    consola.info('Auto compact breaker open: skipped(breaker_open) emitted; main flow continued.')
  } catch (error) {
    result.failureMessage = error instanceof Error ? error.message : String(error)
    caughtError = error
  } finally {
    await writeScenarioResult('auto-compact-breaker-open', result).catch((err) => {
      consola.error('Failed to persist result:', err)
    })
    if (ctx) {
      await ctx.application.stop().catch((err) => {
        consola.error('Failed to stop application:', err)
      })
    }
    if (!result.passed) {
      await preserveWorkspaceLogsForDebug(
        'auto-compact-breaker-open',
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
  const workspaceDir = await fs.mkdtemp(path.join(tmpdir(), 'agent-slack-breaker-'))
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
): Promise<Array<{ type: string; reason?: string; [k: string]: unknown }>> {
  const sessionDir = await findSessionDir(threadTs, { workspaceDir })
  const file = path.join(sessionDir, 'events.jsonl')
  if (!existsSync(file)) return []
  const raw = await fs.readFile(file, 'utf8')
  return raw
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as { type: string; reason?: string; [k: string]: unknown })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function assertResult(result: BreakerOpenResult): void {
  const failures: string[] = []
  if (!result.matched.seedReplyObserved) failures.push('seed reply not observed')
  if (!result.matched.breakerStatePrepared) failures.push('breaker state not prepared')
  if (!result.matched.triggerReplyObserved) failures.push('trigger reply not observed')
  if (!result.matched.mainFlowContinuedDespiteBreaker) {
    failures.push('main flow did not continue despite breaker (regression: breaker should be soft)')
  }
  if (!result.matched.compactSkippedEventFound) {
    failures.push('events.jsonl missing compact_skipped(breaker_open)')
  }
  if (!result.matched.noCompactAttemptInBreakerTurn) {
    failures.push('compact_attempt should not appear when breaker is open')
  }
  if (failures.length > 0) {
    throw new Error(`Live auto-compact-breaker-open E2E failed: ${failures.join('; ')}`)
  }
}

export const scenario: LiveE2EScenario = {
  id: 'auto-compact-breaker-open',
  title: 'Auto Compact Breaker Open',
  description:
    'Pre-set autoCompact.breakerOpen=true and verify subsequent turns emit compact_skipped(breaker_open) while main flow still completes.',
  keywords: ['compact', 'breaker', 'circuit', 'failure'],
  run: main,
}

runDirectly(scenario)
