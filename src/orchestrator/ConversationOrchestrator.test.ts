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
import type { MentionCommandRouter } from './MentionCommandRouter.ts'
import type { ContextCompactor } from './ContextCompactor.ts'

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

function makeContextCompactor(overrides: Partial<ContextCompactor> = {}): ContextCompactor {
  return {
    manualCompact: vi.fn(async () => ({
      status: 'skipped' as const,
      responseText: 'skipped',
      finalMessages: [],
    })),
    autoCompact: vi.fn(async () => ({
      status: 'compacted' as const,
      finalMessages: [
        { id: 'msg-auto-compact', role: 'assistant' as const, content: '[compact: auto]\n摘要' },
      ],
      metrics: {
        preCompactApproxChars: 1000,
        postCompactApproxChars: 100,
        compactionDurationMs: 200,
        compactionUsage: { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 },
        ptlRetryCount: 0,
        ptlDroppedMessages: 0,
      },
    })),
    ...overrides,
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

  it('长历史只裁剪传给 executor 的模型视图，messages.jsonl 仍完整追加', async () => {
    const paths = resolveWorkspacePaths(cwd)
    const store = createSessionStore(paths)
    const memoryStore = createMemoryStore(paths)
    const session = await store.getOrCreate({
      imProvider: 'slack',
      channelId: 'C',
      channelName: 'c',
      threadTs: 't',
      imUserId: 'U',
    })
    const history: CoreMessage[] = [
      { role: 'user', content: 'old-1' },
      { role: 'assistant', content: 'old-2' },
      { role: 'user', content: 'recent-1' },
      { role: 'assistant', content: 'recent-2' },
    ]
    for (const message of history) {
      await store.appendMessage(session.id, message)
    }

    let executorMessages: CoreMessage[] | undefined
    const executor: AgentExecutor = {
      async *execute(req) {
        executorMessages = req.messages
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
      systemPrompt: '',
      modelMessageBudget: {
        maxApproxChars: 10_000,
        keepRecentMessages: 3,
        keepRecentToolResults: 20,
      },
      logger: stubLogger(),
    })

    await orch.handle(makeInput({ text: 'current' }), sink)

    // toMatchObject：history 经 appendMessage 后多了 id 字段，断言只关心 role/content 与裁剪 notice 内容。
    expect(executorMessages).toMatchObject([
      {
        role: 'user',
        content: `[历史上下文已按预算裁剪]\n本次仅加载最近对话片段；完整会话记录仍保存在：${path.join(
          session.dir,
          'messages.jsonl',
        )}`,
      },
      { role: 'user', content: 'recent-1' },
      { role: 'assistant', content: 'recent-2' },
      { role: 'user', content: 'current' },
    ])
    const persistedMessages = await store.loadMessages(session.id)
    // toMatchObject：appendMessage 自动补 id，断言只关心 role/content。
    expect(persistedMessages).toMatchObject([...history, { role: 'user', content: 'current' }])
  })

  it('达到自动 compact 阈值时先整理上下文，再继续主 executor', async () => {
    const paths = resolveWorkspacePaths(cwd)
    const store = createSessionStore(paths)
    const memoryStore = createMemoryStore(paths)
    const session = await store.getOrCreate({
      imProvider: 'slack',
      channelId: 'C',
      channelName: 'c',
      threadTs: 't',
      imUserId: 'U',
    })
    const history: CoreMessage[] = [
      { role: 'user', content: 'old-1' },
      { role: 'assistant', content: 'old-2' },
    ]
    for (const message of history) {
      await store.appendMessage(session.id, message)
    }

    let executorMessages: CoreMessage[] | undefined
    const executor: AgentExecutor = {
      async *execute(req) {
        executorMessages = req.messages
        yield { type: 'lifecycle', phase: 'completed', finalMessages: [] }
      },
    }
    const contextCompactor = makeContextCompactor()
    const { sink, events } = mockSink()
    const orch = createConversationOrchestrator({
      toolsBuilder: () => ({}),
      executorFactory: () => executor,
      sessionStore: store,
      memoryStore,
      runQueue: new SessionRunQueue(),
      abortRegistry: new AbortRegistry<string>(),
      systemPrompt: '',
      modelMessageBudget: {
        // 字符体积阈值故意调小（80% × 50 = 40 chars），让 3 条短消息触发；
        // 不再依赖已被移除的"消息条数兜底触发"。
        maxApproxChars: 50,
        keepRecentMessages: 3,
        keepRecentToolResults: 20,
        autoCompact: { enabled: true, triggerRatio: 0.8, maxFailures: 2 },
      },
      contextCompactor,
      logger: stubLogger(),
    })

    await orch.handle(makeInput({ text: 'current' }), sink)

    // toMatchObject：messages 元素被 SessionStore 自动补 id，仅断言 role/content。
    expect(contextCompactor.autoCompact).toHaveBeenCalledOnce()
    const autoCompactArg = (
      contextCompactor.autoCompact as unknown as ReturnType<typeof vi.fn>
    ).mock.calls[0]?.[0] as { session: { id: string }; messages: CoreMessage[]; trigger: string }
    expect(autoCompactArg).toMatchObject({
      session: { id: session.id },
      messages: [...history, { role: 'user', content: 'current' }],
      trigger: 'budget',
    })
    expect(events[0]).toMatchObject({
      type: 'activity-state',
      state: { status: '正在整理上下文…' },
    })
    expect(events[1]).toEqual({ type: 'activity-state', state: { clear: true } })
    expect(executorMessages).toMatchObject([
      { role: 'assistant', content: '[compact: auto]\n摘要' },
      { role: 'user', content: 'current' },
    ])
    await expect(store.getAutoCompactState(session.id)).resolves.toMatchObject({
      failureCount: 0,
      breakerOpen: false,
    })
    // loadMessages 现在默认切片到 boundary 之后；用 loadFullTranscript 验证完整 jsonl 持久化。
    await expect(store.loadFullTranscript(session.id)).resolves.toMatchObject([
      ...history,
      { role: 'user', content: 'current' },
      { role: 'assistant', content: '[compact: auto]\n摘要' },
    ])
    await expect(store.loadCompactRecords(session.id)).resolves.toMatchObject([
      {
        schemaVersion: 1,
        messageId: 'msg-auto-compact',
        mode: 'auto',
      },
    ])

    // events.jsonl 应有 attempt + succeeded（按时间顺序）。
    const eventsRaw = await readFile(path.join(session.dir, 'events.jsonl'), 'utf8')
    const eventLines = eventsRaw
      .split('\n')
      .filter((l) => l.length > 0)
      .map((l) => JSON.parse(l) as { type: string; [k: string]: unknown })
    expect(eventLines.map((e) => e.type)).toEqual(['compact_attempt', 'compact_succeeded'])
    expect(eventLines[1]).toMatchObject({
      type: 'compact_succeeded',
      mode: 'auto',
      compactionUsage: { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 },
    })
    expect(typeof eventLines[1]?.willRetriggerNextTurn).toBe('boolean')
  })

  it('自动 compact 失败时记录失败计数并继续主流程', async () => {
    const paths = resolveWorkspacePaths(cwd)
    const store = createSessionStore(paths)
    const memoryStore = createMemoryStore(paths)
    const session = await store.getOrCreate({
      imProvider: 'slack',
      channelId: 'C',
      channelName: 'c',
      threadTs: 't',
      imUserId: 'U',
    })
    await store.appendMessage(session.id, { role: 'user', content: 'old' })
    await store.appendMessage(session.id, { role: 'assistant', content: 'answer' })

    let executorCalled = false
    const executor: AgentExecutor = {
      async *execute() {
        executorCalled = true
        yield { type: 'lifecycle', phase: 'completed', finalMessages: [] }
      },
    }
    const contextCompactor = makeContextCompactor({
      autoCompact: vi.fn(async () => {
        throw new Error('compact failed')
      }),
    })
    const orch = createConversationOrchestrator({
      toolsBuilder: () => ({}),
      executorFactory: () => executor,
      sessionStore: store,
      memoryStore,
      runQueue: new SessionRunQueue(),
      abortRegistry: new AbortRegistry<string>(),
      systemPrompt: '',
      modelMessageBudget: {
        // 同上：用字符阈值（80% × 50 = 40 chars）让短消息触发 compact。
        maxApproxChars: 50,
        keepRecentMessages: 3,
        keepRecentToolResults: 20,
        autoCompact: { enabled: true, triggerRatio: 0.8, maxFailures: 2 },
      },
      contextCompactor,
      logger: stubLogger(),
    })

    await orch.handle(makeInput({ text: 'current' }), mockSink().sink)

    expect(executorCalled).toBe(true)
    await expect(store.getAutoCompactState(session.id)).resolves.toMatchObject({
      failureCount: 1,
      breakerOpen: false,
      lastFailureMessage: 'compact failed',
    })

    // events.jsonl 应有 attempt + failed
    const eventsRaw = await readFile(path.join(session.dir, 'events.jsonl'), 'utf8')
    const eventLines = eventsRaw
      .split('\n')
      .filter((l) => l.length > 0)
      .map((l) => JSON.parse(l) as { type: string; [k: string]: unknown })
    expect(eventLines.map((e) => e.type)).toEqual(['compact_attempt', 'compact_failed'])
    expect(eventLines[1]).toMatchObject({
      type: 'compact_failed',
      mode: 'auto',
      countedAsFailure: true,
      failureCount: 1,
      breakerOpened: false,
      errorMessage: 'compact failed',
    })
  })

  it('usage-info.lastApiInputTokens 写入 meta.context.lastUsage', async () => {
    const paths = resolveWorkspacePaths(cwd)
    const store = createSessionStore(paths)
    const memoryStore = createMemoryStore(paths)
    const session = await store.getOrCreate({
      imProvider: 'slack',
      channelId: 'C',
      channelName: 'c',
      threadTs: 't-last-usage',
      imUserId: 'U',
    })

    const executor: AgentExecutor = {
      async *execute() {
        yield {
          type: 'usage-info',
          usage: {
            durationMs: 100,
            totalCostUSD: 0,
            modelUsage: [
              {
                model: 'm',
                inputTokens: 350,
                outputTokens: 5,
                cachedInputTokens: 0,
                cacheHitRate: 0,
              },
            ],
            lastApiInputTokens: 250,
          },
        }
        yield { type: 'lifecycle', phase: 'completed', finalMessages: [] }
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

    await orch.handle(
      {
        imProvider: 'slack',
        channelId: 'C',
        channelName: 'c',
        threadTs: 't-last-usage',
        userId: 'U',
        userName: 'win-test',
        text: 'hi',
        messageTs: '1',
      },
      mockSink().sink,
    )

    const snapshot = await store.getLastUsage(session.id)
    expect(snapshot?.apiInputTokens).toBe(250)
  })

  it('lastUsage + effectiveContextTokens 都设置时按真实 token 触发，忽略字符大小', async () => {
    const paths = resolveWorkspacePaths(cwd)
    const store = createSessionStore(paths)
    const memoryStore = createMemoryStore(paths)
    const session = await store.getOrCreate({
      imProvider: 'slack',
      channelId: 'C',
      channelName: 'c',
      threadTs: 't-token-trigger',
      imUserId: 'U',
    })
    await store.appendMessage(session.id, { role: 'user', content: 'old' })
    await store.appendMessage(session.id, { role: 'assistant', content: 'answer' })
    // 预设 lastUsage 超过阈值：(35_000 - 33_000) * 0.5 = 1000 → 设 1500
    await store.setLastUsage(session.id, { apiInputTokens: 1500 })

    const executor: AgentExecutor = {
      async *execute() {
        yield { type: 'lifecycle', phase: 'completed', finalMessages: [] }
      },
    }
    const contextCompactor = makeContextCompactor()
    const orch = createConversationOrchestrator({
      toolsBuilder: () => ({}),
      executorFactory: () => executor,
      sessionStore: store,
      memoryStore,
      runQueue: new SessionRunQueue(),
      abortRegistry: new AbortRegistry<string>(),
      systemPrompt: '',
      modelMessageBudget: {
        // 字符极小即便 candidate 很短也 ≥ 字符阈值；如果 token 路径正确，
        // 这里不应回退到字符判断。
        maxApproxChars: 1_000_000,
        effectiveContextTokens: 35_000,
        keepRecentMessages: 80,
        keepRecentToolResults: 20,
        autoCompact: { enabled: true, triggerRatio: 0.5, maxFailures: 2 },
      },
      contextCompactor,
      logger: stubLogger(),
    })

    await orch.handle(makeInput({ text: 'short', threadTs: 't-token-trigger' }), mockSink().sink)

    expect(contextCompactor.autoCompact).toHaveBeenCalledOnce()
  })

  it('lastUsage 缺失（首轮）时回退字符估算', async () => {
    const paths = resolveWorkspacePaths(cwd)
    const store = createSessionStore(paths)
    const memoryStore = createMemoryStore(paths)
    const session = await store.getOrCreate({
      imProvider: 'slack',
      channelId: 'C',
      channelName: 'c',
      threadTs: 't-char-fallback',
      imUserId: 'U',
    })
    // 写两条短消息（candidate 字符达到阈值），不设 lastUsage
    await store.appendMessage(session.id, { role: 'user', content: 'x'.repeat(40) })
    await store.appendMessage(session.id, { role: 'assistant', content: 'y'.repeat(40) })

    const executor: AgentExecutor = {
      async *execute() {
        yield { type: 'lifecycle', phase: 'completed', finalMessages: [] }
      },
    }
    const contextCompactor = makeContextCompactor()
    const orch = createConversationOrchestrator({
      toolsBuilder: () => ({}),
      executorFactory: () => executor,
      sessionStore: store,
      memoryStore,
      runQueue: new SessionRunQueue(),
      abortRegistry: new AbortRegistry<string>(),
      systemPrompt: '',
      modelMessageBudget: {
        maxApproxChars: 100,
        // effectiveContextTokens 故意设了，但 lastUsage 缺失 → 应回退到字符路径
        effectiveContextTokens: 200_000,
        keepRecentMessages: 80,
        keepRecentToolResults: 20,
        autoCompact: { enabled: true, triggerRatio: 0.5, maxFailures: 2 },
      },
      contextCompactor,
      logger: stubLogger(),
    })

    await orch.handle(makeInput({ text: 'now', threadTs: 't-char-fallback' }), mockSink().sink)

    // candidate ≈ 100+ chars，maxApproxChars * 0.5 = 50 → 字符路径触发
    expect(contextCompactor.autoCompact).toHaveBeenCalledOnce()
    expect(await store.getLastUsage(session.id)).toBeUndefined()
  })

  it('lastUsage + effectiveContextTokens 都设置但 token 不够时不触发（即便字符够）', async () => {
    const paths = resolveWorkspacePaths(cwd)
    const store = createSessionStore(paths)
    const memoryStore = createMemoryStore(paths)
    const session = await store.getOrCreate({
      imProvider: 'slack',
      channelId: 'C',
      channelName: 'c',
      threadTs: 't-token-priority',
      imUserId: 'U',
    })
    // candidate 字符大（达到字符阈值），但 lastUsage 远低于 token 阈值
    await store.appendMessage(session.id, { role: 'user', content: 'x'.repeat(80) })
    await store.appendMessage(session.id, { role: 'assistant', content: 'y'.repeat(80) })
    await store.setLastUsage(session.id, { apiInputTokens: 500 })

    const executor: AgentExecutor = {
      async *execute() {
        yield { type: 'lifecycle', phase: 'completed', finalMessages: [] }
      },
    }
    const contextCompactor = makeContextCompactor()
    const orch = createConversationOrchestrator({
      toolsBuilder: () => ({}),
      executorFactory: () => executor,
      sessionStore: store,
      memoryStore,
      runQueue: new SessionRunQueue(),
      abortRegistry: new AbortRegistry<string>(),
      systemPrompt: '',
      modelMessageBudget: {
        maxApproxChars: 100, // 字符阈值小
        effectiveContextTokens: 200_000, // (200K-33K)*0.5 = 83.5K，500 << 83.5K
        keepRecentMessages: 80,
        keepRecentToolResults: 20,
        autoCompact: { enabled: true, triggerRatio: 0.5, maxFailures: 2 },
      },
      contextCompactor,
      logger: stubLogger(),
    })

    await orch.handle(
      makeInput({ text: 'short', threadTs: 't-token-priority' }),
      mockSink().sink,
    )

    expect(contextCompactor.autoCompact).not.toHaveBeenCalled()
  })

  it('breakerOpen 时跳过 compact 并埋 compact_skipped(breaker_open) 事件', async () => {
    const paths = resolveWorkspacePaths(cwd)
    const store = createSessionStore(paths)
    const memoryStore = createMemoryStore(paths)
    const session = await store.getOrCreate({
      imProvider: 'slack',
      channelId: 'C',
      channelName: 'c',
      threadTs: 't-breaker',
      imUserId: 'U',
    })
    await store.appendMessage(session.id, { role: 'user', content: 'old' })
    await store.appendMessage(session.id, { role: 'assistant', content: 'answer' })
    await store.setAutoCompactState(session.id, {
      failureCount: 2,
      breakerOpen: true,
    })

    const executor: AgentExecutor = {
      async *execute() {
        yield { type: 'lifecycle', phase: 'completed', finalMessages: [] }
      },
    }
    const contextCompactor = makeContextCompactor()
    const orch = createConversationOrchestrator({
      toolsBuilder: () => ({}),
      executorFactory: () => executor,
      sessionStore: store,
      memoryStore,
      runQueue: new SessionRunQueue(),
      abortRegistry: new AbortRegistry<string>(),
      systemPrompt: '',
      modelMessageBudget: {
        maxApproxChars: 50,
        keepRecentMessages: 3,
        keepRecentToolResults: 20,
        autoCompact: { enabled: true, triggerRatio: 0.8, maxFailures: 2 },
      },
      contextCompactor,
      logger: stubLogger(),
    })

    await orch.handle(
      {
        imProvider: 'slack',
        channelId: 'C',
        channelName: 'c',
        threadTs: 't-breaker',
        userId: 'U',
        userName: 'win-test',
        text: 'current',
        messageTs: '1',
      },
      mockSink().sink,
    )

    expect(contextCompactor.autoCompact).not.toHaveBeenCalled()
    const eventsRaw = await readFile(path.join(session.dir, 'events.jsonl'), 'utf8')
    const eventLines = eventsRaw
      .split('\n')
      .filter((l) => l.length > 0)
      .map((l) => JSON.parse(l) as { type: string; reason?: string })
    expect(eventLines).toHaveLength(1)
    expect(eventLines[0]).toMatchObject({
      type: 'compact_skipped',
      mode: 'auto',
      reason: 'breaker_open',
    })
  })

  it('自动 compact 熔断后不再调用 compactor', async () => {
    const paths = resolveWorkspacePaths(cwd)
    const store = createSessionStore(paths)
    const memoryStore = createMemoryStore(paths)
    const session = await store.getOrCreate({
      imProvider: 'slack',
      channelId: 'C',
      channelName: 'c',
      threadTs: 't',
      imUserId: 'U',
    })
    await store.appendMessage(session.id, { role: 'user', content: 'old' })
    await store.appendMessage(session.id, { role: 'assistant', content: 'answer' })
    await store.setAutoCompactState(session.id, {
      failureCount: 2,
      breakerOpen: true,
    })

    const contextCompactor = makeContextCompactor()
    const executor = makeExecutor([{ type: 'lifecycle', phase: 'completed', finalMessages: [] }])
    const orch = createConversationOrchestrator({
      toolsBuilder: () => ({}),
      executorFactory: () => executor,
      sessionStore: store,
      memoryStore,
      runQueue: new SessionRunQueue(),
      abortRegistry: new AbortRegistry<string>(),
      systemPrompt: '',
      modelMessageBudget: {
        maxApproxChars: 10_000,
        keepRecentMessages: 3,
        keepRecentToolResults: 20,
        autoCompact: { enabled: true, triggerRatio: 0.8, maxFailures: 2 },
      },
      contextCompactor,
      logger: stubLogger(),
    })

    await orch.handle(makeInput({ text: 'current' }), mockSink().sink)

    expect(contextCompactor.autoCompact).not.toHaveBeenCalled()
  })

  it('@mention compact command 命中时不进入 executor，并持久化命令回复', async () => {
    const paths = resolveWorkspacePaths(cwd)
    const store = createSessionStore(paths)
    const memoryStore = createMemoryStore(paths)
    const finalMessages: Extract<
      AgentExecutionEvent,
      { type: 'lifecycle'; phase: 'completed' }
    >['finalMessages'] = [
      { id: 'msg-compact', role: 'assistant', content: '[compact: manual]\n摘要' },
    ]
    const mentionCommandRouter: MentionCommandRouter = {
      match: (text) => (text === '/compact' ? 'compact' : undefined),
      execute: vi.fn(async () => ({
        status: 'compacted' as const,
        responseText: '[compact: manual]\n摘要',
        finalMessages,
        metrics: {
          preCompactApproxChars: 500,
          postCompactApproxChars: 50,
          compactionDurationMs: 100,
          compactionUsage: { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 },
          ptlRetryCount: 0,
          ptlDroppedMessages: 0,
        },
      })),
    }
    const executor: AgentExecutor = {
      async *execute() {
        throw new Error('executor should not run for compact command')
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
      mentionCommandRouter,
      logger: stubLogger(),
    })

    await orch.handle(makeInput({ text: '/compact' }), sink)

    expect(mentionCommandRouter.execute).toHaveBeenCalledTimes(1)
    expect(events).toEqual([
      { type: 'assistant-message', text: '[compact: manual]\n摘要' },
      { type: 'lifecycle', phase: 'completed', finalMessages },
    ])
    // 验证完整持久化用 loadFullTranscript（loadMessages 默认切片到 boundary 之后）。
    const persistedMessages = await store.loadFullTranscript('slack:C:t')
    expect(persistedMessages).toMatchObject([
      { role: 'user', content: '/compact' },
      ...finalMessages,
    ])
    await expect(store.loadCompactRecords('slack:C:t')).resolves.toMatchObject([
      {
        schemaVersion: 1,
        messageId: 'msg-compact',
        mode: 'manual',
      },
    ])
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

  it('stopped reason=max_steps → 写总结与专用停止标记', async () => {
    const paths = resolveWorkspacePaths(cwd)
    const store = createSessionStore(paths)
    const memoryStore = createMemoryStore(paths)
    const summary = '已达到 maxSteps 上限\n\n当前已知上下文总结：...'
    const executor = makeExecutor([
      { type: 'lifecycle', phase: 'started' },
      { type: 'assistant-message', text: summary },
      { type: 'lifecycle', phase: 'stopped', reason: 'max_steps', summary },
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
    expect(msgs).toHaveLength(3)
    expect(msgs[1]).toMatchObject({ role: 'assistant', content: summary })
    expect(msgs[2]).toMatchObject({ role: 'assistant', content: '[stopped: max_steps]' })
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

  it('同 session 第二次 handle 会等待第一次 finalize 完成，避免 Slack ending 与下一轮回复交错', async () => {
    const paths = resolveWorkspacePaths(cwd)
    const store = createSessionStore(paths)
    const memoryStore = createMemoryStore(paths)
    const runQueue = new SessionRunQueue()
    const started: string[] = []

    let releaseFirstFinalize = () => {}
    const firstFinalizeReleased = new Promise<void>((resolve) => {
      releaseFirstFinalize = resolve
    })
    let markFirstFinalizeStarted = () => {}
    const firstFinalizeStarted = new Promise<void>((resolve) => {
      markFirstFinalizeStarted = resolve
    })

    const executors: AgentExecutor[] = [
      {
        async *execute() {
          started.push('first')
          yield { type: 'lifecycle', phase: 'completed', finalMessages: [] }
        },
      },
      {
        async *execute() {
          started.push('second')
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
      abortRegistry: new AbortRegistry<string>(),
      systemPrompt: '',
      logger: stubLogger(),
    })

    const firstSink = mockSink()
    firstSink.sink.finalize = vi.fn(async () => {
      markFirstFinalizeStarted()
      await firstFinalizeReleased
    })
    const secondSink = mockSink()

    const firstHandle = orch.handle(makeInput({ messageTs: 'm1', text: 'first' }), firstSink.sink)
    await firstFinalizeStarted

    const secondHandle = orch.handle(
      makeInput({ messageTs: 'm2', text: 'second' }),
      secondSink.sink,
    )
    await new Promise<void>((resolve) => setTimeout(resolve, 0))

    expect(started).toEqual(['first'])

    releaseFirstFinalize()
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
      async loadFullTranscript(id) {
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
      async getAutoCompactState() {
        return { failureCount: 0, breakerOpen: false }
      },
      async setAutoCompactState() {},
      async getLastUsage() {
        return undefined
      },
      async setLastUsage() {},
      async loadCompactRecords() {
        return []
      },
      async appendCompactRecord() {},
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
