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

interface EffectivenessResult {
  failureMessage?: string
  matched: {
    seedReplyObserved: boolean
    fixtureInjected: boolean
    triggerReplyObserved: boolean
    compactSucceededEventFound: boolean
    /** willRetriggerNextTurn === false：压缩到位的硬证据 */
    compactWillNotRetrigger: boolean
    /** post/pre < 0.5：实测预期 ~10% 残留，0.5 留宽幅余量给小 fixture */
    significantShrinkRatio: boolean
  }
  passed: boolean
  preCompactApproxChars?: number
  postCompactApproxChars?: number
  shrinkRatio?: number
  willRetriggerNextTurn?: boolean
  rootMessageTs?: string
  triggerMessageTs?: string
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
  const result: EffectivenessResult = {
    matched: {
      seedReplyObserved: false,
      fixtureInjected: false,
      triggerReplyObserved: false,
      compactSucceededEventFound: false,
      compactWillNotRetrigger: false,
      significantShrinkRatio: false,
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

    // Step 1：发 seed → bot 回复 → session dir + messages.jsonl 创建
    const rootMessage = await ctx.triggerClient.postMessage({
      channel: ctx.channelId,
      text: [
        `<@${ctx.botUserId}> COMPACT_EFFECTIVENESS_SEED ${runId}`,
        `Reply exactly: COMPACT_EFFECTIVENESS_READY ${runId}`,
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
        `COMPACT_EFFECTIVENESS_READY ${runId}`,
        botUserId,
      )
      result.matched.seedReplyObserved = Boolean(reply)
      return result.matched.seedReplyObserved
    })

    // Step 2：注入 1M-char fixture 到 messages.jsonl 中间——
    // 在已有的 [seed_user, seed_assistant_reply] 之间插入大量旧消息。
    // 注意保留 seed_assistant_reply 在最后，确保下一轮 SessionStore.loadMessages
    // 切片到这条 assistant 消息之后（无 boundary 时）。
    const sessionDir = await findSessionDir(rootMessage.ts, { workspaceDir })
    const messagesFile = path.join(sessionDir, 'messages.jsonl')
    const existing = await fs.readFile(messagesFile, 'utf8')
    const fixtureContent = await fs.readFile(FIXTURE_PATH, 'utf8')
    // existing 应该是 [seed user] + [seed assistant reply]，拆开把 fixture 插中间
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

    // Step 3：发 trigger（短消息）→ candidate = sliced history (~1M chars) + trigger
    // → trigger 必发（远超 800K 阈值）→ compact 触发
    const triggerMessage = await ctx.triggerClient.postMessage({
      channel: ctx.channelId,
      thread_ts: rootMessage.ts,
      text: [
        `<@${ctx.botUserId}> COMPACT_EFFECTIVENESS_GO ${runId}`,
        `Reply exactly: COMPACT_EFFECTIVENESS_DONE ${runId}`,
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
        `COMPACT_EFFECTIVENESS_DONE ${runId}`,
        botUserId,
      )
      result.matched.triggerReplyObserved = Boolean(reply)
      if (!result.matched.triggerReplyObserved) {
        return false
      }

      const events = await readEventsJsonl(rootMessage.ts, workspaceDir)
      const succeeded = events.filter((e) => e.type === 'compact_succeeded')
      if (succeeded.length === 0) {
        return false
      }

      const ev = succeeded[0] as {
        preCompactApproxChars?: number
        postCompactApproxChars?: number
        willRetriggerNextTurn?: boolean
      }
      result.matched.compactSucceededEventFound = true
      if (typeof ev.preCompactApproxChars === 'number') {
        result.preCompactApproxChars = ev.preCompactApproxChars
      }
      if (typeof ev.postCompactApproxChars === 'number') {
        result.postCompactApproxChars = ev.postCompactApproxChars
      }
      if (typeof ev.willRetriggerNextTurn === 'boolean') {
        result.willRetriggerNextTurn = ev.willRetriggerNextTurn
      }
      const pre = ev.preCompactApproxChars ?? 0
      const post = ev.postCompactApproxChars ?? Number.POSITIVE_INFINITY
      result.shrinkRatio = pre > 0 ? post / pre : 1
      result.matched.compactWillNotRetrigger = ev.willRetriggerNextTurn === false
      // 实测 ~10% 残留；放宽到 50% 余量（毕竟单次 e2e 模型输出有波动）
      result.matched.significantShrinkRatio = result.shrinkRatio < 0.5

      return (
        result.matched.compactSucceededEventFound &&
        result.matched.compactWillNotRetrigger &&
        result.matched.significantShrinkRatio
      )
    })

    assertResult(result)
    result.passed = true
    await writeScenarioResult('compact-effectiveness', result)
    consola.info(
      `Compact effectiveness: ${result.preCompactApproxChars} → ${result.postCompactApproxChars} chars (${((result.shrinkRatio ?? 1) * 100).toFixed(1)}%)`,
    )
  } catch (error) {
    result.failureMessage = error instanceof Error ? error.message : String(error)
    caughtError = error
  } finally {
    await writeScenarioResult('compact-effectiveness', result).catch((err) => {
      consola.error('Failed to persist result:', err)
    })
    if (ctx) {
      await ctx.application.stop().catch((err) => {
        consola.error('Failed to stop application:', err)
      })
    }
    if (!result.passed) {
      await preserveWorkspaceLogsForDebug(
        'compact-effectiveness',
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
  const workspaceDir = await fs.mkdtemp(path.join(tmpdir(), 'agent-slack-compact-eff-'))
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
  //   maxApproxChars=1_000_000, triggerRatio=0.8 → 阈值 800_000 chars
  //   注入 ~980K chars fixture → candidate ≫ 800K → trigger 触发
  //   预期 summary ~50K-150K chars（~10% 残留）≪ 800K → willRetrigger=false
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

function assertResult(result: EffectivenessResult): void {
  const failures: string[] = []
  if (!result.matched.seedReplyObserved) failures.push('seed reply not observed')
  if (!result.matched.fixtureInjected) failures.push('fixture not injected')
  if (!result.matched.triggerReplyObserved) failures.push('trigger reply not observed')
  if (!result.matched.compactSucceededEventFound) {
    failures.push('compact_succeeded event missing in events.jsonl')
  }
  if (!result.matched.compactWillNotRetrigger) {
    failures.push(
      `willRetriggerNextTurn !== false (post=${result.postCompactApproxChars}, pre=${result.preCompactApproxChars})`,
    )
  }
  if (!result.matched.significantShrinkRatio) {
    failures.push(
      `shrinkRatio ${(result.shrinkRatio ?? 1).toFixed(3)} not < 0.5 (compaction not effective)`,
    )
  }
  if (failures.length > 0) {
    throw new Error(`Live compact effectiveness E2E failed: ${failures.join('; ')}`)
  }
}

export const scenario: LiveE2EScenario = {
  id: 'compact-effectiveness',
  title: 'Compact Effectiveness',
  description:
    'Inject ~1M-char fixture into session jsonl, trigger auto compact, verify shrink ratio < 50% and willRetriggerNextTurn === false.',
  keywords: ['compact', 'effectiveness', 'shrink', 'fixture'],
  run: main,
}

runDirectly(scenario)
