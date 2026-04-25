import './load-e2e-env.ts'

import { randomUUID } from 'node:crypto'
import { consola } from 'consola'
import type { LiveE2EScenario } from './scenario.ts'
import { runDirectly } from './scenario.ts'
import {
  createLiveE2EContext,
  delay,
  findReplyContaining,
  hasReaction,
  hasUsageMessage,
  waitForThread,
  writeScenarioResult,
} from './scenario-utils.ts'

interface BasicReplyResult {
  assistantReplyText?: string
  assistantReplyTs?: string
  failureMessage?: string
  matched: {
    assistantReplied: boolean
    doneReactionObserved: boolean
    usageObserved: boolean
  }
  passed: boolean
  rootMessageTs?: string
  runId: string
}

async function main(): Promise<void> {
  const runId = randomUUID()
  const result: BasicReplyResult = {
    matched: {
      assistantReplied: false,
      doneReactionObserved: false,
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
        `<@${ctx.botUserId}> BASIC_E2E ${runId}`,
        `Reply exactly: BASIC_OK ${runId}`,
        'Do not use tools. Do not add anything else.',
      ].join('\n'),
      unfurl_links: false,
      unfurl_media: false,
    })
    result.rootMessageTs = rootMessage.ts

    await waitForBasicAssertions(ctx, rootMessage.ts, result)
    assertResult(result)
    result.passed = true
    await writeScenarioResult('basic-reply', result)
    consola.info('Live basic reply E2E passed.')
  } catch (error) {
    result.failureMessage = error instanceof Error ? error.message : String(error)
    caughtError = error
  } finally {
    await writeScenarioResult('basic-reply', result).catch((error) => {
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

async function waitForBasicAssertions(
  ctx: Awaited<ReturnType<typeof createLiveE2EContext>>,
  rootMessageTs: string,
  result: BasicReplyResult,
): Promise<void> {
  const marker = `BASIC_OK ${ctx.runId}`

  await waitForThread(ctx, rootMessageTs, async (messages) => {
    const reply = findReplyContaining(messages, rootMessageTs, marker)
    if (reply) {
      result.assistantReplyText = reply.text ?? ''
      result.assistantReplyTs = reply.ts ?? ''
      result.matched.assistantReplied = true
    }

    result.matched.usageObserved = hasUsageMessage(messages, rootMessageTs)
    result.matched.doneReactionObserved = await hasReaction(
      ctx.botClient,
      ctx.channelId,
      rootMessageTs,
      'white_check_mark',
    )

    return (
      result.matched.assistantReplied &&
      result.matched.usageObserved &&
      result.matched.doneReactionObserved
    )
  })
}

function assertResult(result: BasicReplyResult): void {
  const failures: string[] = []
  if (!result.matched.assistantReplied) failures.push('assistant reply not observed')
  if (!result.matched.usageObserved) failures.push('usage message not observed')
  if (!result.matched.doneReactionObserved) failures.push('done reaction not observed')

  if (failures.length > 0) {
    throw new Error(`Live basic reply E2E failed: ${failures.join('; ')}`)
  }
}

export const scenario: LiveE2EScenario = {
  id: 'basic-reply',
  title: 'Basic Reply',
  description: 'Mention the bot and verify reply, usage message, and done reaction.',
  keywords: ['basic', 'reply', 'usage', 'reaction'],
  run: main,
}

runDirectly(scenario)
