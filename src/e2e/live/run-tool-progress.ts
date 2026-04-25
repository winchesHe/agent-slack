import './load-e2e-env.ts'

import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { consola } from 'consola'
import { resolveWorkspacePaths } from '@/workspace/paths.ts'
import type { LiveE2EScenario } from './scenario.ts'
import { runDirectly } from './scenario.ts'
import {
  createLiveE2EContext,
  delay,
  findReplyContaining,
  findUsageMessage,
  hasUsageMessage,
  readSessionMessages,
  waitForThread,
  writeScenarioResult,
} from './scenario-utils.ts'

interface ToolProgressResult {
  assistantReplyText?: string
  assistantReplyTs?: string
  failureMessage?: string
  skillFile?: string
  usageText?: string
  matched: {
    assistantReplied: boolean
    bashToolCallPersisted: boolean
    bashToolResultPersisted: boolean
    skillToolCallPersisted: boolean
    skillTailObserved: boolean
    toolsTailObserved: boolean
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
      skillToolCallPersisted: false,
      skillTailObserved: false,
      toolsTailObserved: false,
      usageObserved: false,
    },
    passed: false,
    runId,
  }
  const skillFile = await createTemporarySkill(runId)
  result.skillFile = skillFile
  let ctx: Awaited<ReturnType<typeof createLiveE2EContext>> | undefined
  let caughtError: unknown

  try {
    ctx = await createLiveE2EContext(runId)
    await ctx.application.start()
    await delay(3_000)

    const rootMessage = await ctx.triggerClient.postMessage({
      channel: ctx.channelId,
      text: [
        `<@${ctx.botUserId}> TOOL_PROGRESS_E2E ${runId}`,
        `You must call the bash tool to read this skill file before any reply: cat ${skillFile}`,
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
      const usage = findUsageMessage(messages, rootMessage.ts)
      if (typeof usage?.text === 'string') {
        result.usageText = usage.text
      }
      result.matched.toolsTailObserved = hasPositiveTailCount(usage?.text, ':agent_tool:')
      result.matched.skillTailObserved = hasPositiveTailCount(usage?.text, ':agent_skill:')

      if (result.matched.assistantReplied) {
        const jsonl = await readSessionMessages(rootMessage.ts)
        result.matched.bashToolCallPersisted =
          jsonl.includes('"toolName":"bash"') && jsonl.includes(`printf ${marker}`)
        result.matched.bashToolResultPersisted = jsonl
          .split('\n')
          .some((line) => line.includes('"role":"tool"') && line.includes(marker))
        result.matched.skillToolCallPersisted = jsonl.includes(skillFile)
      }

      return (
        result.matched.assistantReplied &&
        result.matched.usageObserved &&
        result.matched.toolsTailObserved &&
        result.matched.skillTailObserved &&
        result.matched.bashToolCallPersisted &&
        result.matched.bashToolResultPersisted &&
        result.matched.skillToolCallPersisted
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
    if (ctx) {
      await ctx.application.stop().catch((error) => {
        consola.error('Failed to stop application:', error)
      })
    }
    await fs.rm(path.dirname(skillFile), { recursive: true, force: true }).catch((error) => {
      consola.error('Failed to remove temporary skill:', error)
    })
  }

  if (caughtError) {
    throw caughtError
  }
}

async function createTemporarySkill(runId: string): Promise<string> {
  const skillDir = path.join(resolveWorkspacePaths(process.cwd()).skillsDir, `e2e-tail-${runId}`)
  const skillFile = path.join(skillDir, 'SKILL.md')
  await fs.mkdir(skillDir, { recursive: true })
  await fs.writeFile(
    skillFile,
    [
      '---',
      `name: e2e-tail-${runId}`,
      'description: Temporary live E2E skill for Slack usage tail stats',
      '---',
      '',
      `When this skill is read, remember TOOL_PROGRESS_SKILL_${runId}.`,
      '',
    ].join('\n'),
    'utf8',
  )
  return skillFile
}

function hasPositiveTailCount(text: string | undefined, emoji: string): boolean {
  if (!text?.includes(emoji)) {
    return false
  }
  const escaped = emoji.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`${escaped}\\s+[1-9]\\d*\\s+\\w+`).test(text)
}

function assertResult(result: ToolProgressResult): void {
  const failures: string[] = []
  if (!result.matched.assistantReplied) failures.push('assistant reply not observed')
  if (!result.matched.usageObserved) failures.push('usage message not observed')
  if (!result.matched.toolsTailObserved) failures.push('tools tail not observed')
  if (!result.matched.skillTailObserved) failures.push('skill tail not observed')
  if (!result.matched.bashToolCallPersisted) failures.push('bash tool call not persisted')
  if (!result.matched.bashToolResultPersisted) failures.push('bash tool result not persisted')
  if (!result.matched.skillToolCallPersisted) failures.push('skill tool call not persisted')

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
