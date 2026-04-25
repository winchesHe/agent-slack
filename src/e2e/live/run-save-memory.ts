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
  waitForThread,
  writeScenarioResult,
} from './scenario-utils.ts'

interface SaveMemoryResult {
  assistantReplyText?: string
  assistantReplyTs?: string
  failureMessage?: string
  usageText?: string
  matched: {
    assistantReplied: boolean
    memoryMarkerPersisted: boolean
    memoryTailObserved: boolean
    usageObserved: boolean
  }
  passed: boolean
  rootMessageTs?: string
  runId: string
}

type MemorySnapshot = Map<string, string>

async function main(): Promise<void> {
  const runId = randomUUID()
  const marker = `SAVE_MEMORY_MARKER ${runId}`
  const result: SaveMemoryResult = {
    matched: {
      assistantReplied: false,
      memoryMarkerPersisted: false,
      memoryTailObserved: false,
      usageObserved: false,
    },
    passed: false,
    runId,
  }
  const snapshot = await snapshotMemory()
  const ctx = await createLiveE2EContext(runId)
  let caughtError: unknown

  try {
    await ctx.application.start()
    await delay(3_000)

    const rootMessage = await ctx.triggerClient.postMessage({
      channel: ctx.channelId,
      text: [
        `<@${ctx.botUserId}> SAVE_MEMORY_E2E ${runId}`,
        `Call save_memory so the user's memory contains this exact line: ${marker}`,
        'If existing memory is present, preserve it and append the marker.',
        `Then reply exactly: SAVE_MEMORY_OK ${runId}`,
      ].join('\n'),
      unfurl_links: false,
      unfurl_media: false,
    })
    result.rootMessageTs = rootMessage.ts

    await waitForThread(ctx, rootMessage.ts, async (messages) => {
      const reply = findReplyContaining(messages, rootMessage.ts, `SAVE_MEMORY_OK ${runId}`)
      if (reply) {
        result.assistantReplyText = reply.text ?? ''
        result.assistantReplyTs = reply.ts ?? ''
        result.matched.assistantReplied = true
      }

      result.matched.memoryMarkerPersisted = await memoryContains(marker)
      const usage = findUsageMessage(messages, rootMessage.ts)
      if (typeof usage?.text === 'string') {
        result.usageText = usage.text
      }
      result.matched.usageObserved = usage !== undefined
      result.matched.memoryTailObserved = hasPositiveTailCount(usage?.text, ':agent_memory:')

      return (
        result.matched.assistantReplied &&
        result.matched.memoryMarkerPersisted &&
        result.matched.usageObserved &&
        result.matched.memoryTailObserved
      )
    })

    assertResult(result)
    result.passed = true
    await writeScenarioResult('save-memory', result)
    consola.info('Live save memory E2E passed.')
  } catch (error) {
    result.failureMessage = error instanceof Error ? error.message : String(error)
    caughtError = error
  } finally {
    await writeScenarioResult('save-memory', result).catch((error) => {
      consola.error('Failed to persist result:', error)
    })
    await ctx.application.stop().catch((error) => {
      consola.error('Failed to stop application:', error)
    })
    await restoreMemory(snapshot).catch((error) => {
      consola.error('Failed to restore memory snapshot:', error)
    })
  }

  if (caughtError) {
    throw caughtError
  }
}

async function snapshotMemory(): Promise<MemorySnapshot> {
  const dir = resolveWorkspacePaths(process.cwd()).memoryDir
  const snapshot: MemorySnapshot = new Map()
  await fs.mkdir(dir, { recursive: true })
  const entries = await fs.readdir(dir, { withFileTypes: true })

  for (const entry of entries) {
    if (entry.isFile() && entry.name.endsWith('.md')) {
      const file = path.join(dir, entry.name)
      snapshot.set(file, await fs.readFile(file, 'utf8'))
    }
  }

  return snapshot
}

async function restoreMemory(snapshot: MemorySnapshot): Promise<void> {
  const dir = resolveWorkspacePaths(process.cwd()).memoryDir
  await fs.mkdir(dir, { recursive: true })
  const entries = await fs.readdir(dir, { withFileTypes: true })

  for (const entry of entries) {
    if (entry.isFile() && entry.name.endsWith('.md')) {
      const file = path.join(dir, entry.name)
      if (!snapshot.has(file)) {
        await fs.rm(file)
      }
    }
  }

  for (const [file, content] of snapshot) {
    await fs.writeFile(file, content, 'utf8')
  }
}

async function memoryContains(marker: string): Promise<boolean> {
  const dir = resolveWorkspacePaths(process.cwd()).memoryDir
  await fs.mkdir(dir, { recursive: true })
  const entries = await fs.readdir(dir, { withFileTypes: true })

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.md')) {
      continue
    }
    const content = await fs.readFile(path.join(dir, entry.name), 'utf8')
    if (content.includes(marker)) {
      return true
    }
  }

  return false
}

function hasPositiveTailCount(text: string | undefined, emoji: string): boolean {
  if (!text?.includes(emoji)) {
    return false
  }
  const escaped = emoji.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`${escaped}\\s+[1-9]\\d*\\s+\\w+`).test(text)
}

function assertResult(result: SaveMemoryResult): void {
  const failures: string[] = []
  if (!result.matched.assistantReplied) failures.push('assistant reply not observed')
  if (!result.matched.memoryMarkerPersisted) failures.push('memory marker not persisted')
  if (!result.matched.usageObserved) failures.push('usage message not observed')
  if (!result.matched.memoryTailObserved) failures.push('memory tail not observed')

  if (failures.length > 0) {
    throw new Error(`Live save memory E2E failed: ${failures.join('; ')}`)
  }
}

export const scenario: LiveE2EScenario = {
  id: 'save-memory',
  title: 'Save Memory',
  description: 'Mention the bot, force save_memory, and verify the marker reaches file storage.',
  keywords: ['memory', 'save-memory', 'tool', 'files'],
  run: main,
}

runDirectly(scenario)
