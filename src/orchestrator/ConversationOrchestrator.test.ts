import { describe, expect, it, beforeEach, vi } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { CoreMessage } from 'ai'
import { createSessionStore } from '@/store/SessionStore.ts'
import { createMemoryStore } from '@/store/MemoryStore.ts'
import { resolveWorkspacePaths } from '@/workspace/paths.ts'
import { createConversationOrchestrator } from './ConversationOrchestrator.ts'
import type { AgentExecutor, AgentExecutionRequest } from '@/agent/AgentExecutor.ts'
import type { AgentExecutionEvent } from '@/core/events.ts'
import type { EventSink, InboundMessage } from '@/im/types.ts'
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

/**
 * mock sink：记录所有 event，暴露 terminalPhase，支持计量器方式启用模拟 finalize 异常
 */
function mockSink() {
  const events: AgentExecutionEvent[] = []
  let terminalPhase: 'completed' | 'stopped' | 'failed' | undefined
  const sink: EventSink = {
    onEvent: async (e: AgentExecutionEvent) => {
      events.push(e)
      if (e.type === 'lifecycle' && !terminalPhase && e.phase !== 'started') {
        terminalPhase = e.phase
      }
    },
    finalize: vi.fn(async () => {}),
    get terminalPhase() {
      return terminalPhase
    },
  }
  return { sink, events, get terminalPhase() { return terminalPhase } }
}

function makeInput(overrides: Partial<InboundMessage> = {}): InboundMessage {
  return {
    imProvider: 'slack',
    channelId: 'C',
    channelName: 'c',
    threadTs: 't',
    userId: 'U',
    userName: 'alice',
    text: 'hi',
    messageTs: 'm1',
    ...overrides,
  }
}

function makeExecutor(events: AgentExecutionEvent[]): AgentExecutor {
  return {
    async *execute(_req: AgentExecutionRequest) {
      for (const e of events) yield e
    },
  }
}

