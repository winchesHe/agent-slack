import { describe, expect, it } from 'vitest'
import { MockLanguageModelV1, simulateReadableStream } from 'ai/test'
import { tool, type LanguageModel, type ToolSet } from 'ai'
import { z } from 'zod'
import { createAiSdkExecutor } from './AiSdkExecutor.ts'
import type { AgentExecutionEvent } from '@/core/events.ts'
import type { Logger } from '@/logger/logger.ts'

type MockStreamChunk = {
  type: string
  [key: string]: unknown
}

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

async function collect(gen: AsyncGenerator<AgentExecutionEvent>): Promise<AgentExecutionEvent[]> {
  const out: AgentExecutionEvent[] = []
  for await (const event of gen) {
    out.push(event)
  }
  return out
}

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

function createToolSet(): ToolSet {
  return {
    read_file: tool({
      description: '读取文件内容',
      parameters: z.object({ path: z.string() }),
      execute: async ({ path }) => `content:${path}`,
    }),
  }
}

function createExecutor(
  model: LanguageModel,
  tools: ToolSet = {},
  maxSteps = 4,
): ReturnType<typeof createAiSdkExecutor> {
  return createAiSdkExecutor({
    model,
    modelName: 'mock-model',
    tools,
    maxSteps,
    logger: stubLogger(),
  })
}

function lifecyclePhase(event: AgentExecutionEvent): string | undefined {
  return event.type === 'lifecycle' ? event.phase : undefined
}

