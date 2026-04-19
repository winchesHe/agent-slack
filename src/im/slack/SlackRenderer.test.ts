import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { WebClient } from '@slack/web-api'
import type { Logger } from '@/logger/logger.ts'
import { markdownToBlocks, splitBlocksWithText } from 'markdown-to-slack-blocks'
import { createSlackRenderer } from './SlackRenderer.ts'

interface MockCall {
  method: string
  args: unknown
}

const markdownBlocksMock = vi.hoisted(() => ({
  markdownToBlocks: vi.fn(),
  splitBlocksWithText: vi.fn(),
}))

vi.mock('markdown-to-slack-blocks', () => markdownBlocksMock)

function stubLogger(overrides: Partial<Logger> = {}): Logger {
  const logger: Logger = {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
    withTag: () => stubLogger(overrides),
    ...overrides,
  }
  return logger
}

function mockWeb(): {
  web: WebClient
  calls: MockCall[]
} {
  const calls: MockCall[] = []
  const web = {
    reactions: {
      add: vi.fn(async (args: unknown) => {
        calls.push({ method: 'reactions.add', args })
        return { ok: true }
      }),
    },
    chat: {
      postMessage: vi.fn(async (args: unknown) => {
        calls.push({ method: 'chat.postMessage', args })
        return { ok: true, ts: 'new-ts' }
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

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(markdownToBlocks).mockImplementation((markdown: string) => [
    {
      type: 'rich_text',
      block_id: `markdown:${markdown}`,
      elements: [],
    } as never,
  ])
  vi.mocked(splitBlocksWithText).mockImplementation((blocks: unknown[]) => [
    {
      text: 'default reply',
      blocks: blocks as never[],
    },
  ])
})

describe('SlackRenderer reactions', () => {
  it('addAck 调 reactions.add 用 eyes', async () => {
    const { web, calls } = mockWeb()
    const renderer = createSlackRenderer({ logger: stubLogger() })

    await renderer.addAck(web, 'C1', 'src-ts')

    expect(calls[0]).toMatchObject({
      method: 'reactions.add',
      args: { channel: 'C1', timestamp: 'src-ts', name: 'eyes' },
    })
  })

  it('addDone / addError / addStopped 使用对应 reaction', async () => {
    const { web, calls } = mockWeb()
    const renderer = createSlackRenderer({ logger: stubLogger() })

    await renderer.addDone(web, 'C1', 'src-ts')
    await renderer.addError(web, 'C1', 'src-ts')
    await renderer.addStopped(web, 'C1', 'src-ts')

    expect(calls.map((call) => (call.args as { name: string }).name)).toEqual([
      'white_check_mark',
      'x',
      'black_square_for_stop',
    ])
  })

  it('safeRender：api 抛错时吞掉并 warn，不向上抛', async () => {
    const warn = vi.fn()
    const web = {
      reactions: {
        add: vi.fn(async () => {
          throw new Error('rate_limited')
        }),
      },
    } as unknown as WebClient
    const renderer = createSlackRenderer({ logger: stubLogger({ warn }) })

    await expect(renderer.addAck(web, 'C1', 'src-ts')).resolves.toBeUndefined()
    expect(warn).toHaveBeenCalled()
  })
})

describe('SlackRenderer assistant status', () => {
  it('setStatus 调 assistant.threads.setStatus（含 loading_messages）', async () => {
    const { web, calls } = mockWeb()
    const renderer = createSlackRenderer({ logger: stubLogger() })

    await renderer.setStatus(web, 'C1', 't1', '思考中…', ['梳理脉络中…'])

    expect(calls[0]?.method).toBe('assistant.threads.setStatus')
    expect(calls[0]?.args).toMatchObject({
      channel_id: 'C1',
      thread_ts: 't1',
      status: '思考中…',
      loading_messages: ['梳理脉络中…'],
    })
  })

  it('setStatus 无 loadingMessages 时不带 loading_messages 字段', async () => {
    const { web, calls } = mockWeb()
    const renderer = createSlackRenderer({ logger: stubLogger() })

    await renderer.setStatus(web, 'C1', 't1', '思考中…')

    expect(calls[0]?.args).not.toHaveProperty('loading_messages')
  })

  it('clearStatus 调 assistant.threads.setStatus 传空 status', async () => {
    const { web, calls } = mockWeb()
    const renderer = createSlackRenderer({ logger: stubLogger() })

    await renderer.clearStatus(web, 'C1', 't1')

    expect(calls[0]?.method).toBe('assistant.threads.setStatus')
    expect(calls[0]?.args).toMatchObject({
      channel_id: 'C1',
      thread_ts: 't1',
      status: '',
    })
  })

  it('setStatus 瞬态错误时 warn + 不抛', async () => {
    const warn = vi.fn()
    const web = {
      assistant: {
        threads: {
          setStatus: vi.fn(async () => {
            const error: Error & { data?: { error?: string } } = new Error('rate_limited')
            error.data = { error: 'rate_limited' }
            throw error
          }),
        },
      },
    } as unknown as WebClient
    const renderer = createSlackRenderer({ logger: stubLogger({ warn }) })

    await expect(renderer.setStatus(web, 'C1', 't1', '思考中…')).resolves.toBeUndefined()
    expect(warn).toHaveBeenCalled()
  })
})

describe('SlackRenderer progress message', () => {
  it('upsertProgressMessage 首次 post，返回 ts', async () => {
    const { web, calls } = mockWeb()
    const renderer = createSlackRenderer({ logger: stubLogger() })

    const ts = await renderer.upsertProgressMessage(web, 'C1', 't1', {
      status: '正在 read_file…',
      activities: ['正在 read_file…'],
      toolHistory: new Map([['read_file', 1]]),
    })

    expect(ts).toBe('new-ts')
    expect(calls[0]).toMatchObject({
      method: 'chat.postMessage',
      args: { channel: 'C1', thread_ts: 't1', text: '正在 read_file…' },
    })
  })

  it('upsertProgressMessage 有 prevTs 时走 chat.update，返回原 ts', async () => {
    const { web, calls } = mockWeb()
    const renderer = createSlackRenderer({ logger: stubLogger() })

    const ts = await renderer.upsertProgressMessage(
      web,
      'C1',
      't1',
      {
        status: '思考中…',
        activities: ['继续思考中…'],
        toolHistory: new Map(),
      },
      'old-ts',
    )

    expect(ts).toBe('old-ts')
    expect(calls[0]).toMatchObject({
      method: 'chat.update',
      args: { channel: 'C1', ts: 'old-ts', text: '思考中…' },
    })
  })

  it('upsertProgressMessage 失败时返回 undefined', async () => {
    const web = {
      chat: {
        postMessage: vi.fn(async () => {
          throw new Error('net down')
        }),
      },
    } as unknown as WebClient
    const renderer = createSlackRenderer({ logger: stubLogger() })

    const ts = await renderer.upsertProgressMessage(web, 'C1', 't1', {
      status: '思考中…',
      activities: [],
      toolHistory: new Map(),
    })

    expect(ts).toBeUndefined()
  })

  it('finalizeProgressMessageDone 带 toolHistory 文案', async () => {
    const { web, calls } = mockWeb()
    const renderer = createSlackRenderer({ logger: stubLogger() })

    await renderer.finalizeProgressMessageDone(
      web,
      'C1',
      't1',
      'p1',
      new Map([
        ['read_file', 2],
        ['bash', 1],
      ]),
    )

    const update = calls.find((call) => call.method === 'chat.update') as
      | { args: { text?: string } }
      | undefined

    expect(update?.args.text).toContain('✅ 完成')
    expect(update?.args.text).toContain('read_file x2')
    expect(update?.args.text).toContain('bash x1')
  })

  it('finalizeProgressMessageStopped 带中止文案', async () => {
    const { web, calls } = mockWeb()
    const renderer = createSlackRenderer({ logger: stubLogger() })

    await renderer.finalizeProgressMessageStopped(web, 'C1', 't1', 'p1')

    const update = calls.find((call) => call.method === 'chat.update') as
      | { args: { text?: string } }
      | undefined

    expect(update?.args.text).toContain('已被用户中止')
  })

  it('finalizeProgressMessageError 带错误文案', async () => {
    const { web, calls } = mockWeb()
    const renderer = createSlackRenderer({ logger: stubLogger() })

    await renderer.finalizeProgressMessageError(web, 'C1', 't1', 'p1', 'boom')

    const update = calls.find((call) => call.method === 'chat.update') as
      | { args: { text?: string } }
      | undefined

    expect(update?.args.text).toContain('⚠️ 出错')
    expect(update?.args.text).toContain('boom')
  })

  it('deleteProgressMessage 调 chat.delete', async () => {
    const { web, calls } = mockWeb()
    const renderer = createSlackRenderer({ logger: stubLogger() })

    await renderer.deleteProgressMessage(web, 'C1', 't1', 'p1')

    expect(calls[0]).toMatchObject({
      method: 'chat.delete',
      args: { channel: 'C1', ts: 'p1' },
    })
  })
})

describe('SlackRenderer postThreadReply', () => {
  it('短 markdown 单次 postMessage', async () => {
    const { web, calls } = mockWeb()
    const renderer = createSlackRenderer({ logger: stubLogger() })
    const renderedBlocks = [
      { type: 'rich_text', block_id: 'single-chunk', elements: [] },
    ] as never[]

    vi.mocked(markdownToBlocks).mockReturnValueOnce(renderedBlocks)
    vi.mocked(splitBlocksWithText).mockReturnValueOnce([
      {
        text: 'hello world',
        blocks: renderedBlocks,
      },
    ])

    await renderer.postThreadReply(web, 'C1', 't1', '**hello** _world_')

    const posts = calls.filter((call) => call.method === 'chat.postMessage')
    expect(posts).toHaveLength(1)
    expect(posts[0]?.args).toMatchObject({
      channel: 'C1',
      thread_ts: 't1',
      text: 'hello world',
      blocks: renderedBlocks,
    })
    expect(markdownToBlocks).toHaveBeenCalledWith('**hello** _world_', {
      preferSectionBlocks: false,
    })
    expect(splitBlocksWithText).toHaveBeenCalledWith(renderedBlocks)
  })

  it('多 chunk reply 会按顺序分两次发送，并分别带对应 text/blocks', async () => {
    const { web, calls } = mockWeb()
    const renderer = createSlackRenderer({ logger: stubLogger() })
    const renderedBlocks = [{ type: 'rich_text', block_id: 'source', elements: [] }] as never[]
    const firstChunkBlocks = [{ type: 'rich_text', block_id: 'chunk-1', elements: [] }] as never[]
    const secondChunkBlocks = [{ type: 'rich_text', block_id: 'chunk-2', elements: [] }] as never[]

    vi.mocked(markdownToBlocks).mockReturnValueOnce(renderedBlocks)
    vi.mocked(splitBlocksWithText).mockReturnValueOnce([
      { text: '第一段', blocks: firstChunkBlocks },
      { text: '第二段', blocks: secondChunkBlocks },
    ])

    await renderer.postThreadReply(web, 'C1', 't1', 'ignored by mock')

    const posts = calls.filter((call) => call.method === 'chat.postMessage')
    expect(posts).toHaveLength(2)
    expect(posts[0]?.args).toMatchObject({
      channel: 'C1',
      thread_ts: 't1',
      text: '第一段',
      blocks: firstChunkBlocks,
    })
    expect(posts[1]?.args).toMatchObject({
      channel: 'C1',
      thread_ts: 't1',
      text: '第二段',
      blocks: secondChunkBlocks,
    })
  })

  it('workspaceLabel 只插入首块，后续 chunk 不重复插入', async () => {
    const { web, calls } = mockWeb()
    const renderer = createSlackRenderer({ logger: stubLogger() })
    const renderedBlocks = [{ type: 'rich_text', block_id: 'source', elements: [] }] as never[]
    const firstChunkBlocks = [{ type: 'rich_text', block_id: 'chunk-a', elements: [] }] as never[]
    const secondChunkBlocks = [{ type: 'rich_text', block_id: 'chunk-b', elements: [] }] as never[]

    vi.mocked(markdownToBlocks).mockReturnValueOnce(renderedBlocks)
    vi.mocked(splitBlocksWithText).mockReturnValueOnce([
      { text: '第一块', blocks: firstChunkBlocks },
      { text: '第二块', blocks: secondChunkBlocks },
    ])

    await renderer.postThreadReply(web, 'C1', 't1', 'ignored by mock', {
      workspaceLabel: 'workspace: demo',
    })

    const posts = calls.filter((call) => call.method === 'chat.postMessage')
    expect(posts).toHaveLength(2)
    expect(posts[0]?.args).toMatchObject({
      channel: 'C1',
      thread_ts: 't1',
      text: '第一块',
      blocks: [
        {
          type: 'context',
          elements: [{ type: 'mrkdwn', text: 'workspace: demo' }],
        },
        ...firstChunkBlocks,
      ],
    })
    expect(posts[1]?.args).toMatchObject({
      channel: 'C1',
      thread_ts: 't1',
      text: '第二块',
      blocks: secondChunkBlocks,
    })
  })

  it('空文本不 postMessage', async () => {
    const { web, calls } = mockWeb()
    const renderer = createSlackRenderer({ logger: stubLogger() })

    await renderer.postThreadReply(web, 'C1', 't1', '   ')

    expect(calls).toHaveLength(0)
  })
})

describe('SlackRenderer postSessionUsage', () => {
  it('完整 usage 行包含 duration/cost/model/cache', async () => {
    const { web, calls } = mockWeb()
    const renderer = createSlackRenderer({ logger: stubLogger() })

    await renderer.postSessionUsage(web, 'C1', 't1', {
      durationMs: 11_200,
      totalCostUSD: 0.0676,
      modelUsage: [
        {
          model: 'claude-sonnet-4-6',
          inputTokens: 1000,
          outputTokens: 200,
          cachedInputTokens: 620,
          cacheHitRate: 0.62,
        },
      ],
    })

    const post = calls.find((call) => call.method === 'chat.postMessage') as
      | { args: { text?: string } }
      | undefined

    expect(post?.args.text).toContain('11.2s')
    expect(post?.args.text).toContain('$0.0676')
    expect(post?.args.text).toContain('claude-sonnet-4-6')
    expect(post?.args.text).toContain('580 non-cached in+out')
    expect(post?.args.text).toContain('62% cache')
  })

  it('totalCostUSD=0 时省略 $ 段', async () => {
    const { web, calls } = mockWeb()
    const renderer = createSlackRenderer({ logger: stubLogger() })

    await renderer.postSessionUsage(web, 'C1', 't1', {
      durationMs: 5_000,
      totalCostUSD: 0,
      modelUsage: [
        {
          model: 'm',
          inputTokens: 100,
          outputTokens: 50,
          cachedInputTokens: 0,
          cacheHitRate: 0,
        },
      ],
    })

    const post = calls.find((call) => call.method === 'chat.postMessage') as
      | { args: { text?: string } }
      | undefined

    expect(post?.args.text).not.toContain('$')
  })

  it('cacheHitRate=0 时省略 cache 段', async () => {
    const { web, calls } = mockWeb()
    const renderer = createSlackRenderer({ logger: stubLogger() })

    await renderer.postSessionUsage(web, 'C1', 't1', {
      durationMs: 1_000,
      totalCostUSD: 0,
      modelUsage: [
        {
          model: 'm',
          inputTokens: 10,
          outputTokens: 10,
          cachedInputTokens: 0,
          cacheHitRate: 0,
        },
      ],
    })

    const post = calls.find((call) => call.method === 'chat.postMessage') as
      | { args: { text?: string } }
      | undefined

    expect(post?.args.text).not.toContain('% cache')
  })
})
