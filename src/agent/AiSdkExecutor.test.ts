import { describe, expect, it } from 'vitest'
import { MockLanguageModelV1, simulateReadableStream } from 'ai/test'
import type { LanguageModel } from 'ai'
import { createAiSdkExecutor } from './AiSdkExecutor.ts'
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

describe('AiSdkExecutor', () => {
  it('映射 text-delta 和 finish 为 text_delta + done', async () => {
    const model = new MockLanguageModelV1({
      doStream: async () => ({
        stream: simulateReadableStream({
          chunks: [
            { type: 'text-delta', textDelta: 'hello' },
            { type: 'text-delta', textDelta: ' world' },
            {
              type: 'finish',
              finishReason: 'stop',
              usage: { promptTokens: 10, completionTokens: 2 },
            },
          ],
        }),
        rawCall: { rawPrompt: null, rawSettings: {} },
      }),
    })
    const exec = createAiSdkExecutor({
      model: model as unknown as LanguageModel,
      tools: {},
      maxSteps: 5,
      logger: stubLogger(),
    })
    const events: { type: string }[] = []
    const ctrl = new AbortController()
    for await (const e of exec.execute({
      systemPrompt: '',
      messages: [{ role: 'user', content: 'hi' }],
      abortSignal: ctrl.signal,
    })) {
      events.push(e)
    }
    const types = events.map((e) => e.type)
    expect(types).toContain('text_delta')
    expect(types).toContain('done')
  })
})
