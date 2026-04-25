import './load-e2e-env.ts'

import { randomUUID } from 'node:crypto'
import { consola } from 'consola'
import type { LiveE2EScenario } from './scenario.ts'
import { runDirectly } from './scenario.ts'
import {
  createLiveE2EContext,
  delay,
  findReplyContaining,
  hasUsageMessage,
  readSessionMessages,
  waitForThread,
  writeScenarioResult,
} from './scenario-utils.ts'

interface ToolProgressResult {
  assistantReplyText?: string
  assistantReplyTs?: string
  failureMessage?: string
  matched: {
    assistantReplied: boolean
    bashToolCallPersisted: boolean
    bashToolResultPersisted: boolean
    usageObserved: boolean
  }
  passed: boolean
  rootMessageTs?: string
  runId: string
}

async function main(): Promise<void> {
  const runId = randomUUID()
  const marker = `TOOL_PROGRESS_MARKER_${runId}`
  const result: ToolProgressResult = {
    matched: {
      assistantReplied: false,
      bashToolCallPersisted: false,
      bashToolResultPersisted: false,
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
        `<@${ctx.botUserId}> TOOL_PROGRESS_E2E ${runId}`,
        `You must call the bash tool once with command: printf ${marker}`,
        `Then reply with: TOOL_PROGRESS_OK ${runId}`,
        `Include the command output ${marker}. Do not modify files.`,
      ].join('\n'),
      unfurl_links: false,
      unfurl_media: false,
    })
    result.rootMessageTs = rootMessage.ts

    await waitForThread(ctx, rootMessage.ts, async (messages) => {
      const reply = findReplyContaining(messages, rootMessage.ts, `TOOL_PROGRESS_OK ${runId}`)
      if (reply) {
        result.assistantReplyText = reply.text ?? ''
        result.assistantReplyTs = reply.ts ?? ''
        result.matched.assistantReplied = true
      }

      result.matched.usageObserved = hasUsageMessage(messages, rootMessage.ts)

      if (result.matched.assistantReplied) {
        const jsonl = await readSessionMessages(rootMessage.ts)
        result.matched.bashToolCallPersisted =
          jsonl.includes('"toolName":"bash"') && jsonl.includes(`printf ${marker}`)
        result.matched.bashToolResultPersisted =
          jsonl.includes('"role":"tool"') && jsonl.includes(`"stdout":"${marker}`)
      }

      return (
        result.matched.assistantReplied &&
        result.matched.usageObserved &&
        result.matched.bashToolCallPersisted &&
        result.matched.bashToolResultPersisted
      )
    })

    assertResult(result)
    result.passed = true
    await writeScenarioResult('tool-progress', result)
    consola.info('Live tool progress E2E passed.')
  } catch (error) {
    result.failureMessage = error instanceof Error ? error.message : String(error)
    caughtError = error
  } finally {
    await writeScenarioResult('tool-progress', result).catch((error) => {
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

function assertResult(result: ToolProgressResult): void {
  const failures: string[] = []
  if (!result.matched.assistantReplied) failures.push('assistant reply not observed')
  if (!result.matched.usageObserved) failures.push('usage message not observed')
  if (!result.matched.bashToolCallPersisted) failures.push('bash tool call not persisted')
  if (!result.matched.bashToolResultPersisted) failures.push('bash tool result not persisted')

  if (failures.length > 0) {
    throw new Error(`Live tool progress E2E failed: ${failures.join('; ')}`)
  }
}

export const scenario: LiveE2EScenario = {
  id: 'tool-progress',
  title: 'Tool Progress',
  description: 'Mention the bot, force a bash tool call, and verify tool messages are persisted.',
  keywords: ['tool', 'progress', 'bash', 'session'],
  run: main,
}

runDirectly(scenario)
