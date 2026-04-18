import { describe, expect, it, beforeEach } from 'vitest'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { MockLanguageModelV1, simulateReadableStream } from 'ai/test'
import type { LanguageModel } from 'ai'
import type { WebClient } from '@slack/web-api'
import { createSessionStore } from '@/store/SessionStore.ts'
import { createMemoryStore } from '@/store/MemoryStore.ts'
import { resolveWorkspacePaths } from '@/workspace/paths.ts'
import { createAiSdkExecutor } from '@/agent/AiSdkExecutor.ts'
import { createConversationOrchestrator } from '@/orchestrator/ConversationOrchestrator.ts'
import { createSlackEventSink } from '@/im/slack/SlackEventSink.ts'
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

interface UpdateCall {
  channel: string
  ts: string
  text: string
}

describe('MVP 集成：mock Slack + mock LLM 跑完整链路', () => {
  let cwd: string
  beforeEach(() => {
    cwd = mkdtempSync(path.join(tmpdir(), 'mvp-'))
  })

  it('text-delta → 持久化 messages.jsonl + meta.usage 非零 + chat.update 收到 finalText', async () => {
    const paths = resolveWorkspacePaths(cwd)
    const store = createSessionStore(paths)

    const model = new MockLanguageModelV1({
      doStream: async () => ({
        stream: simulateReadableStream({
          chunks: [
            { type: 'text-delta', textDelta: '你好' },
            {
              type: 'finish',
              finishReason: 'stop',
              usage: { promptTokens: 5, completionTokens: 2 },
            },
          ],
        }),
        rawCall: { rawPrompt: null, rawSettings: {} },
      }),
    })
    const memoryStore = createMemoryStore(paths)
    const executor = createAiSdkExecutor({
      model: model as unknown as LanguageModel,
      tools: {},
      maxSteps: 3,
      logger: stubLogger(),
      modelName: 'mock',
    })
    const orchestrator = createConversationOrchestrator({
      toolsBuilder: () => ({}),
      executorFactory: () => executor,
      sessionStore: store,
      memoryStore,
      systemPrompt: '',
      logger: stubLogger(),
    })

    const updates: UpdateCall[] = []
    const web = {
      chat: {
        update: async (args: UpdateCall) => {
          updates.push(args)
          return { ok: true }
        },
      },
      reactions: {
        add: async () => ({ ok: true }),
      },
    } as unknown as WebClient

    const sink = createSlackEventSink({
      web,
      channelId: 'C1',
      threadTs: 't1',
      placeholderTs: 'p1',
      logger: stubLogger(),
    })

    await orchestrator.handle(
      {
        imProvider: 'slack',
        channelId: 'C1',
        channelName: 'general',
        threadTs: 't1',
        userId: 'U1',
        userName: 'alice',
        text: '你好',
        messageTs: 'm1',
      },
      sink,
    )

    // chat.update 最后一次应包含 finalText
    expect(updates.at(-1)?.text).toBe('你好')

    // jsonl 两行（user + assistant）
    const sessionDir = path.join(paths.sessionsDir, 'slack', 'general.C1.t1')
    const jsonl = readFileSync(path.join(sessionDir, 'messages.jsonl'), 'utf8')
    const lines = jsonl.split('\n').filter((l) => l.length > 0)
    expect(lines).toHaveLength(2)

    // meta.usage.inputTokens > 0
    const meta = JSON.parse(readFileSync(path.join(sessionDir, 'meta.json'), 'utf8')) as {
      usage: { inputTokens: number; outputTokens: number }
      status: string
    }
    expect(meta.usage.inputTokens).toBeGreaterThan(0)
    expect(meta.usage.outputTokens).toBeGreaterThan(0)
    expect(meta.status).toBe('idle')
  })
})
