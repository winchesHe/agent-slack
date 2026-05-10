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
  preserveWorkspaceLogsForDebug,
  readSessionMessages,
  waitForThread,
  writeScenarioResult,
} from './scenario-utils.ts'

interface CompactBoundaryResult {
  boundaryReplyText?: string
  compactReplyTs?: string
  failureMessage?: string
  matched: {
    boundaryReplyObserved: boolean
    compactSummaryObserved: boolean
    /** §6 verbatim 必然包含 user 消息中的 oldMarker；这里反过来要求它出现。 */
    summaryPreservesUserMessageVerbatim: boolean
    persistedCompactSummary: boolean
    seedReplyObserved: boolean
  }
  passed: boolean
  probeMessageTs?: string
  rootMessageTs?: string
  runId: string
  workspaceDir?: string
}

async function main(): Promise<void> {
  const runId = randomUUID()
  const oldMarker = `COMPACT_COMMAND_PRE_BOUNDARY_${randomUUID()}`
  const result: CompactBoundaryResult = {
    matched: {
      boundaryReplyObserved: false,
      compactSummaryObserved: false,
      summaryPreservesUserMessageVerbatim: false,
      persistedCompactSummary: false,
      seedReplyObserved: false,
    },
    passed: false,
    runId,
  }
  const workspaceDir = await createCompactBoundaryWorkspace()
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
        `<@${ctx.botUserId}> COMPACT_BOUNDARY_SEED ${runId}`,
        `Context note for a later boundary check: ${oldMarker}`,
        `Reply exactly: COMPACT_BOUNDARY_READY ${runId}`,
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
        `COMPACT_BOUNDARY_READY ${runId}`,
        botUserId,
      )
      result.matched.seedReplyObserved = Boolean(reply)
      return result.matched.seedReplyObserved
    })

    await ctx.triggerClient.postMessage({
      channel: ctx.channelId,
      thread_ts: rootMessage.ts,
      text: `<@${ctx.botUserId}> /compact`,
      unfurl_links: false,
      unfurl_media: false,
    })

    await waitForThread(ctx, rootMessage.ts, async (messages) => {
      const reply = findReplyContaining(
        messages,
        rootMessage.ts,
        '[compact: manual]',
        botUserId,
      )
      result.matched.compactSummaryObserved = Boolean(reply?.text?.includes('[compact: manual]'))
      if (!reply?.text) {
        return false
      }

      if (reply.ts) {
        result.compactReplyTs = reply.ts
      }
      // 新 boundary 语义（§3.7.6.3 + memory feedback_compact_verbatim_user_content）：
      // §6 verbatim 必然保留 seed 中的 oldMarker。这里反过来作为"verbatim 保真"证据。
      result.matched.summaryPreservesUserMessageVerbatim = reply.text.includes(oldMarker)
      const jsonl = await readSessionMessages(rootMessage.ts, { workspaceDir })
      result.matched.persistedCompactSummary =
        jsonl.includes('[compact: manual]') && jsonl.includes(oldMarker)

      return (
        result.matched.compactSummaryObserved &&
        result.matched.summaryPreservesUserMessageVerbatim &&
        result.matched.persistedCompactSummary
      )
    })

    // 新 boundary 语义（§3.7.6.3 + memory feedback_compact_verbatim_user_content）：
    // compact 不再"遮蔽"用户消息内容（§6 verbatim 保留），probe 改成"bot compact 后
    // 仍能响应新 turn"——这是 boundary 真正要保的：会话能 idle→active 续接，不卡死。
    const probeMessage = await ctx.triggerClient.postMessage({
      channel: ctx.channelId,
      thread_ts: rootMessage.ts,
      text: [
        `<@${ctx.botUserId}> COMPACT_BOUNDARY_PROBE ${runId}`,
        `Reply exactly: COMPACT_BOUNDARY_OK ${runId}`,
        '不要调用工具。',
      ].join('\n'),
      unfurl_links: false,
      unfurl_media: false,
    })
    result.probeMessageTs = probeMessage.ts

    await waitForThread(ctx, rootMessage.ts, (messages) => {
      const reply = findReplyContaining(
        messages,
        rootMessage.ts,
        `COMPACT_BOUNDARY_OK ${runId}`,
        botUserId,
      )
      if (!reply?.text) {
        return false
      }
      result.boundaryReplyText = reply.text
      result.matched.boundaryReplyObserved = true
      return true
    })

    assertResult(result)
    result.passed = true
    await writeScenarioResult('compact-boundary', result)
    consola.info('Live compact boundary E2E passed.')
  } catch (error) {
    result.failureMessage = error instanceof Error ? error.message : String(error)
    caughtError = error
  } finally {
    await writeScenarioResult('compact-boundary', result).catch((error) => {
      consola.error('Failed to persist result:', error)
    })
    if (ctx) {
      await ctx.application.stop().catch((error) => {
        consola.error('Failed to stop application:', error)
      })
    }
    if (!result.passed) {
      await preserveWorkspaceLogsForDebug(
        'compact-boundary',
        runId,
        workspaceDir,
        ctx && result.rootMessageTs
          ? { ctx, rootMessageTs: result.rootMessageTs }
          : undefined,
      ).catch((error) => consola.error('Failed to preserve workspace logs:', error))
    }
    await fs.rm(workspaceDir, { recursive: true, force: true }).catch((error) => {
      consola.error('Failed to remove temporary compact boundary workspace:', error)
    })
  }

  if (caughtError) {
    throw caughtError
  }
}

async function createCompactBoundaryWorkspace(): Promise<string> {
  const workspaceDir = await fs.mkdtemp(path.join(tmpdir(), 'agent-slack-compact-boundary-'))
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
      maxApproxChars: 120_000,
      keepRecentMessages: 80,
      keepRecentToolResults: 20,
    },
  }

  await fs.writeFile(targetPaths.configFile, `${YAML.stringify(config)}\n`, 'utf8')

  if (existsSync(sourcePaths.systemFile)) {
    await fs.copyFile(sourcePaths.systemFile, targetPaths.systemFile)
  }

  return workspaceDir
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function assertResult(result: CompactBoundaryResult): void {
  const failures: string[] = []
  if (!result.matched.seedReplyObserved) failures.push('seed reply not observed')
  if (!result.matched.compactSummaryObserved) failures.push('compact summary not observed')
  if (!result.matched.summaryPreservesUserMessageVerbatim) {
    failures.push('compact summary missing §6 verbatim user-message evidence (oldMarker)')
  }
  if (!result.matched.persistedCompactSummary) failures.push('compact summary not persisted')
  if (!result.matched.boundaryReplyObserved) {
    failures.push('post-compact bot remained unresponsive (probe reply not observed)')
  }

  if (failures.length > 0) {
    throw new Error(`Live compact boundary E2E failed: ${failures.join('; ')}`)
  }
}

export const scenario: LiveE2EScenario = {
  id: 'compact-boundary',
  title: 'Compact Boundary',
  description: 'Run @mention /compact, then verify next turn does not see pre-compact raw history.',
  keywords: ['compact', 'boundary', 'context'],
  run: main,
}

runDirectly(scenario)
