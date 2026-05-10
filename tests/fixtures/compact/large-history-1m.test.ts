import fs from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { streamText, type LanguageModelV1 } from 'ai'
import { MockLanguageModelV1, simulateReadableStream } from 'ai/test'

const FIXTURE_PATH = path.join(
  process.cwd(),
  'tests',
  'fixtures',
  'compact',
  'large-history-1m.jsonl',
)

// 复现 e2e auto-compact-breaker-open 撞到的 bug：fixture 里 tool-call 用 `input` /
// tool-result 缺 `toolName`，被 ai-sdk standardizePrompt 拒绝。SessionStore 加的
// 顶层 `id` 字段 ai-sdk 会静默 strip，不会因此报错。
//
// 防回归：fixture 必须能直接喂进 streamText 而不抛 AI_InvalidPromptError。
describe('compact fixture：large-history-1m.jsonl', () => {
  it('每行解析为合法 CoreMessage，能被 ai-sdk streamText 接受（id 字段静默丢弃）', async () => {
    const raw = await fs.readFile(FIXTURE_PATH, 'utf8')
    const messages = raw
      .split('\n')
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line))

    expect(messages.length).toBeGreaterThan(0)

    const model = new MockLanguageModelV1({
      doStream: async () => ({
        stream: simulateReadableStream({
          chunks: [
            { type: 'response-metadata', id: 'r', modelId: 'mock' },
            { type: 'text-delta', textDelta: 'ok' },
            {
              type: 'finish',
              finishReason: 'stop',
              usage: { promptTokens: 1, completionTokens: 1 },
            },
          ],
        }) as unknown as ReadableStream<never>,
        rawCall: { rawPrompt: null, rawSettings: {} },
      }),
    }) as unknown as LanguageModelV1

    // standardizePrompt 在 streamText 同步路径里就会跑；任意 schema 错都会同步抛
    // AI_InvalidPromptError。这里仅断言"构造不抛"——不真正消费流。
    expect(() =>
      streamText({
        model,
        messages,
      }),
    ).not.toThrow()
  })
})
