/**
 * slack-render-flow 集成测试
 *
 * 绕过 SlackAdapter 的 socket 连接，直接用真实的
 * SlackRenderer + SlackEventSink + ConversationOrchestrator + AiSdkExecutor，
 * 仅 mock WebClient 和 LanguageModel 两个外部边界。
 */
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { MockLanguageModelV1, simulateReadableStream } from 'ai/test'
import { tool, type LanguageModel } from 'ai'
import { z } from 'zod'
import type { WebClient } from '@slack/web-api'
import { createSessionStore } from '@/store/SessionStore.ts'
import { createMemoryStore } from '@/store/MemoryStore.ts'
import { resolveWorkspacePaths } from '@/workspace/paths.ts'
import { createAiSdkExecutor } from '@/agent/AiSdkExecutor.ts'
import { createConversationOrchestrator } from '@/orchestrator/ConversationOrchestrator.ts'
import { SessionRunQueue } from '@/orchestrator/SessionRunQueue.ts'
import { AbortRegistry } from '@/orchestrator/AbortRegistry.ts'
import { createSlackEventSink } from '@/im/slack/SlackEventSink.ts'
import { createSlackRenderer } from '@/im/slack/SlackRenderer.ts'
import type { Logger } from '@/logger/logger.ts'

// ─── 辅助工具 ────────────────────────────────────────────

type MockStreamChunk = { type: string; [key: string]: unknown }

/** 静默 logger，不输出任何内容。 */
function stubLogger(): Logger {
  const l: Logger = {
    trace: () => {},
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
    withTag: () => stubLogger(),
  }
  return l
}

/** 记录每次 WebClient 调用的条目。 */
interface ApiCall {
  method: string
  args: unknown
}

/** 创建可追踪所有调用的 mock WebClient。 */
function createMockWebClient(): { web: WebClient; calls: ApiCall[] } {
  const calls: ApiCall[] = []
  let postMessageCounter = 0

  const web = {
    reactions: {
      add: vi.fn(async (args: unknown) => {
        calls.push({ method: 'reactions.add', args })
        return { ok: true }
      }),
      remove: vi.fn(async (args: unknown) => {
        calls.push({ method: 'reactions.remove', args })
        return { ok: true }
      }),
    },
    chat: {
      postMessage: vi.fn(async (args: unknown) => {
        postMessageCounter += 1
        calls.push({ method: 'chat.postMessage', args })
        return { ok: true, ts: `p${postMessageCounter}` }
      }),
      update: vi.fn(async (args: unknown) => {
        calls.push({ method: 'chat.update', args })
        return { ok: true }
      }),
      delete: vi.fn(async (args: unknown) => {
        calls.push({ method: 'chat.delete', args })
        return { ok: true }
      }),
    },
    assistant: {
      threads: {
        setStatus: vi.fn(async (args: unknown) => {
          calls.push({ method: 'assistant.threads.setStatus', args })
          return { ok: true }
        }),
      },
    },
  } as unknown as WebClient

  return { web, calls }
}

/**
 * 创建多步 mock 模型：每个内层数组对应一次 doStream 调用。
 * chunks 使用 provider 级别格式（text-delta / tool-call / finish 等）。
 */
function createMockModel(stepChunks: MockStreamChunk[][]): LanguageModel {
  const responses = [...stepChunks]

  return new MockLanguageModelV1({
    doStream: async () => {
      const chunks = responses.shift()
      if (!chunks) {
        throw new Error('没有更多 mock stream 响应')
      }

      return {
        stream: simulateReadableStream({ chunks }) as unknown as ReadableStream<never>,
        rawCall: { rawPrompt: null, rawSettings: {} },
      } as never
    },
  }) as unknown as LanguageModel
}

/** mock read_file 工具。 */
function createReadFileTool() {
  return tool({
    description: '读取文件内容',
    parameters: z.object({ path: z.string() }),
    execute: async ({ path: filePath }) => `content of ${filePath}`,
  })
}

// ─── 测试 ────────────────────────────────────────────────

