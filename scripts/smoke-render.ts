import type { WebClient } from '@slack/web-api'
import { tool, type LanguageModel, type ToolSet } from 'ai'
import { MockLanguageModelV1, simulateReadableStream } from 'ai/test'
import { z } from 'zod'
import { createAiSdkExecutor } from '@/agent/AiSdkExecutor.ts'
import type { AgentExecutionEvent } from '@/core/events.ts'
import type { Logger } from '@/logger/logger.ts'
import { createSlackEventSink } from '@/im/slack/SlackEventSink.ts'
import { createSlackRenderer } from '@/im/slack/SlackRenderer.ts'
import { STATUS, getShuffledLoadingMessages } from '@/im/slack/thinking-messages.ts'

type MockStreamChunk = {
  type: string
  [key: string]: unknown
}

// 统一写 stdout，方便 smoke 输出保持一行一个事件。
function writeLine(line: string): void {
  process.stdout.write(`${line}\n`)
}

// 截断过长 payload，避免观测输出被大段 blocks 淹没。
function formatValue(value: unknown): string {
  if (value instanceof Error) {
    return value.stack ?? value.message
  }

  const json = JSON.stringify(value)
  return json.length > 220 ? `${json.slice(0, 220)}...` : json
}

// smoke logger 直接把 warn/info 打到终端，便于观察 safeRender 行为。
function createSmokeLogger(tag = 'smoke'): Logger {
  return {
    trace: (message, meta) =>
      writeLine(`[trace] [${tag}] ${message}${meta ? ` ${formatValue(meta)}` : ''}`),
    debug: (message, meta) =>
      writeLine(`[debug] [${tag}] ${message}${meta ? ` ${formatValue(meta)}` : ''}`),
    info: (message, meta) =>
      writeLine(`[info] [${tag}] ${message}${meta ? ` ${formatValue(meta)}` : ''}`),
    warn: (message, meta) =>
      writeLine(`[warn] [${tag}] ${message}${meta ? ` ${formatValue(meta)}` : ''}`),
    error: (message, meta) =>
      writeLine(`[error] [${tag}] ${message}${meta ? ` ${formatValue(meta)}` : ''}`),
    withTag: (nextTag) => createSmokeLogger(nextTag),
  }
}

// 用纯 mock WebClient 记录 renderer 调用了哪些 Slack API，不产生真实副作用。
function createMockWebClient(): WebClient {
  let messageIndex = 0

  const record =
    (method: string, resultFactory?: () => { ok: true; ts?: string }) =>
    async (args: unknown): Promise<{ ok: true; ts?: string }> => {
      writeLine(`→ ${method} ${formatValue(args)}`)
      return resultFactory ? resultFactory() : { ok: true }
    }

  return {
    reactions: {
      add: record('reactions.add'),
    },
    chat: {
      postMessage: record('chat.postMessage', () => {
        messageIndex += 1
        return { ok: true, ts: `ts-${messageIndex}` }
      }),
      update: record('chat.update'),
      delete: record('chat.delete'),
    },
    assistant: {
      threads: {
        setStatus: record('assistant.threads.setStatus'),
      },
    },
  } as unknown as WebClient
}

function createChunk3Model(stepChunks: MockStreamChunk[][]): LanguageModel {
  const responses = [...stepChunks]

  return new MockLanguageModelV1({
    doStream: async () => {
      const chunks = responses.shift()
      if (!chunks) {
        throw new Error('chunk 3 smoke 缺少后续 mock 响应')
      }

      return {
        stream: simulateReadableStream({ chunks }) as unknown as ReadableStream<never>,
        rawCall: { rawPrompt: null, rawSettings: {} },
      } as never
    },
  }) as unknown as LanguageModel
}

function createChunk3Tools(): ToolSet {
  return {
    read_file: tool({
      description: '读取文件内容',
      parameters: z.object({ path: z.string() }),
      execute: async ({ path }) => `content:${path}`,
    }),
  }
}

function summarizeChunk3Event(event: AgentExecutionEvent | undefined): string {
  if (!event) {
    return 'event=undefined'
  }

  switch (event.type) {
    case 'activity-state':
      return event.state.clear
        ? 'clear=true'
        : `status=${event.state.status} composing=${!!event.state.composing} newTools=${(event.state.newToolCalls ?? []).join(',')} reasoning=${event.state.reasoningTail ?? ''}`
    case 'assistant-message':
      return `text=${JSON.stringify(event.text)}`
    case 'usage-info':
      return `durationMs=${event.usage.durationMs} cost=${event.usage.totalCostUSD.toFixed(4)} models=${event.usage.modelUsage.length}`
    case 'lifecycle':
      return `phase=${event.phase} finalMessages=${'finalMessages' in event ? (event.finalMessages?.length ?? 0) : 0}`
  }
}