describe('AiSdkExecutor 粗事件映射', () => {
  it('纯文本回复：started → thinking → composing → assistant-message → usage-info → completed', async () => {
    const executor = createExecutor(
      createMockModel([
        [
          { type: 'response-metadata', id: 'resp_1', modelId: 'mock-model' },
          { type: 'text-delta', textDelta: 'hello ' },
          { type: 'text-delta', textDelta: 'world' },
          {
            type: 'finish',
            finishReason: 'stop',
            usage: { promptTokens: 10, completionTokens: 5 },
            providerMetadata: { litellm: { cost: 0.12 } },
          },
        ],
      ]),
    )

    const events = await collect(
      executor.execute({
        systemPrompt: 'system',
        messages: [{ role: 'user', content: 'hi' }],
        abortSignal: new AbortController().signal,
      }),
    )

    expect(events.map((event) => `${event.type}:${lifecyclePhase(event) ?? ''}`)).toEqual([
      'lifecycle:started',
      'activity-state:',
      'activity-state:',
      'assistant-message:',
      'usage-info:',
      'lifecycle:completed',
    ])

    const started = events[0]
    const thinking = events[1]
    const composing = events[2]
    const assistantMessage = events[3]
    const usageInfo = events[4]
    const completed = events[5]

    expect(started).toEqual({ type: 'lifecycle', phase: 'started' })
    expect(thinking).toMatchObject({
      type: 'activity-state',
      state: { status: '思考中…' },
    })
    expect(composing).toMatchObject({
      type: 'activity-state',
      state: { status: '回复中…', composing: true },
    })
    expect(assistantMessage).toEqual({ type: 'assistant-message', text: 'hello world' })
    expect(usageInfo).toMatchObject({
      type: 'usage-info',
      usage: {
        totalCostUSD: 0.12,
        modelUsage: [
          {
            model: 'mock-model',
            inputTokens: 10,
            outputTokens: 5,
            cachedInputTokens: 0,
            cacheHitRate: 0,
          },
        ],
      },
    })
    expect(usageInfo?.type).toBe('usage-info')
    if (usageInfo?.type === 'usage-info') {
      expect(usageInfo.usage.durationMs).toBeGreaterThanOrEqual(0)
    }
    expect(completed).toMatchObject({
      type: 'lifecycle',
      phase: 'completed',
      finalMessages: [
        {
          role: 'assistant',
          content: [{ type: 'text', text: 'hello world' }],
        },
      ],
    })
    expect(
      completed?.type === 'lifecycle' && completed.phase === 'completed'
        ? completed.finalMessages[0]?.id
        : undefined,
    ).toEqual(expect.any(String))
  })

  it('assistant-message 按 step 边界切分，每个非空 step 只产出一条消息', async () => {
    const executor = createExecutor(
      createMockModel([
        [
          { type: 'response-metadata', id: 'resp_1', modelId: 'mock-model' },
          { type: 'text-delta', textDelta: 'A' },
          {
            type: 'tool-call',
            toolCallType: 'function',
            toolCallId: 'call_1',
            toolName: 'read_file',
            args: '{"path":"a.ts"}',
          },
          {
            type: 'finish',
            finishReason: 'tool-calls',
            usage: { promptTokens: 3, completionTokens: 1 },
            providerMetadata: { litellm: { cost: 0.01 } },
          },
        ],
        [
          { type: 'response-metadata', id: 'resp_2', modelId: 'mock-model' },
          { type: 'text-delta', textDelta: 'B' },
          {
            type: 'finish',
            finishReason: 'stop',
            usage: { promptTokens: 2, completionTokens: 1 },
            providerMetadata: { litellm: { cost: 0.02 } },
          },
        ],
      ]),
      createToolSet(),
    )

    const events = await collect(
      executor.execute({
        systemPrompt: '',
        messages: [{ role: 'user', content: 'hi' }],
        abortSignal: new AbortController().signal,
      }),
    )

    const texts = events
      .filter(
        (event): event is Extract<AgentExecutionEvent, { type: 'assistant-message' }> =>
          event.type === 'assistant-message',
      )
      .map((event) => event.text)

    expect(texts).toEqual(['A', 'B'])
  })

  it('assistant-message 保留 step 原始文本，只用 trim 判断是否为空 step', async () => {
    const executor = createExecutor(
      createMockModel([
        [
          { type: 'response-metadata', id: 'resp_1', modelId: 'mock-model' },
          { type: 'text-delta', textDelta: '    const x = 1;' },
          { type: 'text-delta', textDelta: '\n' },
          {
            type: 'finish',
            finishReason: 'stop',
            usage: { promptTokens: 4, completionTokens: 2 },
            providerMetadata: { litellm: { cost: 0.01 } },
          },
        ],
      ]),
    )

    const events = await collect(
      executor.execute({
        systemPrompt: '',
        messages: [{ role: 'user', content: 'hi' }],
        abortSignal: new AbortController().signal,
      }),
    )

    const assistantMessage = events.find(
      (event): event is Extract<AgentExecutionEvent, { type: 'assistant-message' }> =>
        event.type === 'assistant-message',
    )

    expect(assistantMessage).toEqual({
      type: 'assistant-message',
      text: '    const x = 1;\n',
    })
  })

  it('空 step 不产出 assistant-message', async () => {
    const executor = createExecutor(
      createMockModel([
        [
          { type: 'response-metadata', id: 'resp_1', modelId: 'mock-model' },
          {
            type: 'tool-call',
            toolCallType: 'function',
            toolCallId: 'call_1',
            toolName: 'read_file',
            args: '{"path":"a.ts"}',
          },
          {
            type: 'finish',
            finishReason: 'tool-calls',
            usage: { promptTokens: 3, completionTokens: 0 },
            providerMetadata: { litellm: { cost: 0.01 } },
          },
        ],
        [
          { type: 'response-metadata', id: 'resp_2', modelId: 'mock-model' },
          { type: 'text-delta', textDelta: 'only-second' },
          {
            type: 'finish',
            finishReason: 'stop',
            usage: { promptTokens: 2, completionTokens: 1 },
            providerMetadata: { litellm: { cost: 0.02 } },
          },
        ],
      ]),
      createToolSet(),
    )

    const events = await collect(
      executor.execute({
        systemPrompt: '',
        messages: [{ role: 'user', content: 'hi' }],
        abortSignal: new AbortController().signal,
      }),
    )

    const texts = events
      .filter(
        (event): event is Extract<AgentExecutionEvent, { type: 'assistant-message' }> =>
          event.type === 'assistant-message',
      )
      .map((event) => event.text)

    expect(texts).toEqual(['only-second'])
  })

  it('tool 流：发出 newToolCalls、工具状态，并在 tool-result 后回到 thinking', async () => {
    const executor = createExecutor(
      createMockModel([
        [
          { type: 'response-metadata', id: 'resp_1', modelId: 'mock-model' },
          {
            type: 'tool-call-delta',
            toolCallType: 'function',
            toolCallId: 'call_1',
            toolName: 'read_file',
            argsTextDelta: '{',
          },
          {
            type: 'tool-call-delta',
            toolCallType: 'function',
            toolCallId: 'call_1',
            toolName: 'read_file',
            argsTextDelta: '"path":"a.ts"}',
          },
          {
            type: 'tool-call',
            toolCallType: 'function',
            toolCallId: 'call_1',
            toolName: 'read_file',
            args: '{"path":"a.ts"}',
          },
          {
            type: 'finish',
            finishReason: 'tool-calls',
            usage: { promptTokens: 3, completionTokens: 0 },
            providerMetadata: { litellm: { cost: 0.01 } },
          },
        ],
        [
          { type: 'response-metadata', id: 'resp_2', modelId: 'mock-model' },
          { type: 'text-delta', textDelta: 'done' },
          {
            type: 'finish',
            finishReason: 'stop',
            usage: { promptTokens: 2, completionTokens: 1 },
            providerMetadata: { litellm: { cost: 0.02 } },
          },
        ],
      ]),
      createToolSet(),
    )

    const events = await collect(
      executor.execute({
        systemPrompt: '',
        messages: [{ role: 'user', content: 'hi' }],
        abortSignal: new AbortController().signal,
      }),
    )

    const activities = events.filter(
      (event): event is Extract<AgentExecutionEvent, { type: 'activity-state' }> =>
        event.type === 'activity-state',
    )
    const newToolState = activities.find(
      (event) => event.state.clear !== true && event.state.newToolCalls?.includes('read_file'),
    )
    const toolStatusIndex = activities.findIndex(
      (event) => event.state.clear !== true && event.state.status.includes('read_file'),
    )
    const backToThinking = activities
      .slice(toolStatusIndex + 1)
      .find((event) => event.state.clear !== true && event.state.status === '思考中…')

    expect(newToolState).toBeDefined()
    expect(toolStatusIndex).toBeGreaterThanOrEqual(0)
    expect(backToThinking).toBeDefined()
  })

  it('maxSteps 耗尽且仍需继续工具调用时，发总结回复并以 stopped(max_steps) 收口', async () => {
    const executor = createExecutor(
      createMockModel([
        [
          { type: 'response-metadata', id: 'resp_1', modelId: 'mock-model' },
          {
            type: 'tool-call',
            toolCallType: 'function',
            toolCallId: 'call_1',
            toolName: 'read_file',
            args: '{"path":"a.ts"}',
          },
          {
            type: 'finish',
            finishReason: 'tool-calls',
            usage: { promptTokens: 3, completionTokens: 0 },
            providerMetadata: { litellm: { cost: 0.01 } },
          },
        ],
      ]),
      createToolSet(),
      1,
    )

    const events = await collect(
      executor.execute({
        systemPrompt: '',
        messages: [{ role: 'user', content: 'hi' }],
        abortSignal: new AbortController().signal,
      }),
    )

    const summaries = events.filter(
      (event): event is Extract<AgentExecutionEvent, { type: 'assistant-message' }> =>
        event.type === 'assistant-message' && event.text.includes('maxSteps 上限'),
    )
    const stopped = events.find(
      (event): event is Extract<AgentExecutionEvent, { type: 'lifecycle'; phase: 'stopped' }> =>
        event.type === 'lifecycle' && event.phase === 'stopped',
    )

    expect(summaries).toHaveLength(1)
    expect(summaries[0]?.text).toContain('当前已知上下文总结')
    expect(summaries[0]?.text).toContain('read_file x1')
    expect(stopped).toMatchObject({
      type: 'lifecycle',
      phase: 'stopped',
      reason: 'max_steps',
      summary: summaries[0]?.text,
    })
    expect(events.find((event) => event.type === 'usage-info')).toBeDefined()
    expect(
      events.find((event) => event.type === 'lifecycle' && lifecyclePhase(event) === 'completed'),
    ).toBeUndefined()
  })

  it('同名 tool 重复调用时，每次都会发 newToolCalls 供 sink 累加计数', async () => {
    const executor = createExecutor(
      createMockModel([
        [
          { type: 'response-metadata', id: 'resp_1', modelId: 'mock-model' },
          {
            type: 'tool-call-delta',
            toolCallType: 'function',
            toolCallId: 'call_1',
            toolName: 'read_file',
            argsTextDelta: '{"path":"a.ts"}',
          },
          {
            type: 'tool-call',
            toolCallType: 'function',
            toolCallId: 'call_1',
            toolName: 'read_file',
            args: '{"path":"a.ts"}',
          },
          {
            type: 'finish',
            finishReason: 'tool-calls',
            usage: { promptTokens: 3, completionTokens: 0 },
            providerMetadata: { litellm: { cost: 0.01 } },
          },
        ],
        [
          { type: 'response-metadata', id: 'resp_2', modelId: 'mock-model' },
          {
            type: 'tool-call-delta',
            toolCallType: 'function',
            toolCallId: 'call_2',
            toolName: 'read_file',
            argsTextDelta: '{"path":"b.ts"}',
          },
          {
            type: 'tool-call',
            toolCallType: 'function',
            toolCallId: 'call_2',
            toolName: 'read_file',
            args: '{"path":"b.ts"}',
          },
          {
            type: 'finish',
            finishReason: 'tool-calls',
            usage: { promptTokens: 3, completionTokens: 0 },
            providerMetadata: { litellm: { cost: 0.01 } },
          },
        ],
        [
          { type: 'response-metadata', id: 'resp_3', modelId: 'mock-model' },
          { type: 'text-delta', textDelta: 'done' },
          {
            type: 'finish',
            finishReason: 'stop',
            usage: { promptTokens: 2, completionTokens: 1 },
            providerMetadata: { litellm: { cost: 0.02 } },
          },
        ],
      ]),
      createToolSet(),
    )

    const events = await collect(
      executor.execute({
        systemPrompt: '',
        messages: [{ role: 'user', content: 'hi' }],
        abortSignal: new AbortController().signal,
      }),
    )

    const newToolEvents = events.filter(
      (event): event is Extract<AgentExecutionEvent, { type: 'activity-state' }> =>
        event.type === 'activity-state' &&
        event.state.clear !== true &&
        event.state.newToolCalls?.includes('read_file') === true,
    )

    expect(newToolEvents).toHaveLength(2)
  })

  it('reasoning 会产出带 reasoningTail 的 activity-state，并在出文本后切到 composing', async () => {
    const executor = createExecutor(
      createMockModel([
        [
          { type: 'response-metadata', id: 'resp_1', modelId: 'mock-model' },
          { type: 'reasoning', textDelta: '先分析上下文，' },
          { type: 'reasoning', textDelta: '再组织答案。' },
          { type: 'text-delta', textDelta: '最终答案' },
          {
            type: 'finish',
            finishReason: 'stop',
            usage: { promptTokens: 6, completionTokens: 3 },
            providerMetadata: { litellm: { cost: 0.03 } },
          },
        ],
      ]),
    )

    const events = await collect(
      executor.execute({
        systemPrompt: '',
        messages: [{ role: 'user', content: 'hi' }],
        abortSignal: new AbortController().signal,
      }),
    )

    const reasoningEvent = events.find(
      (event): event is Extract<AgentExecutionEvent, { type: 'activity-state' }> =>
        event.type === 'activity-state' &&
        event.state.clear !== true &&
        event.state.status === '推理中…',
    )
    const composingEvent = events.find(
      (event): event is Extract<AgentExecutionEvent, { type: 'activity-state' }> =>
        event.type === 'activity-state' &&
        event.state.clear !== true &&
        event.state.status === '回复中…',
    )

    expect(reasoningEvent).toBeDefined()
    expect(reasoningEvent?.state.clear).not.toBe(true)
    if (reasoningEvent && reasoningEvent.state.clear !== true) {
      expect(reasoningEvent.state.reasoningTail).toContain('先分析上下文')
    }
    expect(composingEvent).toBeDefined()
  })

  it('direct tool-call fallback 也会结束上一段 reasoning，下一 step 不会串味', async () => {
    const executor = createExecutor(
      createMockModel([
        [
          { type: 'response-metadata', id: 'resp_1', modelId: 'mock-model' },
          { type: 'reasoning', textDelta: '第一段推理第一段推理第一段推理第一段推理。' },
          {
            type: 'tool-call',
            toolCallType: 'function',
            toolCallId: 'call_1',
            toolName: 'read_file',
            args: '{"path":"a.ts"}',
          },
          {
            type: 'finish',
            finishReason: 'tool-calls',
            usage: { promptTokens: 4, completionTokens: 0 },
            providerMetadata: { litellm: { cost: 0.01 } },
          },
        ],
        [
          { type: 'response-metadata', id: 'resp_2', modelId: 'mock-model' },
          { type: 'reasoning', textDelta: '第二段推理第二段推理第二段推理第二段推理。' },
          { type: 'text-delta', textDelta: 'done' },
          {
            type: 'finish',
            finishReason: 'stop',
            usage: { promptTokens: 3, completionTokens: 1 },
            providerMetadata: { litellm: { cost: 0.02 } },
          },
        ],
      ]),
      createToolSet(),
    )

    const events = await collect(
      executor.execute({
        systemPrompt: '',
        messages: [{ role: 'user', content: 'hi' }],
        abortSignal: new AbortController().signal,
      }),
    )

    const reasoningEvents = events.filter(
      (event): event is Extract<AgentExecutionEvent, { type: 'activity-state' }> =>
        event.type === 'activity-state' &&
        event.state.clear !== true &&
        event.state.status === '推理中…',
    )

    expect(reasoningEvents).toHaveLength(2)
    expect(reasoningEvents[0]?.state.reasoningTail).toContain('第一段推理')
    expect(reasoningEvents[1]?.state.reasoningTail).toContain('第二段推理')
    expect(reasoningEvents[1]?.state.reasoningTail).not.toContain('第一段推理')
  })

  it('error part → lifecycle(failed)，且后续不再发 completed/usage-info', async () => {
    const executor = createExecutor(
      createMockModel([
        [
          { type: 'response-metadata', id: 'resp_1', modelId: 'mock-model' },
          { type: 'text-delta', textDelta: 'partial' },
          { type: 'error', error: 'provider blocked' },
        ],
      ]),
    )

    const events = await collect(
      executor.execute({
        systemPrompt: '',
        messages: [{ role: 'user', content: 'hi' }],
        abortSignal: new AbortController().signal,
      }),
    )

    const failed = events.find(
      (event): event is Extract<AgentExecutionEvent, { type: 'lifecycle'; phase: 'failed' }> =>
        event.type === 'lifecycle' && event.phase === 'failed',
    )
    const failedIndex = failed ? events.indexOf(failed) : -1

    expect(failed).toMatchObject({
      type: 'lifecycle',
      phase: 'failed',
      error: { message: 'provider blocked' },
    })
    expect(
      events.slice(failedIndex + 1).find((event) => event.type === 'usage-info'),
    ).toBeUndefined()
    expect(
      events
        .slice(failedIndex + 1)
        .find((event) => event.type === 'lifecycle' && lifecyclePhase(event) === 'completed'),
    ).toBeUndefined()
  })

  it('error part 的失败文案会做基础脱敏，避免直接透传凭证', async () => {
    const executor = createExecutor(
      createMockModel([
        [
          { type: 'response-metadata', id: 'resp_1', modelId: 'mock-model' },
          { type: 'error', error: 'provider blocked, token=xoxb-secret-value sk-test-1234' },
        ],
      ]),
    )

    const events = await collect(
      executor.execute({
        systemPrompt: '',
        messages: [{ role: 'user', content: 'hi' }],
        abortSignal: new AbortController().signal,
      }),
    )

    const failed = events.find(
      (event): event is Extract<AgentExecutionEvent, { type: 'lifecycle'; phase: 'failed' }> =>
        event.type === 'lifecycle' && event.phase === 'failed',
    )

    expect(failed?.error?.message).toContain('[REDACTED]')
    expect(failed?.error?.message).not.toContain('xoxb-secret-value')
    expect(failed?.error?.message).not.toContain('sk-test-1234')
  })

  it('streamText 同步抛错时，仍然先发 started/thinking，再统一收口为 lifecycle(failed)', async () => {
    const executor = createAiSdkExecutor({
      model: undefined as unknown as LanguageModel,
      modelName: 'broken-model',
      tools: {},
      maxSteps: 1,
      logger: stubLogger(),
    })

    const events = await collect(
      executor.execute({
        systemPrompt: '',
        messages: [{ role: 'user', content: 'hi' }],
        abortSignal: new AbortController().signal,
      }),
    )

    expect(events.slice(0, 2)).toMatchObject([
      { type: 'lifecycle', phase: 'started' },
      { type: 'activity-state', state: { status: '思考中…' } },
    ])
    expect(events.at(-1)).toMatchObject({
      type: 'lifecycle',
      phase: 'failed',
    })
  })

  it('AbortError → lifecycle(stopped, reason=user) + activity-state{clear}', async () => {
    const controller = new AbortController()
    const model = new MockLanguageModelV1({
      doStream: async ({ abortSignal }) =>
        ({
          stream: new ReadableStream<MockStreamChunk>({
            start(streamController) {
              streamController.enqueue({
                type: 'response-metadata',
                id: 'resp_abort',
                modelId: 'mock-model',
              })
              streamController.enqueue({ type: 'text-delta', textDelta: 'first chunk' })

              const stop = () => {
                const error = new Error('aborted')
                error.name = 'AbortError'
                streamController.error(error)
              }

              if (abortSignal?.aborted) {
                stop()
                return
              }

              abortSignal?.addEventListener('abort', stop, { once: true })
            },
          }),
          rawCall: { rawPrompt: null, rawSettings: {} },
        }) as never,
    })

    const executor = createExecutor(model as unknown as LanguageModel)
    const abortLater = setTimeout(() => controller.abort(), 10)

    const events = await collect(
      executor.execute({
        systemPrompt: '',
        messages: [{ role: 'user', content: 'hi' }],
        abortSignal: controller.signal,
      }),
    )

    clearTimeout(abortLater)

    const stopped = events.find(
      (event): event is Extract<AgentExecutionEvent, { type: 'lifecycle' }> =>
        event.type === 'lifecycle' && event.phase === 'stopped',
    )
    const clearState = events.find(
      (event): event is Extract<AgentExecutionEvent, { type: 'activity-state' }> =>
        event.type === 'activity-state' && event.state.clear === true,
    )

    expect(stopped).toMatchObject({
      type: 'lifecycle',
      phase: 'stopped',
      reason: 'user',
    })
    expect(clearState).toEqual({ type: 'activity-state', state: { clear: true } })
    expect(events.find((event) => event.type === 'usage-info')).toBeUndefined()
  })
})
