import './load-e2e-env.ts'

import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { consola } from 'consola'
import type { LiveE2EScenario } from './scenario.ts'
import { runDirectly } from './scenario.ts'
import {
  createLiveE2EContext,
  delay,
  findReplyContaining,
  findSessionDir,
  isUsageMessage,
  readSessionMessages,
  waitForThread,
  writeScenarioResult,
} from './scenario-utils.ts'

interface CompactCommandResult {
  failureMessage?: string
  matched: {
    compactReplyObserved: boolean
    compactReplyWithinNewBudget: boolean
    compactReplyHasNoPath: boolean
    compactReplyHasUserMessageVerbatim: boolean
    firstReplyObserved: boolean
    noStaleUsageBeforeCompactReply: boolean
    persistedCompactSummary: boolean
    persistedStructuredCompactMarker: boolean
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
      compactReplyWithinNewBudget: false,
      compactReplyHasNoPath: false,
      compactReplyHasUserMessageVerbatim: false,
      firstReplyObserved: false,
      noStaleUsageBeforeCompactReply: false,
      persistedCompactSummary: false,
      persistedStructuredCompactMarker: false,
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
      const reply = findReplyContaining(
        messages,
        rootMessage.ts,
        `COMPACT_COMMAND_READY ${runId}`,
        ctx.botUserId,
      )
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
      const reply = findReplyContaining(
        messages,
        rootMessage.ts,
        '[compact: manual]',
        ctx.botUserId,
      )
      result.matched.compactReplyObserved = Boolean(reply?.text?.includes('[compact: manual]'))

      if (result.matched.compactReplyObserved) {
        if (reply?.ts) {
          result.compactReplyTs = reply.ts
        }
        const staleUsage = messages.find((message) => {
          if (!message.ts || !reply?.ts || !commandMessage.ts) {
            return false
          }
          if (message.user !== ctx.botUserId) {
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
        // 9 章节 prompt 产出的 summary 显著长于老版（plan §3.7.6.3 预期 5K-30K chars）；
        // 给一点 buffer 取 32K 上限，超过基本是模型异常。
        result.matched.compactReplyWithinNewBudget = (reply?.text?.length ?? Infinity) <= 32_000
        result.matched.compactReplyHasNoPath =
          !reply?.text?.includes('messages.jsonl') &&
          !reply?.text?.includes('.agent-slack/sessions') &&
          !reply?.text?.includes('/Users/')
        // 9 章节 prompt 第 6 节要求"全部用户消息 verbatim 不省略"——seed/握手文本本就该出现。
        // 该断言取代 compactReplyOmitsSeedNoise：现在反过来要求 seed 文本作为 verbatim 证据。
        result.matched.compactReplyHasUserMessageVerbatim =
          (reply?.text?.includes('COMPACT_COMMAND_SEED') ?? false) ||
          (reply?.text?.includes('COMPACT_COMMAND_READY') ?? false)

        const jsonl = await readSessionMessages(rootMessage.ts)
        result.matched.persistedCompactSummary =
          jsonl.includes('[compact: manual]') && jsonl.includes('COMPACT_COMMAND_SEED')
        const compactRecords = await readCompactRecords(rootMessage.ts)
        result.matched.persistedStructuredCompactMarker = compactRecords.some(
          (record) => record.mode === 'manual' && typeof record.messageId === 'string',
        )
      }

      return (
        result.matched.compactReplyObserved &&
        result.matched.compactReplyWithinNewBudget &&
        result.matched.compactReplyHasNoPath &&
        result.matched.compactReplyHasUserMessageVerbatim &&
        result.matched.noStaleUsageBeforeCompactReply &&
        result.matched.persistedCompactSummary &&
        result.matched.persistedStructuredCompactMarker
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
  if (!result.matched.compactReplyWithinNewBudget) {
    failures.push('compact reply exceeds 32K-char budget (likely model anomaly)')
  }
  if (!result.matched.compactReplyHasNoPath) failures.push('compact reply contains path noise')
  if (!result.matched.compactReplyHasUserMessageVerbatim) {
    failures.push('compact reply missing verbatim user-message evidence (§3.7.6.3 §6)')
  }
  if (!result.matched.noStaleUsageBeforeCompactReply) {
    failures.push('stale usage/ending appeared between compact command and compact reply')
  }
  if (!result.matched.persistedCompactSummary) failures.push('compact summary not persisted')
  if (!result.matched.persistedStructuredCompactMarker) {
    failures.push('structured compact marker not persisted')
  }

  if (failures.length > 0) {
    throw new Error(`Live compact command E2E failed: ${failures.join('; ')}`)
  }
}

async function readCompactRecords(
  threadTs: string,
): Promise<Array<{ messageId?: string; mode?: string }>> {
  const sessionDir = await findSessionDir(threadTs)
  const raw = await fs.readFile(path.join(sessionDir, 'compact.jsonl'), 'utf8')
  return raw
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as { messageId?: string; mode?: string })
}

export const scenario: LiveE2EScenario = {
  id: 'compact-command',
  title: 'Compact Command',
  description: 'Send @mention /compact and verify compact summary reply + persistence.',
  keywords: ['compact', 'command', 'context'],
  run: main,
}

runDirectly(scenario)
