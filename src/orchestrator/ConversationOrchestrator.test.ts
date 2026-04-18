import { describe, expect, it, beforeEach } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createSessionStore } from '@/store/SessionStore.ts'
import { createMemoryStore } from '@/store/MemoryStore.ts'
import { resolveWorkspacePaths } from '@/workspace/paths.ts'
import { createConversationOrchestrator } from './ConversationOrchestrator.ts'
import type { AgentExecutor, AgentExecutionRequest } from '@/agent/AgentExecutor.ts'
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

  const makeEvents = (): AgentExecutionEvent[] => [
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

  it('完整流程：持久化 user + assistant，累加 usage', async () => {
    const paths = resolveWorkspacePaths(cwd)
    const store = createSessionStore(paths)
    const memoryStore = createMemoryStore(paths)
    const executor: AgentExecutor = {
      async *execute() {
        for (const e of makeEvents()) yield e
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
      toolsBuilder: () => ({}),
      executorFactory: () => executor,
      sessionStore: store,
      memoryStore,
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
        userName: 'alice',
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

  it('memory 存在时 systemPrompt 注入路径提示', async () => {
    const paths = resolveWorkspacePaths(cwd)
    const store = createSessionStore(paths)
    const memoryStore = createMemoryStore(paths)
    // 预先写入该用户的 memory
    await memoryStore.save({ userName: 'bob', userId: 'U2', content: 'hi' })

    let capturedSystem = ''
    const executor: AgentExecutor = {
      async *execute(req: AgentExecutionRequest) {
        capturedSystem = req.systemPrompt
        for (const e of makeEvents()) yield e
      },
    }
    const sink = { emit: () => {}, done: async () => {}, fail: async () => {} }
    const orch = createConversationOrchestrator({
      toolsBuilder: () => ({}),
      executorFactory: () => executor,
      sessionStore: store,
      memoryStore,
      systemPrompt: '你是助手。',
      logger: stubLogger(),
    })
    await orch.handle(
      {
        imProvider: 'slack',
        channelId: 'C',
        channelName: 'c',
        threadTs: 't',
        userId: 'U2',
        userName: 'bob',
        text: 'hi',
        messageTs: 'm1',
      },
      sink,
    )
    expect(capturedSystem).toContain('你是助手')
    expect(capturedSystem).toContain('长期记忆')
    expect(capturedSystem).toContain('bob-U2.md')
  })

  it('memory 不存在时 systemPrompt 提示暂无记忆', async () => {
    const paths = resolveWorkspacePaths(cwd)
    const store = createSessionStore(paths)
    const memoryStore = createMemoryStore(paths)

    let capturedSystem = ''
    const executor: AgentExecutor = {
      async *execute(req: AgentExecutionRequest) {
        capturedSystem = req.systemPrompt
        for (const e of makeEvents()) yield e
      },
    }
    const sink = { emit: () => {}, done: async () => {}, fail: async () => {} }
    const orch = createConversationOrchestrator({
      toolsBuilder: () => ({}),
      executorFactory: () => executor,
      sessionStore: store,
      memoryStore,
      systemPrompt: '',
      logger: stubLogger(),
    })
    await orch.handle(
      {
        imProvider: 'slack',
        channelId: 'C',
        channelName: 'c',
        threadTs: 't',
        userId: 'U3',
        userName: 'carol',
        text: 'hi',
        messageTs: 'm1',
      },
      sink,
    )
    expect(capturedSystem).toContain('没有关于该用户')
    expect(capturedSystem).not.toMatch(/长期记忆在：/)
  })
})
