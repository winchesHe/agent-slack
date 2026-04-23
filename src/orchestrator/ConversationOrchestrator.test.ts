import { describe, expect, it, beforeEach, vi } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createSessionStore, type SessionStore } from '@/store/SessionStore.ts'
import { createMemoryStore } from '@/store/MemoryStore.ts'
import { resolveWorkspacePaths, slackSessionDir } from '@/workspace/paths.ts'
import { createConversationOrchestrator } from './ConversationOrchestrator.ts'
import { SessionRunQueue } from './SessionRunQueue.ts'
import { AbortRegistry } from './AbortRegistry.ts'
import type { AgentExecutor, AgentExecutionRequest } from '@/agent/AgentExecutor.ts'
import type { AgentExecutionEvent } from '@/core/events.ts'
import type { EventSink, InboundMessage } from '@/im/types.ts'
import type { Logger } from '@/logger/logger.ts'
import type { CoreMessage } from 'ai'

function stubLogger(overrides: Partial<Logger> = {}): Logger {
  const l: Logger = {
    trace: () => {},
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
    withTag: () => stubLogger(overrides),
    ...overrides,
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
  return {
    sink,
    events,
    get terminalPhase() {
      return terminalPhase
    },
  }
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

function buildCompletedToolFinalMessages(): Extract<
  AgentExecutionEvent,
  { type: 'lifecycle'; phase: 'completed' }
>['finalMessages'] {
  return [
    {
      id: 'msg-tool-call',
      role: 'assistant',
      content: [
        { type: 'text', text: '我先查一下。' },
        {
          type: 'tool-call',
          toolCallId: 'call_1',
          toolName: 'search_docs',
          args: { query: 'tool 历史' },
        },
      ],
    },
    {
      id: 'msg-tool-result',
      role: 'tool',
      content: [
        {
          type: 'tool-result',
          toolCallId: 'call_1',
          toolName: 'search_docs',
          result: { hits: [{ id: 'doc-1', title: '会话存储设计' }] },
        },
      ],
    },
    {
      id: 'msg-answer',
      role: 'assistant',
      content: '已找到相关文档。',
    },
  ]
}

function buildStoppedToolFinalMessages(): NonNullable<
  Extract<AgentExecutionEvent, { type: 'lifecycle'; phase: 'stopped' }>['finalMessages']
> {
  return [
    {
      id: 'msg-stop-tool-call',
      role: 'assistant',
      content: [
        {
          type: 'tool-call',
          toolCallId: 'call_stop_1',
          toolName: 'search_docs',
          args: { query: '中断前历史' },
        },
      ],
    },
    {
      id: 'msg-stop-tool-result',
      role: 'tool',
      content: [
        {
          type: 'tool-result',
          toolCallId: 'call_stop_1',
          toolName: 'search_docs',
          result: { hits: [{ id: 'doc-stop-1' }] },
        },
      ],
    },
  ]
}

async function readMessagesJsonl(
  cwd: string,
  channelName = 'c',
  channelId = 'C',
  threadTs = 't',
): Promise<unknown[]> {
  const messagesFile = path.join(
    slackSessionDir(resolveWorkspacePaths(cwd), channelName, channelId, threadTs),
    'messages.jsonl',
  )
  const raw = await readFile(messagesFile, 'utf8')
  return raw
    .trim()
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as unknown)
}

async function waitUntil(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error('waitUntil timeout')
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
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
    const finalMessages: Extract<
      AgentExecutionEvent,
      { type: 'lifecycle'; phase: 'completed' }
    >['finalMessages'] = [
      { id: 'msg-1', role: 'assistant', content: 'hello' },
      { id: 'msg-2', role: 'assistant', content: 'world' },
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
          modelUsage: [
            {
              model: 'm',
              inputTokens: 3,
              outputTokens: 2,
              cachedInputTokens: 0,
              cacheHitRate: 0,
            },
          ],
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
      runQueue: new SessionRunQueue(),
      abortRegistry: new AbortRegistry<string>(),
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

  it('completed + tool finalMessages → user 后按顺序落盘 assistant(tool-call) / tool-result / assistant(text)', async () => {
    const paths = resolveWorkspacePaths(cwd)
    const store = createSessionStore(paths)
    const memoryStore = createMemoryStore(paths)
    const finalMessages = buildCompletedToolFinalMessages()
    const executor = makeExecutor([
      { type: 'lifecycle', phase: 'started' },
      { type: 'assistant-message', text: '我先查一下。' },
      { type: 'assistant-message', text: '已找到相关文档。' },
      { type: 'lifecycle', phase: 'completed', finalMessages },
    ])
    const { sink } = mockSink()
    const orch = createConversationOrchestrator({
      toolsBuilder: () => ({}),
      executorFactory: () => executor,
      sessionStore: store,
      memoryStore,
      runQueue: new SessionRunQueue(),
      abortRegistry: new AbortRegistry<string>(),
      systemPrompt: '',
      logger: stubLogger(),
    })

    await orch.handle(makeInput(), sink)

    const [toolCallMessage, toolResultMessage, finalAssistantMessage] = finalMessages
    expect(toolCallMessage).toBeDefined()
    expect(toolResultMessage).toBeDefined()
    expect(finalAssistantMessage).toBeDefined()

    const messages = await store.loadMessages('slack:C:t')
    expect(messages).toHaveLength(4)
    expect(messages[0]).toMatchObject({ role: 'user', content: 'hi' })
    expect(messages[1]).toMatchObject(toolCallMessage!)
    expect(messages[2]).toMatchObject(toolResultMessage!)
    expect(messages[3]).toMatchObject(finalAssistantMessage!)

    const jsonlMessages = await readMessagesJsonl(cwd)
    expect(jsonlMessages).toHaveLength(4)
    expect(jsonlMessages[0]).toMatchObject({ role: 'user', content: 'hi' })
    expect(jsonlMessages[1]).toMatchObject(toolCallMessage!)
    expect(jsonlMessages[2]).toMatchObject(toolResultMessage!)
    expect(jsonlMessages[3]).toMatchObject(finalAssistantMessage!)
  })

  it('stopped + finalMessages → 先写 finalMessages 再写 [stopped] 标记 + status=stopped', async () => {
    const paths = resolveWorkspacePaths(cwd)
    const store = createSessionStore(paths)
    const memoryStore = createMemoryStore(paths)
    const finalMessages: NonNullable<
      Extract<AgentExecutionEvent, { type: 'lifecycle'; phase: 'stopped' }>['finalMessages']
    > = [{ id: 'msg-partial', role: 'assistant', content: 'partial' }]
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
      runQueue: new SessionRunQueue(),
      abortRegistry: new AbortRegistry<string>(),
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

  it('stopped + tool finalMessages → 先落 finalMessages 再落 [stopped] 标记', async () => {
    const paths = resolveWorkspacePaths(cwd)
    const store = createSessionStore(paths)
    const memoryStore = createMemoryStore(paths)
    const finalMessages = buildStoppedToolFinalMessages()
    const executor = makeExecutor([
      { type: 'lifecycle', phase: 'started' },
      { type: 'assistant-message', text: '准备调用工具。' },
      { type: 'lifecycle', phase: 'stopped', reason: 'user', finalMessages },
    ])
    const { sink } = mockSink()
    const orch = createConversationOrchestrator({
      toolsBuilder: () => ({}),
      executorFactory: () => executor,
      sessionStore: store,
      memoryStore,
      runQueue: new SessionRunQueue(),
      abortRegistry: new AbortRegistry<string>(),
      systemPrompt: '',
      logger: stubLogger(),
    })

    await orch.handle(makeInput(), sink)

    const [toolCallMessage, toolResultMessage] = finalMessages
    expect(toolCallMessage).toBeDefined()
    expect(toolResultMessage).toBeDefined()

    const messages = await store.loadMessages('slack:C:t')
    expect(messages).toHaveLength(4)
    expect(messages[0]).toMatchObject({ role: 'user', content: 'hi' })
    expect(messages[1]).toMatchObject(toolCallMessage!)
    expect(messages[2]).toMatchObject(toolResultMessage!)
    expect(messages[3]).toMatchObject({ role: 'assistant', content: '[stopped]' })

    const jsonlMessages = await readMessagesJsonl(cwd)
    expect(jsonlMessages).toHaveLength(4)
    expect(jsonlMessages[0]).toMatchObject({ role: 'user', content: 'hi' })
    expect(jsonlMessages[1]).toMatchObject(toolCallMessage!)
    expect(jsonlMessages[2]).toMatchObject(toolResultMessage!)
    expect(jsonlMessages[3]).toMatchObject({ role: 'assistant', content: '[stopped]' })

    const meta = await store.getMeta('slack:C:t')
    expect(meta?.status).toBe('stopped')
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
      runQueue: new SessionRunQueue(),
      abortRegistry: new AbortRegistry<string>(),
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
      runQueue: new SessionRunQueue(),
      abortRegistry: new AbortRegistry<string>(),
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
      runQueue: new SessionRunQueue(),
      abortRegistry: new AbortRegistry<string>(),
      systemPrompt: '',
      logger: stubLogger(),
    })
    await orch.handle(makeInput(), sink)

    // sink 应该收到 synthetic failed 事件
    const failed = events.find((e) => e.type === 'lifecycle' && e.phase === 'failed')
    expect(failed).toBeDefined()
    expect((failed as { error?: { message: string } }).error?.message).toContain(
      'sink persistence crashed',
    )

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
      runQueue: new SessionRunQueue(),
      abortRegistry: new AbortRegistry<string>(),
      systemPrompt: '你是助手。',
      logger: stubLogger(),
    })
    await orch.handle(makeInput({ userId: 'U2', userName: 'bob' }), sink)
    expect(capturedSystem).toContain('你是助手')
    expect(capturedSystem).toContain('长期记忆')
    expect(capturedSystem).toContain('bob-U2.md')
  })

  it('记录 trace 日志时包含最终发给模型的完整 system prompt', async () => {
    const paths = resolveWorkspacePaths(cwd)
    const store = createSessionStore(paths)
    const memoryStore = createMemoryStore(paths)
    const trace = vi.fn()

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
      runQueue: new SessionRunQueue(),
      abortRegistry: new AbortRegistry<string>(),
      systemPrompt: '你是助手。',
      logger: stubLogger({ trace }),
    })

    await orch.handle(makeInput(), sink)

    expect(capturedSystem).toContain('你是助手。')
    expect(capturedSystem).toContain('目前没有关于该用户（alice / U）的长期记忆')
    expect(trace).toHaveBeenCalledWith(`最终 system prompt 正文：\n${capturedSystem}`)
  })

  it('同 session 两次 handle 会经 queue 串行，第二次在第一次完成后才启动 executor', async () => {
    const paths = resolveWorkspacePaths(cwd)
    const store = createSessionStore(paths)
    const memoryStore = createMemoryStore(paths)
    const runQueue = new SessionRunQueue()
    const abortRegistry = new AbortRegistry<string>()
    const started: string[] = []

    let releaseFirstExecution = () => {}
    const firstExecutionReleased = new Promise<void>((resolve) => {
      releaseFirstExecution = resolve
    })

    const executors: AgentExecutor[] = [
      {
        async *execute() {
          started.push('first')
          await firstExecutionReleased
          yield { type: 'lifecycle', phase: 'started' }
          yield { type: 'lifecycle', phase: 'completed', finalMessages: [] }
        },
      },
      {
        async *execute() {
          started.push('second')
          yield { type: 'lifecycle', phase: 'started' }
          yield { type: 'lifecycle', phase: 'completed', finalMessages: [] }
        },
      },
    ]

    const orch = createConversationOrchestrator({
      toolsBuilder: () => ({}),
      executorFactory: () => {
        const executor = executors.shift()
        if (!executor) {
          throw new Error('unexpected executor request')
        }
        return executor
      },
      sessionStore: store,
      memoryStore,
      runQueue,
      abortRegistry,
      systemPrompt: '',
      logger: stubLogger(),
    })

    const firstSink = mockSink()
    const secondSink = mockSink()

    const firstHandle = orch.handle(makeInput({ messageTs: 'm1', text: 'first' }), firstSink.sink)
    await waitUntil(() => started.includes('first'))

    const secondHandle = orch.handle(
      makeInput({ messageTs: 'm2', text: 'second' }),
      secondSink.sink,
    )
    await waitUntil(() => runQueue.queueDepth('slack:C:t') === 2)

    expect(started).toEqual(['first'])

    releaseFirstExecution()
    await Promise.all([firstHandle, secondHandle])

    expect(started).toEqual(['first', 'second'])
    expect(firstSink.sink.finalize).toHaveBeenCalledTimes(1)
    expect(secondSink.sink.finalize).toHaveBeenCalledTimes(1)
  })

  it('执行中调用 abortRegistry.abort(messageTs) 时，executor 可以观察到 signal.aborted=true', async () => {
    const paths = resolveWorkspacePaths(cwd)
    const store = createSessionStore(paths)
    const memoryStore = createMemoryStore(paths)
    const runQueue = new SessionRunQueue()
    const abortRegistry = new AbortRegistry<string>()

    let observedBeforeAbort = false
    let observedAfterAbort = false
    let executorSignal: AbortSignal | undefined
    let markStarted = () => {}
    const started = new Promise<void>((resolve) => {
      markStarted = resolve
    })

    const executor: AgentExecutor = {
      async *execute(req: AgentExecutionRequest) {
        executorSignal = req.abortSignal
        observedBeforeAbort = req.abortSignal.aborted
        markStarted()

        await new Promise<void>((resolve) => {
          const stop = () => {
            observedAfterAbort = req.abortSignal.aborted
            resolve()
          }

          if (req.abortSignal.aborted) {
            stop()
            return
          }

          req.abortSignal.addEventListener('abort', stop, { once: true })
        })

        yield { type: 'lifecycle', phase: 'stopped', reason: 'user' }
      },
    }

    const orch = createConversationOrchestrator({
      toolsBuilder: () => ({}),
      executorFactory: () => executor,
      sessionStore: store,
      memoryStore,
      runQueue,
      abortRegistry,
      systemPrompt: '',
      logger: stubLogger(),
    })

    const { sink } = mockSink()
    const handlePromise = orch.handle(makeInput({ messageTs: 'm-abort' }), sink)

    await started
    expect(observedBeforeAbort).toBe(false)
    expect(executorSignal?.aborted).toBe(false)

    abortRegistry.abort('m-abort', 'user-cancel')
    await handlePromise

    expect(observedAfterAbort).toBe(true)
    expect(executorSignal?.aborted).toBe(true)
    expect(executorSignal?.reason).toBe('user-cancel')
    expect(() => abortRegistry.create('m-abort')).not.toThrow()
    abortRegistry.delete('m-abort')
  })

  it('首次建档时同一新 session 的 getOrCreate 不会并发进入', async () => {
    const runQueue = new SessionRunQueue()
    const abortRegistry = new AbortRegistry<string>()
    const sessionId = 'slack:C:t'
    const statusBySession = new Map<string, 'idle' | 'running' | 'stopped' | 'error'>()
    const messagesBySession = new Map<string, CoreMessage[]>()
    let getOrCreateConcurrent = 0
    let getOrCreateMaxConcurrent = 0
    let getOrCreateCalls = 0

    let releaseFirstGetOrCreate = () => {}
    const firstGetOrCreateReleased = new Promise<void>((resolve) => {
      releaseFirstGetOrCreate = resolve
    })

    const store: SessionStore = {
      async getOrCreate() {
        getOrCreateCalls += 1
        getOrCreateConcurrent += 1
        getOrCreateMaxConcurrent = Math.max(getOrCreateMaxConcurrent, getOrCreateConcurrent)

        try {
          if (getOrCreateCalls === 1) {
            await firstGetOrCreateReleased
          }

          statusBySession.set(sessionId, 'idle')
          messagesBySession.set(sessionId, messagesBySession.get(sessionId) ?? [])
          return {
            id: sessionId,
            dir: '/tmp/mock-session',
            meta: {
              schemaVersion: 1,
              imProvider: 'slack',
              channelId: 'C',
              channelName: 'c',
              threadTs: 't',
              imUserId: 'U',
              agentName: 'default',
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
              status: 'idle',
              usage: {
                inputTokens: 0,
                outputTokens: 0,
                cachedInputTokens: 0,
                totalCostUSD: 0,
                stepCount: 0,
              },
            },
          }
        } finally {
          getOrCreateConcurrent -= 1
        }
      },
      async getMeta(id) {
        const status = statusBySession.get(id)
        if (!status) return undefined
        return {
          schemaVersion: 1,
          imProvider: 'slack',
          channelId: 'C',
          channelName: 'c',
          threadTs: 't',
          imUserId: 'U',
          agentName: 'default',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          status,
          usage: {
            inputTokens: 0,
            outputTokens: 0,
            cachedInputTokens: 0,
            totalCostUSD: 0,
            stepCount: 0,
          },
        }
      },
      async loadMessages(id) {
        return [...(messagesBySession.get(id) ?? [])]
      },
      async appendMessage(id, msg) {
        const messages = messagesBySession.get(id) ?? []
        messages.push(msg)
        messagesBySession.set(id, messages)
      },
      async appendEvent() {},
      async accumulateUsage() {},
      async accumulateCost() {},
      async setStatus(id, status) {
        statusBySession.set(id, status)
      },
    }

    const executor: AgentExecutor = {
      async *execute() {
        yield { type: 'lifecycle', phase: 'started' }
        yield { type: 'lifecycle', phase: 'completed', finalMessages: [] }
      },
    }

    const orch = createConversationOrchestrator({
      toolsBuilder: () => ({}),
      executorFactory: () => executor,
      sessionStore: store,
      memoryStore: {
        exists: async () => false,
        pathFor: () => '/tmp/mock-memory.md',
        save: async () => '/tmp/mock-memory.md',
      },
      runQueue,
      abortRegistry,
      systemPrompt: '',
      logger: stubLogger(),
    })

    const firstHandle = orch.handle(makeInput({ messageTs: 'm1' }), mockSink().sink)
    await waitUntil(() => getOrCreateCalls === 1)

    const secondHandle = orch.handle(makeInput({ messageTs: 'm2' }), mockSink().sink)
    await new Promise<void>((resolve) => setTimeout(resolve, 0))

    expect(getOrCreateMaxConcurrent).toBe(1)
    expect(getOrCreateCalls).toBe(1)

    releaseFirstGetOrCreate()
    await Promise.all([firstHandle, secondHandle])

    expect(getOrCreateMaxConcurrent).toBe(1)
    expect(getOrCreateCalls).toBe(2)
  })

  it('sink.onEvent 持续失败时仍会先落盘 error 状态与错误标记', async () => {
    const paths = resolveWorkspacePaths(cwd)
    const store = createSessionStore(paths)
    const memoryStore = createMemoryStore(paths)
    const executor = makeExecutor([
      { type: 'lifecycle', phase: 'started' },
      { type: 'lifecycle', phase: 'completed', finalMessages: [] },
    ])

    const sink: EventSink = {
      onEvent: vi.fn(async () => {
        throw new Error('sink always broken')
      }),
      finalize: vi.fn(async () => {}),
      get terminalPhase() {
        return undefined
      },
    }

    const orch = createConversationOrchestrator({
      toolsBuilder: () => ({}),
      executorFactory: () => executor,
      sessionStore: store,
      memoryStore,
      runQueue: new SessionRunQueue(),
      abortRegistry: new AbortRegistry<string>(),
      systemPrompt: '',
      logger: stubLogger(),
    })

    await expect(orch.handle(makeInput(), sink)).resolves.toBeUndefined()

    const meta = await store.getMeta('slack:C:t')
    const msgs = await store.loadMessages('slack:C:t')
    expect(meta?.status).toBe('error')
    expect(meta?.status).not.toBe('running')
    expect(msgs.at(-1)).toMatchObject({
      role: 'assistant',
      content: expect.stringContaining('sink always broken'),
    })
    expect(sink.finalize).toHaveBeenCalledTimes(1)
    expect(sink.onEvent).toHaveBeenCalledTimes(2)
  })

  it('queue runner 内 setup 失败时仍会落盘 error 状态与错误标记', async () => {
    const paths = resolveWorkspacePaths(cwd)
    const store = createSessionStore(paths)
    const memoryStore = createMemoryStore(paths)
    const sink = mockSink()

    const orch = createConversationOrchestrator({
      toolsBuilder: () => {
        throw new Error('toolsBuilder exploded')
      },
      executorFactory: () => {
        throw new Error('should not reach executorFactory')
      },
      sessionStore: store,
      memoryStore,
      runQueue: new SessionRunQueue(),
      abortRegistry: new AbortRegistry<string>(),
      systemPrompt: '',
      logger: stubLogger(),
    })

    await expect(orch.handle(makeInput(), sink.sink)).resolves.toBeUndefined()

    const meta = await store.getMeta('slack:C:t')
    const msgs = await store.loadMessages('slack:C:t')
    expect(meta?.status).toBe('error')
    expect(meta?.status).not.toBe('running')
    expect(msgs.at(-1)).toMatchObject({
      role: 'assistant',
      content: expect.stringContaining('toolsBuilder exploded'),
    })
    expect(sink.sink.finalize).toHaveBeenCalledTimes(1)
  })
})
