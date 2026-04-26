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
  findUsageMessage,
  hasReaction,
  readSessionMessages,
  waitForThread,
  writeScenarioResult,
} from './scenario-utils.ts'

interface MaxStepsResult {
  failureMessage?: string
  matched: {
    doneReactionAbsent: boolean
    maxStepsSummaryObserved: boolean
    stoppedMarkerPersisted: boolean
    stoppedReactionObserved: boolean
    summaryPersisted: boolean
    usageObserved: boolean
  }
  passed: boolean
  rootMessageTs?: string
  runId: string
  summaryText?: string
  usageText?: string
  workspaceDir?: string
}

async function main(): Promise<void> {
  const runId = randomUUID()
  const marker = `MAX_STEPS_E2E_MARKER_${runId}`
  const result: MaxStepsResult = {
    matched: {
      doneReactionAbsent: false,
      maxStepsSummaryObserved: false,
      stoppedMarkerPersisted: false,
      stoppedReactionObserved: false,
      summaryPersisted: false,
      usageObserved: false,
    },
    passed: false,
    runId,
  }
  const workspaceDir = await createMaxStepsWorkspace()
  result.workspaceDir = workspaceDir

  let ctx: Awaited<ReturnType<typeof createLiveE2EContext>> | undefined
  let caughtError: unknown

  try {
    ctx = await createLiveE2EContext(runId, { workspaceDir })
    const activeCtx = ctx
    await ctx.application.start()
    await delay(3_000)

    const rootMessage = await ctx.triggerClient.postMessage({
      channel: ctx.channelId,
      text: [
        `<@${ctx.botUserId}> MAX_STEPS_E2E ${runId}`,
        `Before any final reply, you must call the bash tool exactly once with command: printf ${marker}`,
        'Do not answer directly before the tool result is available.',
      ].join('\n'),
      unfurl_links: false,
      unfurl_media: false,
    })
    result.rootMessageTs = rootMessage.ts

    await waitForThread(ctx, rootMessage.ts, async (messages) => {
      const summary = findReplyContaining(messages, rootMessage.ts, 'maxSteps 上限')
      if (summary?.text) {
        result.summaryText = summary.text
        result.matched.maxStepsSummaryObserved = summary.text.includes('当前已知上下文总结')
      }

      const usage = findUsageMessage(messages, rootMessage.ts)
      if (usage?.text) {
        result.usageText = usage.text
        result.matched.usageObserved = true
      }

      result.matched.stoppedReactionObserved = await hasReaction(
        activeCtx.botClient,
        activeCtx.channelId,
        rootMessage.ts,
        'black_square_for_stop',
      )
      result.matched.doneReactionAbsent = !(await hasReaction(
        activeCtx.botClient,
        activeCtx.channelId,
        rootMessage.ts,
        'white_check_mark',
      ))

      if (result.matched.maxStepsSummaryObserved) {
        const jsonl = await readSessionMessages(rootMessage.ts, { workspaceDir }).catch(
          () => undefined,
        )
        if (jsonl) {
          result.matched.summaryPersisted =
            jsonl.includes('maxSteps 上限') && jsonl.includes('当前已知上下文总结')
          result.matched.stoppedMarkerPersisted = jsonl.includes('[stopped: max_steps]')
        }
      }

      return (
        result.matched.maxStepsSummaryObserved &&
        result.matched.usageObserved &&
        result.matched.stoppedReactionObserved &&
        result.matched.doneReactionAbsent &&
        result.matched.summaryPersisted &&
        result.matched.stoppedMarkerPersisted
      )
    })

    assertResult(result)
    result.passed = true
    await writeScenarioResult('max-steps', result)
    consola.info('Live maxSteps E2E passed.')
  } catch (error) {
    result.failureMessage = error instanceof Error ? error.message : String(error)
    caughtError = error
  } finally {
    await writeScenarioResult('max-steps', result).catch((error) => {
      consola.error('Failed to persist result:', error)
    })
    if (ctx) {
      await ctx.application.stop().catch((error) => {
        consola.error('Failed to stop application:', error)
      })
    }
    await fs.rm(workspaceDir, { recursive: true, force: true }).catch((error) => {
      consola.error('Failed to remove temporary maxSteps workspace:', error)
    })
  }

  if (caughtError) {
    throw caughtError
  }
}

async function createMaxStepsWorkspace(): Promise<string> {
  const workspaceDir = await fs.mkdtemp(path.join(tmpdir(), 'agent-slack-max-steps-'))
  const sourcePaths = resolveWorkspacePaths(process.cwd())
  const targetPaths = resolveWorkspacePaths(workspaceDir)
  await fs.mkdir(targetPaths.root, { recursive: true })

  const sourceConfig = existsSync(sourcePaths.configFile)
    ? YAML.parse(await fs.readFile(sourcePaths.configFile, 'utf8'))
    : {}
  const config = isRecord(sourceConfig) ? sourceConfig : {}
  const agent = isRecord(config.agent) ? config.agent : {}
  config.agent = { ...agent, maxSteps: 1 }

  await fs.writeFile(targetPaths.configFile, `${YAML.stringify(config)}\n`, 'utf8')

  if (existsSync(sourcePaths.systemFile)) {
    await fs.copyFile(sourcePaths.systemFile, targetPaths.systemFile)
  }

  return workspaceDir
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function assertResult(result: MaxStepsResult): void {
  const failures: string[] = []
  if (!result.matched.maxStepsSummaryObserved) failures.push('maxSteps summary not observed')
  if (!result.matched.usageObserved) failures.push('usage message not observed')
  if (!result.matched.stoppedReactionObserved) failures.push('stopped reaction not observed')
  if (!result.matched.doneReactionAbsent) failures.push('done reaction should be absent')
  if (!result.matched.summaryPersisted) failures.push('maxSteps summary not persisted')
  if (!result.matched.stoppedMarkerPersisted)
    failures.push('stopped max_steps marker not persisted')

  if (failures.length > 0) {
    throw new Error(`Live maxSteps E2E failed: ${failures.join('; ')}`)
  }
}

export const scenario: LiveE2EScenario = {
  id: 'max-steps',
  title: 'Max Steps Stop',
  description:
    'Force maxSteps=1, verify stopped(max_steps), summary reply, usage, and no done reaction.',
  keywords: ['maxSteps', 'stopped', 'usage', 'reaction'],
  run: main,
}

runDirectly(scenario)