async function runChunk2Smoke(): Promise<void> {
  writeLine('====== [CHUNK 2] SlackRenderer smoke ======')

  const renderer = createSlackRenderer({ logger: createSmokeLogger() })
  {
    // done path：验证 ack、状态条、progress、usage、完成 reaction 的组合。
    const web = createMockWebClient()
    writeLine('[CHUNK 2] done path')
    await renderer.addAck(web, 'C1', 'src-ts')
    await renderer.setStatus(web, 'C1', 't1', STATUS.thinking, getShuffledLoadingMessages(4))

    const progressTs = await renderer.upsertProgressMessage(web, 'C1', 't1', {
      status: '正在 read_file…',
      activities: ['正在 read_file…'],
      toolHistory: new Map([['read_file', 1]]),
    })
    writeLine(`[CHUNK 2] done path progress ts = ${progressTs ?? 'undefined'}`)

    if (progressTs) {
      await renderer.finalizeProgressMessageDone(
        web,
        'C1',
        't1',
        progressTs,
        new Map([
          ['read_file', 2],
          ['bash', 1],
        ]),
      )
    }

    await renderer.postSessionUsage(web, 'C1', 't1', {
      durationMs: 11_200,
      totalCostUSD: 0.0676,
      modelUsage: [
        {
          model: 'sonnet-4-6',
          inputTokens: 1000,
          outputTokens: 200,
          cachedInputTokens: 620,
          cacheHitRate: 0.62,
        },
      ],
    })
    await renderer.clearStatus(web, 'C1', 't1')
    await renderer.addDone(web, 'C1', 'src-ts')
  }

  {
    // reply path：验证 markdown reply 与首块 workspaceLabel 注入。
    const web = createMockWebClient()
    writeLine('[CHUNK 2] reply path')
    await renderer.postThreadReply(web, 'C1', 't1', '**hello** _world_', {
      workspaceLabel: 'workspace: demo',
    })
  }

  {
    // stopped path：验证中止文案与 stop reaction，不混入其他终态。
    const web = createMockWebClient()
    writeLine('[CHUNK 2] stopped path')
    const progressTs = await renderer.upsertProgressMessage(web, 'C1', 't1', {
      status: '正在 bash…',
      activities: ['正在 bash…', '命令执行中…'],
      toolHistory: new Map([
        ['read_file', 2],
        ['bash', 1],
      ]),
      reasoningTail: '正在整理命令输出摘要',
    })
    writeLine(`[CHUNK 2] stopped path progress ts = ${progressTs ?? 'undefined'}`)
    if (progressTs) {
      await renderer.finalizeProgressMessageStopped(web, 'C1', 't1', progressTs)
    }
    await renderer.clearStatus(web, 'C1', 't1')
    await renderer.addStopped(web, 'C1', 'src-ts')
  }

  {
    // error path：验证错误 finalize 和 error reaction。
    const web = createMockWebClient()
    writeLine('[CHUNK 2] error path')
    const progressTs = await renderer.upsertProgressMessage(web, 'C1', 't1', {
      status: '正在 deploy…',
      activities: ['正在 deploy…'],
      toolHistory: new Map([['deploy', 1]]),
    })
    writeLine(`[CHUNK 2] error path progress ts = ${progressTs ?? 'undefined'}`)
    if (progressTs) {
      await renderer.finalizeProgressMessageError(web, 'C1', 't1', progressTs, 'boom')
    }
    await renderer.addError(web, 'C1', 'src-ts')
  }

  {
    // delete path：单独验证 progress 删除动作。
    const web = createMockWebClient()
    writeLine('[CHUNK 2] delete path')
    const progressTs = await renderer.upsertProgressMessage(web, 'C1', 't1', {
      status: '准备清理 progress…',
      activities: ['准备清理 progress…'],
      toolHistory: new Map([['cleanup', 1]]),
    })
    writeLine(`[CHUNK 2] delete path progress ts = ${progressTs ?? 'undefined'}`)
    if (progressTs) {
      await renderer.deleteProgressMessage(web, 'C1', 't1', progressTs)
    }
  }
}

