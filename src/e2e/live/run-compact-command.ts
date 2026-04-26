import './load-e2e-env.ts'

import { randomUUID } from 'node:crypto'
import { consola } from 'consola'
import type { LiveE2EScenario } from './scenario.ts'
import { runDirectly } from './scenario.ts'
import {
  createLiveE2EContext,
  delay,
  findReplyContaining,
  isUsageMessage,
  readSessionMessages,
  waitForThread,
  writeScenarioResult,
} from './scenario-utils.ts'

interface CompactCommandResult {
  failureMessage?: string
  matched: {
    compactReplyObserved: boolean
    compactReplyConcise: boolean
    compactReplyHasNoPath: boolean
    compactReplyOmitsSeedNoise: boolean
    firstReplyObserved: boolean
    noStaleUsageBeforeCompactReply: boolean
    persistedCompactSummary: boolean
  }
  commandMessageTs?: string
  compactReplyTs?: string
  passed: boolean
  staleUsageMessageTs?: string
  rootMessageTs?: string
  runId: string
}

async function main(): Promise<void> {
  const runId = randomUUID()
  const result: CompactCommandResult = {
    matched: {
      compactReplyObserved: false,
      compactReplyConcise: false,
      compactReplyHasNoPath: false,
      compactReplyOmitsSeedNoise: false,
      firstReplyObserved: false,
      noStaleUsageBeforeCompactReply: false,
      persistedCompactSummary: false,
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
        `<@${ctx.botUserId}> COMPACT_COMMAND_SEED ${runId}`,
        `Reply exactly: COMPACT_COMMAND_READY ${runId}`,
        'Do not use tools.',
      ].join('\n'),
      unfurl_links: false,
      unfurl_media: false,
    })
    result.rootMessageTs = rootMessage.ts

    await waitForThread(ctx, rootMessage.ts, (messages) => {
      const reply = findReplyContaining(messages, rootMessage.ts, `COMPACT_COMMAND_READY ${runId}`)
      result.matched.firstReplyObserved = Boolean(reply)
      return result.matched.firstReplyObserved
    })

    const commandMessage = await ctx.triggerClient.postMessage({
      channel: ctx.channelId,
      thread_ts: rootMessage.ts,
      text: `<@${ctx.botUserId}> /compact`,
      unfurl_links: false,
      unfurl_media: false,
    })
    result.commandMessageTs = commandMessage.ts

    await waitForThread(ctx, rootMessage.ts, async (messages) => {
      const reply = findReplyContaining(messages, rootMessage.ts, '[compact: manual]')
      result.matched.compactReplyObserved = Boolean(reply?.text?.includes('[compact: manual]'))

      if (result.matched.compactReplyObserved) {
        if (reply?.ts) {
          result.compactReplyTs = reply.ts
        }
        const staleUsage = messages.find((message) => {
          if (!message.ts || !reply?.ts || !commandMessage.ts) {
            return false
          }
          const messageTs = Number(message.ts)
          return (
            Number.isFinite(messageTs) &&
            messageTs > Number(commandMessage.ts) &&
            messageTs < Number(reply.ts) &&
            isUsageMessage(message)
          )
        })
        if (staleUsage?.ts) {
          result.staleUsageMessageTs = staleUsage.ts
        }
        result.matched.noStaleUsageBeforeCompactReply = !staleUsage
        result.matched.compactReplyConcise = (reply?.text?.length ?? Infinity) <= 1_600
        result.matched.compactReplyHasNoPath =
          !reply?.text?.includes('messages.jsonl') &&
          !reply?.text?.includes('.agent-slack/sessions') &&
          !reply?.text?.includes('/Users/')
        result.matched.compactReplyOmitsSeedNoise =
          !reply?.text?.includes('COMPACT_COMMAND_SEED') &&
          !reply?.text?.includes('COMPACT_COMMAND_READY') &&
          !reply?.text?.includes('Reply exactly') &&
          !reply?.text?.includes('Do not use tools')

        const jsonl = await readSessionMessages(rootMessage.ts)
        result.matched.persistedCompactSummary =
          jsonl.includes('[compact: manual]') && jsonl.includes('COMPACT_COMMAND_SEED')
      }

      return (
        result.matched.compactReplyObserved &&
        result.matched.compactReplyConcise &&
        result.matched.compactReplyHasNoPath &&
        result.matched.compactReplyOmitsSeedNoise &&
        result.matched.noStaleUsageBeforeCompactReply &&
        result.matched.persistedCompactSummary
      )
    })

    assertResult(result)
    result.passed = true
    await writeScenarioResult('compact-command', result)
    consola.info('Live compact command E2E passed.')
  } catch (error) {
    result.failureMessage = error instanceof Error ? error.message : String(error)
    caughtError = error
  } finally {
    await writeScenarioResult('compact-command', result).catch((error) => {
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

function assertResult(result: CompactCommandResult): void {
  const failures: string[] = []
  if (!result.matched.firstReplyObserved) failures.push('seed reply not observed')
  if (!result.matched.compactReplyObserved) failures.push('compact reply not observed')
  if (!result.matched.compactReplyConcise) failures.push('compact reply is too long')
  if (!result.matched.compactReplyHasNoPath) failures.push('compact reply contains path noise')
  if (!result.matched.compactReplyOmitsSeedNoise) {
    failures.push('compact reply contains low-value seed noise')
  }
  if (!result.matched.noStaleUsageBeforeCompactReply) {
    failures.push('stale usage/ending appeared between compact command and compact reply')
  }
  if (!result.matched.persistedCompactSummary) failures.push('compact summary not persisted')

  if (failures.length > 0) {
    throw new Error(`Live compact command E2E failed: ${failures.join('; ')}`)
  }
}

export const scenario: LiveE2EScenario = {
  id: 'compact-command',
  title: 'Compact Command',
  description: 'Send @mention /compact and verify compact summary reply + persistence.',
  keywords: ['compact', 'command', 'context'],
  run: main,
}

runDirectly(scenario)
