import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createTelegramEventSink } from './TelegramEventSink.ts'
import type { TelegramApi, TelegramSendMessageOpts } from './TelegramApi.ts'
import type { TelegramRenderer } from './TelegramRenderer.ts'
import type { AgentExecutionEvent } from '@/core/events.ts'

const fakeLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  withTag: () => fakeLogger,
} as never

interface SendCall {
  text: string
  opts: TelegramSendMessageOpts | undefined
}
interface EditCall {
  messageId: number
  text: string
  opts: TelegramSendMessageOpts | undefined
}

function makeMockApi(opts?: {
  sendImpl?: (i: number, opts?: TelegramSendMessageOpts) => 'ok' | 'parse-error' | 'other-error'
  editImpl?: (
    i: number,
    opts?: TelegramSendMessageOpts,
  ) => 'ok' | 'not-modified' | 'parse-error' | 'other-error'
  deleteImpl?: (messageId: number) => 'ok' | 'not-found'
  /** 起始消息分配的 message_id（默认 100）*/
  startMessageId?: number
}): {
  api: TelegramApi
  sends: SendCall[]
  edits: EditCall[]
  deletes: number[]
} {
  const sends: SendCall[] = []
  const edits: EditCall[] = []
  const deletes: number[] = []
  let sendIdx = 0
  let editIdx = 0
  const api = {
    async sendMessage(_chatId: string, text: string, sendOpts?: TelegramSendMessageOpts) {
      const i = sendIdx++
      sends.push({ text, opts: sendOpts })
      const decision = opts?.sendImpl?.(i, sendOpts) ?? 'ok'
      if (decision === 'parse-error') throw new Error("Bad Request: can't parse entities")
      if (decision === 'other-error') throw new Error('Too Many Requests retry_after=5s')
      return { message_id: opts?.startMessageId ?? 100 + i }
    },
    async editMessageText(
      _chatId: string,
      messageId: number,
      text: string,
      editOpts?: TelegramSendMessageOpts,
    ) {
      const i = editIdx++
      edits.push({ messageId, text, opts: editOpts })
      const decision = opts?.editImpl?.(i, editOpts) ?? 'ok'
      if (decision === 'not-modified')
        throw new Error('Bad Request: message is not modified')
      if (decision === 'parse-error') throw new Error("Bad Request: can't parse entities")
      if (decision === 'other-error') throw new Error('Too Many Requests retry_after=5s')
    },
    async deleteMessage(_chatId: string, messageId: number) {
      deletes.push(messageId)
      const decision = opts?.deleteImpl?.(messageId) ?? 'ok'
      if (decision === 'not-found')
        throw new Error('Bad Request: message to delete not found')
    },
    async getMe() {
      return { id: 1, is_bot: true }
    },
  } as unknown as TelegramApi
  return { api, sends, edits, deletes }
}

/** 简易 stub renderer：每次 currentProgressHtml 返回不同字符串以避开 not-modified */
function makeRenderer(args: { progressTexts?: string[]; flushSegments?: string[] } = {}): TelegramRenderer {
  const progressTexts = args.progressTexts ?? ['p0', 'p1', 'p2', 'p3', 'p4']
  let i = 0
  return {
    onEvent() {},
    flush: () => args.flushSegments ?? [],
    currentProgressHtml: () => progressTexts[Math.min(i++, progressTexts.length - 1)] ?? '',
    STARTING_MESSAGE: '⏳ test',
  }
}

