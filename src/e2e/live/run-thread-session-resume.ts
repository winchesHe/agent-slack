import './load-e2e-env.ts'

import { randomUUID } from 'node:crypto'
import { consola } from 'consola'
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

interface ThreadSessionResumeResult {
  failureMessage?: string
  firstReplyTs?: string
  matched: {
    firstReplyObserved: boolean
    secondReplyObserved: boolean
    sessionHasTwoUserMessages: boolean
  }
  passed: boolean
  rootMessageTs?: string
  runId: string
  secondMessageTs?: string
  secondReplyText?: string
  secondReplyTs?: string
}

async function main(): Promise<void> {
  const runId = randomUUID()
  const marker = `THREAD_CONTEXT_MARKER ${runId}`
  const result: ThreadSessionResumeResult = {
    matched: {
      firstReplyObserved: false,
      secondReplyObserved: false,
      sessionHasTwoUserMessages: false,
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
        `<@${ctx.botUserId}> THREAD_RESUME_FIRST ${runId}`,
        `Reply exactly: THREAD_FIRST_OK ${runId}`,
        `Remember this thread marker for later: ${marker}`,
        'Do not use tools.',
      ].join('\n'),
      unfurl_links: false,
      unfurl_media: false,
    })
    result.rootMessageTs = rootMessage.ts

    await waitForThread(ctx, rootMessage.ts, (messages) => {
      const reply = findReplyContaining(messages, rootMessage.ts, `THREAD_FIRST_OK ${runId}`)
      if (reply) {
        result.firstReplyTs = reply.ts ?? ''
        result.matched.firstReplyObserved = true
      }
      return result.matched.firstReplyObserved
    })

    const secondMessage = await ctx.triggerClient.postMessage({
      channel: ctx.channelId,
      thread_ts: rootMessage.ts,
      text: [
        `<@${ctx.botUserId}> THREAD_RESUME_SECOND ${runId}`,
        'Use the previous messages in this same Slack thread.',
        `Reply exactly: THREAD_RESUME_OK ${runId} ${marker}`,
        'Do not use tools.',
      ].join('\n'),
      unfurl_links: false,
      unfurl_media: false,
    })
    result.secondMessageTs = secondMessage.ts

    await waitForThread(ctx, rootMessage.ts, async (messages) => {
      const reply = findReplyContaining(messages, rootMessage.ts, `THREAD_RESUME_OK ${runId}`)
      if (reply?.text?.includes(marker)) {
        result.secondReplyText = reply.text
        result.secondReplyTs = reply.ts ?? ''
        result.matched.secondReplyObserved = true
      }

      if (result.matched.secondReplyObserved) {
        const jsonl = await readSessionMessages(rootMessage.ts)
        const userMessages = jsonl
          .split('\n')
          .filter((line) => line.includes('"role":"user"')).length
        result.matched.sessionHasTwoUserMessages = userMessages >= 2
      }

      return result.matched.secondReplyObserved && result.matched.sessionHasTwoUserMessages
    })

    assertResult(result)
    result.passed = true
    await writeScenarioResult('thread-session-resume', result)
    consola.info('Live thread session resume E2E passed.')
  } catch (error) {
    result.failureMessage = error instanceof Error ? error.message : String(error)
    caughtError = error
  } finally {
    await writeScenarioResult('thread-session-resume', result).catch((error) => {
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

function assertResult(result: ThreadSessionResumeResult): void {
  const failures: string[] = []
  if (!result.matched.firstReplyObserved) failures.push('first reply not observed')
  if (!result.matched.secondReplyObserved) failures.push('second reply with marker not observed')
  if (!result.matched.sessionHasTwoUserMessages) failures.push('session did not persist two users')

  if (failures.length > 0) {
    throw new Error(`Live thread session resume E2E failed: ${failures.join('; ')}`)
  }
}

export const scenario: LiveE2EScenario = {
  id: 'thread-session-resume',
  title: 'Thread Session Resume',
  description: 'Send two mentions in one Slack thread and verify thread history is reused.',
  keywords: ['thread', 'session', 'resume', 'history'],
  run: main,
}

runDirectly(scenario)
