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
    compactSummaryOmitsOldMarker: boolean
    compactSummaryObserved: boolean
    oldMarkerNotLeakedAfterCompact: boolean
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
      compactSummaryOmitsOldMarker: false,
      compactSummaryObserved: false,
      oldMarkerNotLeakedAfterCompact: false,
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
      const reply = findReplyContaining(messages, rootMessage.ts, `COMPACT_BOUNDARY_READY ${runId}`)
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
      const reply = findReplyContaining(messages, rootMessage.ts, '[compact: manual]')
      result.matched.compactSummaryObserved = Boolean(reply?.text?.includes('[compact: manual]'))
      if (!reply?.text) {
        return false
      }

      if (reply.ts) {
        result.compactReplyTs = reply.ts
      }
      result.matched.compactSummaryOmitsOldMarker = !reply.text.includes(oldMarker)
      const jsonl = await readSessionMessages(rootMessage.ts, { workspaceDir })
      result.matched.persistedCompactSummary =
        jsonl.includes('[compact: manual]') && jsonl.includes(oldMarker)

      return (
        result.matched.compactSummaryObserved &&
        result.matched.compactSummaryOmitsOldMarker &&
        result.matched.persistedCompactSummary
      )
    })

    const probeMessage = await ctx.triggerClient.postMessage({
      channel: ctx.channelId,
      thread_ts: rootMessage.ts,
      text: [
        `<@${ctx.botUserId}> COMPACT_BOUNDARY_PROBE ${runId}`,
        '如果你能在更早的对话或 compact 摘要中看到以 COMPACT_COMMAND_PRE_BOUNDARY_ 开头的完整旧 token，请原样输出那个完整 token。',
        `如果看不到完整旧 token，请只回复：COMPACT_BOUNDARY_OK ${runId}`,
        '不要调用工具。',
      ].join('\n'),
      unfurl_links: false,
      unfurl_media: false,
    })
    result.probeMessageTs = probeMessage.ts

    await waitForThread(ctx, rootMessage.ts, (messages) => {
      const reply = findReplyContaining(messages, rootMessage.ts, `COMPACT_BOUNDARY_OK ${runId}`)
      if (!reply?.text) {
        return false
      }

      result.boundaryReplyText = reply.text
      result.matched.boundaryReplyObserved = true
      result.matched.oldMarkerNotLeakedAfterCompact = !reply.text.includes(oldMarker)
      return result.matched.oldMarkerNotLeakedAfterCompact
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
  if (!result.matched.compactSummaryOmitsOldMarker) {
    failures.push('compact summary should omit old marker')
  }
  if (!result.matched.persistedCompactSummary) failures.push('compact summary not persisted')
  if (!result.matched.boundaryReplyObserved)
    failures.push('post-compact boundary reply not observed')
  if (!result.matched.oldMarkerNotLeakedAfterCompact) {
    failures.push('old pre-compact marker leaked after compact boundary')
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
