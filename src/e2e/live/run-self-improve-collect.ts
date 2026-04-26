import './load-e2e-env.ts'

import { randomUUID } from 'node:crypto'
import { consola } from 'consola'
import type { LiveE2EScenario } from './scenario.ts'
import { runDirectly } from './scenario.ts'
import {
  createLiveE2EContext,
  delay,
  findReplyContaining,
  findUsageMessage,
  readSessionMessages,
  waitForThread,
  writeScenarioResult,
} from './scenario-utils.ts'

interface SelfImproveCollectResult {
  assistantReplyText?: string
  assistantReplyTs?: string
  failureMessage?: string
  matched: {
    assistantReplied: boolean
    collectToolCalled: boolean
    collectToolResultPersisted: boolean
    usageObserved: boolean
  }
  passed: boolean
  rootMessageTs?: string
  runId: string
}

async function main(): Promise<void> {
  const runId = randomUUID()
  const result: SelfImproveCollectResult = {
    matched: {
      assistantReplied: false,
      collectToolCalled: false,
      collectToolResultPersisted: false,
      usageObserved: false,
    },
    passed: false,
    runId,
  }
  const ctx = await createLiveE2EContext(runId)
  let caughtError: unknown

  try {
    await ctx.application.start()
    await delay(3_000)

    const rootMessage = await ctx.triggerClient.postMessage({
      channel: ctx.channelId,
      text: [
        `<@${ctx.botUserId}> SELF_IMPROVE_COLLECT_E2E ${runId}`,
        'Call self_improve_collect exactly once with scope 1 and focus "live e2e".',
        'Do not call self_improve_confirm.',
        `After the tool result, reply exactly: SELF_IMPROVE_COLLECT_OK ${runId}`,
      ].join('\n'),
      unfurl_links: false,
      unfurl_media: false,
    })
    result.rootMessageTs = rootMessage.ts

    await waitForThread(ctx, rootMessage.ts, async (messages) => {
      const reply = findReplyContaining(
        messages,
        rootMessage.ts,
        `SELF_IMPROVE_COLLECT_OK ${runId}`,
      )
      if (reply) {
        result.assistantReplyText = reply.text ?? ''
        result.assistantReplyTs = reply.ts ?? ''
        result.matched.assistantReplied = true
      }

      const usage = findUsageMessage(messages, rootMessage.ts)
      result.matched.usageObserved = usage !== undefined

      try {
        const jsonl = await readSessionMessages(rootMessage.ts)
        result.matched.collectToolCalled = jsonl.includes('"toolName":"self_improve_collect"')
        result.matched.collectToolResultPersisted =
          jsonl.includes('"guide"') && jsonl.includes('AGENTS.md 规则编写指南')
      } catch {
        result.matched.collectToolCalled = false
        result.matched.collectToolResultPersisted = false
      }

      return (
        result.matched.assistantReplied &&
        result.matched.usageObserved &&
        result.matched.collectToolCalled &&
        result.matched.collectToolResultPersisted
      )
    })

    assertResult(result)
    result.passed = true
    await writeScenarioResult('self-improve-collect', result)
    consola.info('Live self-improve collect E2E passed.')
  } catch (error) {
    result.failureMessage = error instanceof Error ? error.message : String(error)
    caughtError = error
  } finally {
    await writeScenarioResult('self-improve-collect', result).catch((error) => {
      consola.error('Failed to persist result:', error)
    })
    await ctx.application.stop().catch((error) => {
      consola.error('Failed to stop application:', error)
    })
  }

  if (caughtError) {
    throw caughtError
  }
}

function assertResult(result: SelfImproveCollectResult): void {
  const failures: string[] = []
  if (!result.matched.assistantReplied) failures.push('assistant reply not observed')
  if (!result.matched.usageObserved) failures.push('usage message not observed')
  if (!result.matched.collectToolCalled)
    failures.push('self_improve_collect tool call not persisted')
  if (!result.matched.collectToolResultPersisted) {
    failures.push('self_improve_collect tool result not persisted')
  }

  if (failures.length > 0) {
    throw new Error(`Live self-improve collect E2E failed: ${failures.join('; ')}`)
  }
}

export const scenario: LiveE2EScenario = {
  id: 'self-improve-collect',
  title: 'Self Improve Collect',
  description: 'Force self_improve_collect and verify the migrated agents/selfImprove path works.',
  keywords: ['self-improve', 'collect', 'agent', 'tool'],
  run: main,
}

runDirectly(scenario)