describe('slack-render-flow 集成：真实 SlackRenderer + mock WebClient', () => {
  let cwd: string

  beforeEach(() => {
    cwd = mkdtempSync(path.join(tmpdir(), 'slack-render-'))
  })

  it('完整 turn：ack → status → progress → reply → delete progress → finalize → usage → done', async () => {
    const paths = resolveWorkspacePaths(cwd)
    const store = createSessionStore(paths)
    const memoryStore = createMemoryStore(paths)
    const logger = stubLogger()

    const tools = { read_file: createReadFileTool() }

    // 两步模型：第一步 tool-call，第二步 text 输出
    const model = createMockModel([
      [
        { type: 'response-metadata', id: 'resp_1', modelId: 'mock-model' },
        {
          type: 'tool-call',
          toolCallType: 'function',
          toolCallId: 'c1',
          toolName: 'read_file',
          args: '{"path":"a.ts"}',
        },
        {
          type: 'finish',
          finishReason: 'tool-calls',
          usage: { promptTokens: 5, completionTokens: 0 },
        },
      ],
      [
        { type: 'response-metadata', id: 'resp_2', modelId: 'mock-model' },
        { type: 'text-delta', textDelta: 'done' },
        {
          type: 'finish',
          finishReason: 'stop',
          usage: { promptTokens: 3, completionTokens: 1 },
        },
      ],
    ])

    const executor = createAiSdkExecutor({
      model,
      tools,
      maxSteps: 5,
      logger,
      modelName: 'mock-model',
    })

    const orchestrator = createConversationOrchestrator({
      toolsBuilder: () => tools,
      executorFactory: () => executor,
      sessionStore: store,
      memoryStore,
      runQueue: new SessionRunQueue(),
      abortRegistry: new AbortRegistry<string>(),
      systemPrompt: 'test',
      logger,
    })

    const { web, calls } = createMockWebClient()
    const renderer = createSlackRenderer({ logger })
    const sink = createSlackEventSink({
      web,
      channelId: 'C1',
      threadTs: 't1',
      sourceMessageTs: 'm1',
      renderer,
      logger,
    })

    await orchestrator.handle(
      {
        imProvider: 'slack',
        channelId: 'C1',
        channelName: 'general',
        threadTs: 't1',
        userId: 'U1',
        userName: 'alice',
        text: '请读取文件',
        messageTs: 'm1',
      },
      sink,
    )

    // 1. 首次 reactions.add 是 ack（eyes）
    const reactionCalls = calls.filter((c) => c.method === 'reactions.add')
    expect(reactionCalls.length).toBeGreaterThanOrEqual(2)
    const firstReaction = reactionCalls[0]!.args as { name: string }
    expect(firstReaction.name).toBe('eyes')

    // 2. 最后一个 reactions.add 是 done（white_check_mark）
    const lastReaction = reactionCalls[reactionCalls.length - 1]!.args as { name: string }
    expect(lastReaction.name).toBe('white_check_mark')

    // 3. 有 assistant.threads.setStatus 调用（状态条）
    const statusCalls = calls.filter((c) => c.method === 'assistant.threads.setStatus')
    expect(statusCalls.length).toBeGreaterThan(0)

    // 4. 至少 2 条 chat.postMessage（progress + reply，或 reply + usage）
    const postCalls = calls.filter((c) => c.method === 'chat.postMessage')
    expect(postCalls.length).toBeGreaterThanOrEqual(2)

    // 5. 有 chat.delete（progress 被删除）
    const deleteCalls = calls.filter((c) => c.method === 'chat.delete')
    expect(deleteCalls.length).toBeGreaterThanOrEqual(1)

    // 6. 最后一条 chat.postMessage 的 text 包含时长格式 (N.Ns)
    const lastPost = postCalls[postCalls.length - 1]!.args as { text: string }
    expect(lastPost.text).toMatch(/\d+\.\d+s/)

    // 7. session 持久化：messages.jsonl 至少包含 user + assistant
    const sessionDir = path.join(paths.sessionsDir, 'slack', 'general.C1.t1')
    const jsonl = readFileSync(path.join(sessionDir, 'messages.jsonl'), 'utf8')
    const lines = jsonl.split('\n').filter((l) => l.length > 0)
    expect(lines.length).toBeGreaterThanOrEqual(2)
  })

  it('setStatus 瞬态 rate_limited 失败 → safeRender 吞掉，reply + done reaction 仍走通', async () => {
    const paths = resolveWorkspacePaths(cwd)
    const store = createSessionStore(paths)
    const memoryStore = createMemoryStore(paths)
    const logger = stubLogger()

    // 简单文本模型，直接输出回复
    const model = createMockModel([
      [
        { type: 'response-metadata', id: 'resp_1', modelId: 'mock-model' },
        { type: 'text-delta', textDelta: 'hello' },
        {
          type: 'finish',
          finishReason: 'stop',
          usage: { promptTokens: 3, completionTokens: 1 },
        },
      ],
    ])

    const executor = createAiSdkExecutor({
      model,
      tools: {},
      maxSteps: 3,
      logger,
      modelName: 'mock-model',
    })

    const orchestrator = createConversationOrchestrator({
      toolsBuilder: () => ({}),
      executorFactory: () => executor,
      sessionStore: store,
      memoryStore,
      runQueue: new SessionRunQueue(),
      abortRegistry: new AbortRegistry<string>(),
      systemPrompt: 'test',
      logger,
    })

    const { web, calls } = createMockWebClient()

    // 让首次 setStatus 抛 rate_limited 错误，后续正常
    let setStatusCallCount = 0
    const originalImpl = (
      web.assistant.threads.setStatus as ReturnType<typeof vi.fn>
    ).getMockImplementation()!

    ;(web.assistant.threads.setStatus as ReturnType<typeof vi.fn>).mockImplementation(
      async (args: unknown) => {
        setStatusCallCount += 1
        if (setStatusCallCount === 1) {
          const err = new Error('rate_limited')
          ;(err as unknown as Record<string, string>).code = 'slack_webapi_platform_error'
          ;(err as unknown as Record<string, string>).data = 'rate_limited'
          throw err
        }
        return originalImpl(args)
      },
    )

    const renderer = createSlackRenderer({ logger })
    const sink = createSlackEventSink({
      web,
      channelId: 'C2',
      threadTs: 't2',
      sourceMessageTs: 'm2',
      renderer,
      logger,
    })

    await orchestrator.handle(
      {
        imProvider: 'slack',
        channelId: 'C2',
        channelName: 'random',
        threadTs: 't2',
        userId: 'U2',
        userName: 'bob',
        text: '你好',
        messageTs: 'm2',
      },
      sink,
    )

    // setStatus 被尝试了多次（第一次失败后流程继续，后续还有调用）
    expect(setStatusCallCount).toBeGreaterThan(1)

    // chat.postMessage 仍然发出（reply 被送达）
    const postCalls = calls.filter((c) => c.method === 'chat.postMessage')
    expect(postCalls.length).toBeGreaterThanOrEqual(1)

    // 最后的 reactions.add 是 done（white_check_mark）
    const reactionCalls = calls.filter((c) => c.method === 'reactions.add')
    const lastReaction = reactionCalls[reactionCalls.length - 1]!.args as { name: string }
    expect(lastReaction.name).toBe('white_check_mark')
  })
})