describe('TelegramEventSink', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('首次 onEvent 同步 await 发送 progress 容器消息', async () => {
    const { api, sends } = makeMockApi()
    const sink = createTelegramEventSink({
      api,
      renderer: makeRenderer({ progressTexts: ['初始 progress'] }),
      chatId: '1',
      logger: fakeLogger,
    })
    await sink.onEvent({ type: 'activity-state', state: { clear: false } } as AgentExecutionEvent)
    expect(sends).toHaveLength(1)
    expect(sends[0]!.text).toBe('初始 progress')
    expect(sends[0]!.opts?.parse_mode).toBe('HTML')
  })

  it('后续 onEvent 触发 throttled editMessageText', async () => {
    const { api, sends, edits } = makeMockApi()
    const sink = createTelegramEventSink({
      api,
      renderer: makeRenderer({ progressTexts: ['p0', 'p1', 'p2'] }),
      chatId: '1',
      logger: fakeLogger,
    })
    // 首次 → sendMessage
    await sink.onEvent({ type: 'activity-state', state: { clear: false } } as AgentExecutionEvent)
    expect(sends).toHaveLength(1)
    // 第二次（距 send <1100ms）→ schedule timer
    await sink.onEvent({ type: 'activity-state', state: { clear: false } } as AgentExecutionEvent)
    // 还没 fire
    expect(edits).toHaveLength(0)
    // 推进 1100ms → timer fire
    await vi.advanceTimersByTimeAsync(1100)
    expect(edits).toHaveLength(1)
    expect(edits[0]!.text).toBe('p1')
    expect(edits[0]!.opts?.parse_mode).toBe('HTML')
  })

  it('throttle 期间多次 onEvent 只 schedule 一次（合并）', async () => {
    const { api, edits } = makeMockApi()
    const sink = createTelegramEventSink({
      api,
      renderer: makeRenderer({ progressTexts: ['p0', 'p1', 'p2', 'p3'] }),
      chatId: '1',
      logger: fakeLogger,
    })
    await sink.onEvent({ type: 'activity-state', state: { clear: false } } as AgentExecutionEvent)
    // 紧接着 3 次 event，应该只触发 1 次 edit
    await sink.onEvent({ type: 'activity-state', state: { clear: false } } as AgentExecutionEvent)
    await sink.onEvent({ type: 'activity-state', state: { clear: false } } as AgentExecutionEvent)
    await sink.onEvent({ type: 'activity-state', state: { clear: false } } as AgentExecutionEvent)
    await vi.advanceTimersByTimeAsync(1200)
    expect(edits).toHaveLength(1)
  })

  it('"message is not modified" 错误被 swallow', async () => {
    const { api, edits } = makeMockApi({
      editImpl: () => 'not-modified',
    })
    const sink = createTelegramEventSink({
      api,
      renderer: makeRenderer({ progressTexts: ['p0', 'p1'] }),
      chatId: '1',
      logger: fakeLogger,
    })
    await sink.onEvent({ type: 'activity-state', state: { clear: false } } as AgentExecutionEvent)
    await sink.onEvent({ type: 'activity-state', state: { clear: false } } as AgentExecutionEvent)
    await vi.advanceTimersByTimeAsync(1200)
    expect(edits).toHaveLength(1)  // 调用了
    // sink 不抛错（即使 edit 内部抛 not-modified）
  })

  it('progress 容器内容 html 一致 → 跳过编辑（避免 not-modified 噪声）', async () => {
    const { api, edits } = makeMockApi()
    const sink = createTelegramEventSink({
      api,
      renderer: makeRenderer({ progressTexts: ['same', 'same', 'same'] }),  // 永远返回同一字符串
      chatId: '1',
      logger: fakeLogger,
    })
    await sink.onEvent({ type: 'activity-state', state: { clear: false } } as AgentExecutionEvent)
    await sink.onEvent({ type: 'activity-state', state: { clear: false } } as AgentExecutionEvent)
    await vi.advanceTimersByTimeAsync(1200)
    expect(edits).toHaveLength(0)  // 内容相同，不调 editMessageText
  })

  it('finalize 删除 progress 容器后发 final segments', async () => {
    const { api, sends, deletes, edits } = makeMockApi({ startMessageId: 100 })
    const sink = createTelegramEventSink({
      api,
      renderer: makeRenderer({
        progressTexts: ['p0'],
        flushSegments: ['final 1', 'final 2'],
      }),
      chatId: '1',
      logger: fakeLogger,
    })
    await sink.onEvent({ type: 'activity-state', state: { clear: false } } as AgentExecutionEvent)
    const finalizePromise = sink.finalize()
    await vi.runAllTimersAsync()
    await finalizePromise
    // progress 容器被删
    expect(deletes).toEqual([100])
    expect(edits).toHaveLength(0)
    // 2 次 sendMessage（final segments）
    expect(sends.filter((s) => s.text.startsWith('final'))).toHaveLength(2)
  })

  it('finalize 取消 pending throttle timer + 删除容器', async () => {
    const { api, edits, deletes } = makeMockApi({ startMessageId: 100 })
    const sink = createTelegramEventSink({
      api,
      renderer: makeRenderer({ progressTexts: ['p0', 'p1'] }),
      chatId: '1',
      logger: fakeLogger,
    })
    await sink.onEvent({ type: 'activity-state', state: { clear: false } } as AgentExecutionEvent)
    await sink.onEvent({ type: 'activity-state', state: { clear: false } } as AgentExecutionEvent)
    // 此时 pending timer 已 schedule，但还没 fire
    const finalizePromise = sink.finalize()
    await vi.runAllTimersAsync()
    await finalizePromise
    // pending 编辑被取消，progress 直接删
    expect(edits).toHaveLength(0)
    expect(deletes).toEqual([100])
  })

  it('finalize delete 失败 → 降级 edit 为 ✅ 完成', async () => {
    const { api, edits } = makeMockApi({
      startMessageId: 100,
      deleteImpl: () => 'not-found',
    })
    const sink = createTelegramEventSink({
      api,
      renderer: makeRenderer({ progressTexts: ['p0'] }),
      chatId: '1',
      logger: fakeLogger,
    })
    await sink.onEvent({ type: 'activity-state', state: { clear: false } } as AgentExecutionEvent)
    const p = sink.finalize()
    await vi.runAllTimersAsync()
    await p
    expect(edits).toHaveLength(1)
    expect(edits[0]!.text).toBe('✅ 完成')
  })

  it('finalize chunk 之间 sleep 800ms', async () => {
    const { api, sends } = makeMockApi()
    const sink = createTelegramEventSink({
      api,
      renderer: makeRenderer({ flushSegments: ['c1', 'c2'] }),
      chatId: '1',
      logger: fakeLogger,
    })
    // 不调 onEvent → 没有 progress 容器，直接 finalize
    const p = sink.finalize()
    // 第一段先发出去
    await Promise.resolve()
    await Promise.resolve()
    const segs1 = sends.filter((s) => s.text.startsWith('c'))
    expect(segs1.length).toBe(1)
    // 推 799ms 不发第二段
    await vi.advanceTimersByTimeAsync(799)
    expect(sends.filter((s) => s.text.startsWith('c')).length).toBe(1)
    // 再推 1ms 发第二段
    await vi.advanceTimersByTimeAsync(1)
    await p
    expect(sends.filter((s) => s.text.startsWith('c')).length).toBe(2)
  })

  it('final HTML parse 失败 → 同 chunk 降级 plain text', async () => {
    const { api, sends } = makeMockApi({
      sendImpl: (i, opts) => (opts?.parse_mode === 'HTML' && i === 0 ? 'parse-error' : 'ok'),
    })
    const sink = createTelegramEventSink({
      api,
      renderer: makeRenderer({ flushSegments: ['<bad>'] }),
      chatId: '1',
      logger: fakeLogger,
    })
    const p = sink.finalize()
    await vi.runAllTimersAsync()
    await p
    expect(sends).toHaveLength(2)
    expect(sends[0]!.opts?.parse_mode).toBe('HTML')
    expect(sends[1]!.opts).toBeUndefined()
  })
})
