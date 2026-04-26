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

interface ContextPruningNoLlmResult {
  failureMessage?: string
  matched: {
    noCompactSummaryPersisted: boolean
    oldMarkerNotLeaked: boolean
    oldMarkerPersistedInFullHistory: boolean
    secondReplyObserved: boolean
    seedReplyObserved: boolean
    sessionIdle: boolean
  }
  passed: boolean
  rootMessageTs?: string
  runId: string
  secondReplyText?: string
  workspaceDir?: string
}

async function main(): Promise<void> {
  const runId = randomUUID()
  const oldMarker = `NO_LLM_PRUNING_OLD_${randomUUID()}`
  const result: ContextPruningNoLlmResult = {
    matched: {
      noCompactSummaryPersisted: false,
      oldMarkerNotLeaked: false,
      oldMarkerPersistedInFullHistory: false,
      secondReplyObserved: false,
      seedReplyObserved: false,
      sessionIdle: false,
    },
    passed: false,
    runId,
  }
  const workspaceDir = await createNoLlmPruningWorkspace()
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
        `<@${ctx.botUserId}> NO_LLM_PRUNING_SEED ${runId}`,
        `Historical marker that should be pruned later: ${oldMarker}`,
        `Reply exactly: NO_LLM_PRUNING_READY ${runId}`,
        'Do not use tools.',
      ].join('\n'),
      unfurl_links: false,
      unfurl_media: false,
    })
    result.rootMessageTs = rootMessage.ts

    await waitForThread(ctx, rootMessage.ts, (messages) => {
      const reply = findReplyContaining(messages, rootMessage.ts, `NO_LLM_PRUNING_READY ${runId}`)
      result.matched.seedReplyObserved = Boolean(reply)
      return result.matched.seedReplyObserved
    })

    await ctx.triggerClient.postMessage({
      channel: ctx.channelId,
      thread_ts: rootMessage.ts,
      text: [
        `<@${ctx.botUserId}> NO_LLM_PRUNING_PROBE ${runId}`,
        '如果你能在当前模型上下文中看到以 NO_LLM_PRUNING_OLD_ 开头的完整旧 token，请原样输出那个完整 token。',
        `如果看不到完整旧 token，请只回复：NO_LLM_PRUNING_OK ${runId}`,
        '不要调用工具。',
      ].join('\n'),
      unfurl_links: false,
      unfurl_media: false,
    })

    await waitForThread(ctx, rootMessage.ts, async (messages) => {
      const reply = findReplyContaining(messages, rootMessage.ts, `NO_LLM_PRUNING_OK ${runId}`)
      if (reply?.text) {
        result.secondReplyText = reply.text
        result.matched.secondReplyObserved = true
        result.matched.oldMarkerNotLeaked = !reply.text.includes(oldMarker)
      }

      if (result.matched.secondReplyObserved) {
        const jsonl = await readSessionMessages(rootMessage.ts, { workspaceDir })
        result.matched.oldMarkerPersistedInFullHistory = jsonl.includes(oldMarker)
        result.matched.noCompactSummaryPersisted = !jsonl.includes('[compact:')

        const meta = await readSessionMeta(rootMessage.ts, workspaceDir)
        result.matched.sessionIdle = meta.status === 'idle'
      }

      return (
        result.matched.secondReplyObserved &&
        result.matched.oldMarkerNotLeaked &&
        result.matched.oldMarkerPersistedInFullHistory &&
        result.matched.noCompactSummaryPersisted &&
        result.matched.sessionIdle
      )
    })

    assertResult(result)
    result.passed = true
    await writeScenarioResult('context-pruning-no-llm', result)
    consola.info('Live no-LLM context pruning E2E passed.')
  } catch (error) {
    result.failureMessage = error instanceof Error ? error.message : String(error)
    caughtError = error
  } finally {
    await writeScenarioResult('context-pruning-no-llm', result).catch((error) => {
      consola.error('Failed to persist result:', error)
    })
    if (ctx) {
      await ctx.application.stop().catch((error) => {
        consola.error('Failed to stop application:', error)
      })
    }
    await fs.rm(workspaceDir, { recursive: true, force: true }).catch((error) => {
      consola.error('Failed to remove temporary no-LLM pruning workspace:', error)
    })
  }

  if (caughtError) {
    throw caughtError
  }
}

async function createNoLlmPruningWorkspace(): Promise<string> {
  const workspaceDir = await fs.mkdtemp(path.join(tmpdir(), 'agent-slack-no-llm-pruning-'))
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
      keepRecentMessages: 2,
      keepRecentToolResults: 20,
      autoCompact: {
        enabled: false,
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

async function readSessionMeta(
  threadTs: string,
  workspaceDir: string,
): Promise<{ status?: string }> {
  const sessionDir = await findSessionDir(threadTs, { workspaceDir })
  const raw = await fs.readFile(path.join(sessionDir, 'meta.json'), 'utf8')
  return JSON.parse(raw) as { status?: string }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function assertResult(result: ContextPruningNoLlmResult): void {
  const failures: string[] = []
  if (!result.matched.seedReplyObserved) failures.push('seed reply not observed')
  if (!result.matched.secondReplyObserved) failures.push('second reply not observed')
  if (!result.matched.oldMarkerNotLeaked) failures.push('old marker leaked into model reply')
  if (!result.matched.oldMarkerPersistedInFullHistory) {
    failures.push('old marker not persisted in full messages.jsonl')
  }
  if (!result.matched.noCompactSummaryPersisted) failures.push('compact summary should be absent')
  if (!result.matched.sessionIdle) failures.push('session did not become idle before cleanup')

  if (failures.length > 0) {
    throw new Error(`Live no-LLM context pruning E2E failed: ${failures.join('; ')}`)
  }
}

export const scenario: LiveE2EScenario = {
  id: 'context-pruning-no-llm',
  title: 'Context Pruning Without LLM Compact',
  description: 'Disable auto compact and verify deterministic pruning hides old raw context.',
  keywords: ['compact', 'pruning', 'context', 'no-llm'],
  run: main,
}

runDirectly(scenario)
