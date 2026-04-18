import { describe, expect, it, beforeEach } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createSessionStore } from '@/store/SessionStore.ts'
import { resolveWorkspacePaths } from '@/workspace/paths.ts'
import { createConversationOrchestrator } from './ConversationOrchestrator.ts'
import type { AgentExecutor } from '@/agent/AgentExecutor.ts'
import type { AgentExecutionEvent } from '@/core/events.ts'
import type { Logger } from '@/logger/logger.ts'

function stubLogger(): Logger {
  const l: Logger = {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
    withTag: () => stubLogger(),
  }
  return l
}

describe('ConversationOrchestrator', () => {
  let cwd: string
  beforeEach(() => {
    cwd = mkdtempSync(path.join(tmpdir(), 'orch-'))
  })

  it('完整流程：持久化 user + assistant，累加 usage', async () => {
    const paths = resolveWorkspacePaths(cwd)
    const store = createSessionStore(paths)
    const events: AgentExecutionEvent[] = [
      { type: 'step_start' },
      { type: 'text_delta', text: 'hello' },
      { type: 'step_finish', usage: { inputTokens: 3, outputTokens: 1 } },
      {
        type: 'done',
        finalText: 'hello',
        totalUsage: {
          model: 'm',
          durationMs: 1,
          inputTokens: 3,
          outputTokens: 1,
          cachedInputTokens: 0,
        },
      },
    ]
    const executor: AgentExecutor = {
      async *execute() {
        for (const e of events) yield e
      },
    }
    const emitted: AgentExecutionEvent[] = []
    const sink = {
      emit: (e: AgentExecutionEvent) => {
        emitted.push(e)
      },
      done: async () => {},
      fail: async () => {},
    }
    const orch = createConversationOrchestrator({
      executor,
      sessionStore: store,
      systemPrompt: '',
      logger: stubLogger(),
    })
    await orch.handle(
      {
        imProvider: 'slack',
        channelId: 'C',
        channelName: 'c',
        threadTs: 't',
        userId: 'U',
        text: 'hi',
        messageTs: 'm1',
      },
      sink,
    )
    expect(emitted.map((e) => e.type)).toContain('done')
    const msgs = await store.loadMessages('slack:C:t')
    expect(msgs).toHaveLength(2)
    expect(msgs[1]).toMatchObject({ role: 'assistant' })
  })
})