describe('ConversationOrchestrator 粗事件消费', () => {
  let cwd: string
  beforeEach(() => {
    cwd = mkdtempSync(path.join(tmpdir(), 'orch-'))
  })

  it('completed + finalMessages → 整批 appendMessage + idle 状态 + finalize 被调', async () => {
    const paths = resolveWorkspacePaths(cwd)
    const store = createSessionStore(paths)
    const memoryStore = createMemoryStore(paths)
    const finalMessages: CoreMessage[] = [
      { role: 'assistant', content: 'hello' },
      { role: 'assistant', content: 'world' },
    ]
    const executor = makeExecutor([
      { type: 'lifecycle', phase: 'started' },
      { type: 'activity-state', state: { status: '思考中…', activities: [] } },
      { type: 'assistant-message', text: 'hello' },
      { type: 'assistant-message', text: 'world' },
      {
        type: 'usage-info',
        usage: {
          durationMs: 10,
          totalCostUSD: 0,
          modelUsage: [{
            model: 'm', inputTokens: 3, outputTokens: 2, cachedInputTokens: 0, cacheHitRate: 0,
          }],
        },
      },
      { type: 'lifecycle', phase: 'completed', finalMessages },
    ])
    const { sink } = mockSink()
    const orch = createConversationOrchestrator({
      toolsBuilder: () => ({}),
      executorFactory: () => executor,
      sessionStore: store,
      memoryStore,
      systemPrompt: '',
      logger: stubLogger(),
    })
    await orch.handle(makeInput(), sink)

    const msgs = await store.loadMessages('slack:C:t')
    // 1 条 user + 2 条 finalMessages
    expect(msgs).toHaveLength(3)
    expect(msgs[0]).toMatchObject({ role: 'user' })
    expect(msgs[1]).toMatchObject({ role: 'assistant', content: 'hello' })
    expect(msgs[2]).toMatchObject({ role: 'assistant', content: 'world' })

    const meta = await store.getMeta('slack:C:t')
    expect(meta?.status).toBe('idle')
    expect(sink.finalize).toHaveBeenCalledTimes(1)
  })

  it('stopped + finalMessages → 先写 finalMessages 再写 [stopped] 标记 + status=stopped', async () => {
    const paths = resolveWorkspacePaths(cwd)
    const store = createSessionStore(paths)
    const memoryStore = createMemoryStore(paths)
    const finalMessages: CoreMessage[] = [{ role: 'assistant', content: 'partial' }]
    const executor = makeExecutor([
      { type: 'lifecycle', phase: 'started' },
      { type: 'assistant-message', text: 'partial' },
      { type: 'lifecycle', phase: 'stopped', reason: 'user', finalMessages },
    ])
    const { sink } = mockSink()
    const orch = createConversationOrchestrator({
      toolsBuilder: () => ({}),
      executorFactory: () => executor,
      sessionStore: store,
      memoryStore,
      systemPrompt: '',
      logger: stubLogger(),
    })
    await orch.handle(makeInput(), sink)

    const msgs = await store.loadMessages('slack:C:t')
    // user + partial + [stopped]
    expect(msgs).toHaveLength(3)
    expect(msgs[1]).toMatchObject({ role: 'assistant', content: 'partial' })
    expect(msgs[2]).toMatchObject({ role: 'assistant', content: '[stopped]' })

    const meta = await store.getMeta('slack:C:t')
    expect(meta?.status).toBe('stopped')
    expect(sink.finalize).toHaveBeenCalledTimes(1)
  })

  it('stopped 不带 finalMessages → 仅写 [stopped] 标记', async () => {
    const paths = resolveWorkspacePaths(cwd)
    const store = createSessionStore(paths)
    const memoryStore = createMemoryStore(paths)
    const executor = makeExecutor([
      { type: 'lifecycle', phase: 'started' },
      { type: 'lifecycle', phase: 'stopped', reason: 'user' },
    ])
    const { sink } = mockSink()
    const orch = createConversationOrchestrator({
      toolsBuilder: () => ({}),
      executorFactory: () => executor,
      sessionStore: store,
      memoryStore,
      systemPrompt: '',
      logger: stubLogger(),
    })
    await orch.handle(makeInput(), sink)
    const msgs = await store.loadMessages('slack:C:t')
    // user + [stopped]
    expect(msgs).toHaveLength(2)
    expect(msgs[1]).toMatchObject({ role: 'assistant', content: '[stopped]' })
  })

  it('failed → 写 [error: ...] 标记 + status=error，不尝试读 finalMessages', async () => {
    const paths = resolveWorkspacePaths(cwd)
    const store = createSessionStore(paths)
    const memoryStore = createMemoryStore(paths)
    const executor = makeExecutor([
      { type: 'lifecycle', phase: 'started' },
      { type: 'lifecycle', phase: 'failed', error: { message: 'boom' } },
    ])
    const { sink } = mockSink()
    const orch = createConversationOrchestrator({
      toolsBuilder: () => ({}),
      executorFactory: () => executor,
      sessionStore: store,
      memoryStore,
      systemPrompt: '',
      logger: stubLogger(),
    })
    await orch.handle(makeInput(), sink)

    const msgs = await store.loadMessages('slack:C:t')
    expect(msgs).toHaveLength(2)
    expect(msgs[1]).toMatchObject({
      role: 'assistant',
      content: '[error: boom]',
    })
    const meta = await store.getMeta('slack:C:t')
    expect(meta?.status).toBe('error')
    expect(sink.finalize).toHaveBeenCalledTimes(1)
  })

  it('orchestrator 内部异常 → emitSyntheticFailed 注入 failed 事件 + finalize 仍执行', async () => {
    const paths = resolveWorkspacePaths(cwd)
    const store = createSessionStore(paths)
    const memoryStore = createMemoryStore(paths)
    // executor 在 yield 中报错（非 AbortError）模拟码级异常
    const executor: AgentExecutor = {
      async *execute() {
        yield { type: 'lifecycle', phase: 'started' }
        throw new Error('sink persistence crashed')
      },
    }
    const { sink, events } = mockSink()
    const orch = createConversationOrchestrator({
      toolsBuilder: () => ({}),
      executorFactory: () => executor,
      sessionStore: store,
      memoryStore,
      systemPrompt: '',
      logger: stubLogger(),
    })
    await orch.handle(makeInput(), sink)

    // sink 应该收到 synthetic failed 事件
    const failed = events.find(
      (e) => e.type === 'lifecycle' && e.phase === 'failed',
    )
    expect(failed).toBeDefined()
    expect((failed as { error?: { message: string } }).error?.message).toContain('sink persistence crashed')

    // finalize 记录被调
    expect(sink.finalize).toHaveBeenCalledTimes(1)

    // jsonl 应有 [error: ...] 标记
    const msgs = await store.loadMessages('slack:C:t')
    expect(msgs.at(-1)).toMatchObject({
      role: 'assistant',
      content: expect.stringContaining('sink persistence crashed'),
    })
    const meta = await store.getMeta('slack:C:t')
    expect(meta?.status).toBe('error')
  })

  it('memory 存在时 systemPrompt 注入路径提示（保留原有行为）', async () => {
    const paths = resolveWorkspacePaths(cwd)
    const store = createSessionStore(paths)
    const memoryStore = createMemoryStore(paths)
    await memoryStore.save({ userName: 'bob', userId: 'U2', content: 'hi' })

    let capturedSystem = ''
    const executor: AgentExecutor = {
      async *execute(req: AgentExecutionRequest) {
        capturedSystem = req.systemPrompt
        yield { type: 'lifecycle', phase: 'started' }
        yield { type: 'lifecycle', phase: 'completed', finalMessages: [] }
      },
    }
    const { sink } = mockSink()
    const orch = createConversationOrchestrator({
      toolsBuilder: () => ({}),
      executorFactory: () => executor,
      sessionStore: store,
      memoryStore,
      systemPrompt: '你是助手。',
      logger: stubLogger(),
    })
    await orch.handle(makeInput({ userId: 'U2', userName: 'bob' }), sink)
    expect(capturedSystem).toContain('你是助手')
    expect(capturedSystem).toContain('长期记忆')
    expect(capturedSystem).toContain('bob-U2.md')
  })
})