async function runChunk3Smoke(): Promise<void> {
  writeLine('\n====== [CHUNK 3] AiSdkExecutor smoke ======')

  const scenarios: Array<{
    label: string
    stepChunks: MockStreamChunk[][]
    tools?: ToolSet
  }> = [
    {
      label: 'text-only',
      stepChunks: [
        [
          { type: 'response-metadata', id: 'resp_1', modelId: 'mock-model' },
          { type: 'reasoning', textDelta: '先分析上下文，再组织答案。' },
          { type: 'text-delta', textDelta: 'hello ' },
          { type: 'text-delta', textDelta: 'world' },
          {
            type: 'finish',
            finishReason: 'stop',
            usage: { promptTokens: 10, completionTokens: 5 },
            providerMetadata: { litellm: { cost: 0.12 } },
          },
        ],
      ],
    },
    {
      label: 'tool-loop',
      tools: createChunk3Tools(),
      stepChunks: [
        [
          { type: 'response-metadata', id: 'resp_2', modelId: 'mock-model' },
          // 注意：ai/test 不能直接喂 tool-call-streaming-start；这里用 delta 让 AI SDK 自己合成该阶段。
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
            providerMetadata: { litellm: { response_cost: 0.01 } },
          },
        ],
        [
          { type: 'response-metadata', id: 'resp_3', modelId: 'mock-model' },
          { type: 'text-delta', textDelta: 'done' },
          {
            type: 'finish',
            finishReason: 'stop',
            usage: { promptTokens: 2, completionTokens: 1 },
            providerMetadata: { openaiCompat: { cost: 0.02 } },
          },
        ],
      ],
    },
  ]

  for (const scenario of scenarios) {
    writeLine(`[CHUNK 3] scenario = ${scenario.label}`)

    const executor = createAiSdkExecutor({
      model: createChunk3Model(scenario.stepChunks),
      modelName: 'mock-model',
      tools: scenario.tools ?? {},
      maxSteps: 3,
      logger: createSmokeLogger('chunk3'),
    })

    for await (const event of executor.execute({
      systemPrompt: 'system',
      messages: [{ role: 'user', content: 'hi' }],
      abortSignal: new AbortController().signal,
    })) {
      writeLine(`event[${event.type}] ${summarizeChunk3Event(event)}`)
    }
  }
}

async function runChunk4Smoke(): Promise<void> {
  writeLine('\n====== [CHUNK 4] Sink drives Renderer ======')

  const renderer = createSlackRenderer({ logger: createSmokeLogger('chunk4-renderer') })
  const web = createMockWebClient()
  const sink = createSlackEventSink({
    web,
    channelId: 'C1',
    threadTs: 't1',
    sourceMessageTs: 'src-ts',
    renderer,
    logger: createSmokeLogger('chunk4-sink'),
  })

  await sink.onEvent({ type: 'lifecycle', phase: 'started' })
  await sink.onEvent({
    type: 'activity-state',
    state: { status: '思考中…', activities: ['梳理中…', '继续思考…'] },
  })
  await sink.onEvent({
    type: 'activity-state',
    state: {
      status: '正在 read_file…',
      activities: ['正在 read_file…'],
      newToolCalls: ['read_file'],
    },
  })
  await sink.onEvent({
    type: 'activity-state',
    state: {
      status: '正在 read_file…',
      activities: ['正在 read_file…'],
      newToolCalls: ['read_file'],
    },
  })
  await sink.onEvent({ type: 'assistant-message', text: '**查到了** 你的 `config.yaml` 存在。' })
  await sink.onEvent({
    type: 'usage-info',
    usage: {
      durationMs: 8_300,
      totalCostUSD: 0.0123,
      modelUsage: [
        {
          model: 'sonnet-4-6',
          inputTokens: 800,
          outputTokens: 120,
          cachedInputTokens: 500,
          cacheHitRate: 0.625,
        },
      ],
    },
  })
  await sink.onEvent({ type: 'lifecycle', phase: 'completed', finalMessages: [] })
  await sink.finalize()
}

async function main(): Promise<void> {
  await runChunk2Smoke()
  await runChunk3Smoke()
  await runChunk4Smoke()
}

main().catch((error: unknown) => {
  process.stderr.write(String(error) + '\n')
  process.exitCode = 1
})
