import { describe, expect, it } from 'vitest'
import type { WebClient } from '@slack/web-api'
import type { ActivityState, SessionUsageInfo } from '@/core/events.ts'
import type { Logger } from '@/logger/logger.ts'
import { createSlackEventSink } from './SlackEventSink.ts'
import type { SlackRenderer } from './SlackRenderer.ts'

function stubLogger(sink?: { warns: Array<{ message: string; meta: unknown }> }): Logger {
  const logger: Logger = {
    trace: () => {},
    debug: () => {},
    info: () => {},
    warn: (message, meta) => {
      sink?.warns.push({ message, meta })
    },
    error: () => {},
    withTag: () => stubLogger(sink),
  }

  return logger
}

type RecordedCall = {
  method: string
  args: unknown[]
}

function mockRenderer(): SlackRenderer & { calls: RecordedCall[] } {
  const calls: RecordedCall[] = []

  return {
    calls,
    async addAck(...args) {
      calls.push({ method: 'addAck', args })
    },
    async removeAck(...args) {
      calls.push({ method: 'removeAck', args })
    },
    async addDone(...args) {
      calls.push({ method: 'addDone', args })
    },
    async addError(...args) {
      calls.push({ method: 'addError', args })
    },
    async addStopped(...args) {
      calls.push({ method: 'addStopped', args })
    },
    async setStatus(...args) {
      calls.push({ method: 'setStatus', args })
    },
    async clearStatus(...args) {
      calls.push({ method: 'clearStatus', args })
    },
    async upsertProgressMessage(...args) {
      calls.push({ method: 'upsertProgressMessage', args })
      return 'prog-ts'
    },
    async finalizeProgressMessageDone(...args) {
      calls.push({ method: 'finalizeProgressMessageDone', args })
    },
    async finalizeProgressMessageStopped(...args) {
      calls.push({ method: 'finalizeProgressMessageStopped', args })
    },
    async finalizeProgressMessageError(...args) {
      calls.push({ method: 'finalizeProgressMessageError', args })
    },
    async deleteProgressMessage(...args) {
      calls.push({ method: 'deleteProgressMessage', args })
    },
    async postThreadReply(...args) {
      calls.push({ method: 'postThreadReply', args })
    },
    async postSessionUsage(...args) {
      calls.push({ method: 'postSessionUsage', args })
    },
  }
}

const stubWeb = {} as unknown as WebClient

function makeSink(renderer = mockRenderer()) {
  const logs = { warns: [] as Array<{ message: string; meta: unknown }> }

  return {
    sink: createSlackEventSink({
      web: stubWeb,
      channelId: 'C1',
      threadTs: 't1',
      sourceMessageTs: 'src-ts',
      renderer,
      logger: stubLogger(logs),
    }),
    renderer,
    logs,
  }
}

function getMethodCalls(renderer: ReturnType<typeof mockRenderer>, method: string): RecordedCall[] {
  return renderer.calls.filter((call) => call.method === method)
}

describe('SlackEventSink', () => {
  it('lifecycle:started → addAck + setStatus(思考中…)', async () => {
    const { sink, renderer } = makeSink()

    await sink.onEvent({ type: 'lifecycle', phase: 'started' })

    expect(renderer.calls[0]?.method).toBe('addAck')
    expect(renderer.calls[1]?.method).toBe('setStatus')
    expect(renderer.calls[1]?.args[3]).toBe('思考中…')
  })

  it('默认 thinking activity-state 不激活 progress', async () => {
    const { sink, renderer } = makeSink()

    await sink.onEvent({ type: 'lifecycle', phase: 'started' })
    await sink.onEvent({
      type: 'activity-state',
      state: { status: '思考中…', activities: ['a', 'b'] },
    })

    expect(getMethodCalls(renderer, 'upsertProgressMessage')).toHaveLength(0)
    expect(getMethodCalls(renderer, 'setStatus')).toHaveLength(2)
  })

  it('clear=true 会删除已有 progress 并清空状态条', async () => {
    const { sink, renderer } = makeSink()

    await sink.onEvent({ type: 'lifecycle', phase: 'started' })
    await sink.onEvent({
      type: 'activity-state',
      state: {
        status: '正在 read_file…',
        activities: ['正在 read_file…'],
        newToolCalls: ['read_file'],
      },
    })
    await sink.onEvent({ type: 'activity-state', state: { clear: true } })

    expect(getMethodCalls(renderer, 'deleteProgressMessage')).toHaveLength(1)
    expect(getMethodCalls(renderer, 'clearStatus')).toHaveLength(2)
  })

  it('tool activity-state 激活 progress + toolHistory 同名累加 xN', async () => {
    const { sink, renderer } = makeSink()

    await sink.onEvent({ type: 'lifecycle', phase: 'started' })
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

    const upserts = getMethodCalls(renderer, 'upsertProgressMessage')
    expect(upserts).toHaveLength(2)

    const firstProgressState = upserts[0]?.args[3] as { toolHistory: Map<string, number> }
    const secondProgressState = upserts[1]?.args[3] as { toolHistory: Map<string, number> }
    expect(firstProgressState.toolHistory).not.toBe(secondProgressState.toolHistory)
    expect(firstProgressState.toolHistory.get('read_file')).toBe(1)
    expect(secondProgressState.toolHistory.get('read_file')).toBe(2)
  })

  it('不同名 tool 混合 + 同名重复 → toolHistory 精确计数', async () => {
    const { sink, renderer } = makeSink()

    await sink.onEvent({ type: 'lifecycle', phase: 'started' })

    for (const toolName of ['read_file', 'bash', 'read_file', 'read_file']) {
      await sink.onEvent({
        type: 'activity-state',
        state: {
          status: `正在 ${toolName}…`,
          activities: [`正在 ${toolName}…`],
          newToolCalls: [toolName],
        },
      })
    }

    const upserts = getMethodCalls(renderer, 'upsertProgressMessage')
    const lastProgressState = upserts.at(-1)?.args[3] as { toolHistory: Map<string, number> }
    expect(lastProgressState.toolHistory.get('read_file')).toBe(3)
    expect(lastProgressState.toolHistory.get('bash')).toBe(1)
  })

  it('相同 state key + 无 newToolCalls → 跳过 upsert', async () => {
    const { sink, renderer } = makeSink()
    const state: ActivityState = {
      status: '推理中…',
      activities: ['…'],
      reasoningTail: 'tail',
    }

    await sink.onEvent({ type: 'lifecycle', phase: 'started' })
    await sink.onEvent({ type: 'activity-state', state })
    await sink.onEvent({ type: 'activity-state', state })

    expect(getMethodCalls(renderer, 'upsertProgressMessage')).toHaveLength(1)
  })

  it('assistant-message 调 postThreadReply，删除 progress，并清空状态条', async () => {
    const { sink, renderer } = makeSink()

    await sink.onEvent({ type: 'lifecycle', phase: 'started' })
    await sink.onEvent({
      type: 'activity-state',
      state: { status: '正在 x…', activities: [], newToolCalls: ['x'] },
    })
    await sink.onEvent({ type: 'assistant-message', text: 'hello' })

    expect(getMethodCalls(renderer, 'postThreadReply')).toHaveLength(1)
    // 回复后删除旧 progress，避免后续 tool 更新线程中间消息导致布局抖动
    expect(getMethodCalls(renderer, 'deleteProgressMessage')).toHaveLength(1)
    expect(renderer.calls.at(-1)?.method).toBe('clearStatus')
  })

  it('lifecycle:completed → finalize 调 finalizeDone + postSessionUsage + addDone', async () => {
    const { sink, renderer } = makeSink()
    const usage: SessionUsageInfo = {
      durationMs: 1,
      totalCostUSD: 0.01,
      modelUsage: [
        {
          model: 'm',
          inputTokens: 1,
          outputTokens: 1,
          cachedInputTokens: 0,
          cacheHitRate: 0,
        },
      ],
    }

    await sink.onEvent({ type: 'lifecycle', phase: 'started' })
    await sink.onEvent({
      type: 'activity-state',
      state: { status: '正在 x…', activities: [], newToolCalls: ['x'] },
    })
    await sink.onEvent({ type: 'usage-info', usage })
    await sink.onEvent({ type: 'lifecycle', phase: 'completed', finalMessages: [] })
    await sink.finalize()

    const methods = renderer.calls.map((call) => call.method)
    expect(methods).toContain('finalizeProgressMessageDone')
    expect(methods).toContain('postSessionUsage')
    expect(methods).toContain('addDone')
    expect(sink.terminalPhase).toBe('completed')
  })

  it('lifecycle:stopped → finalize 调 finalizeStopped + addStopped（无 usage）', async () => {
    const { sink, renderer } = makeSink()

    await sink.onEvent({ type: 'lifecycle', phase: 'started' })
    await sink.onEvent({
      type: 'activity-state',
      state: { status: '正在 x…', activities: [], newToolCalls: ['x'] },
    })
    await sink.onEvent({ type: 'lifecycle', phase: 'stopped', reason: 'user' })
    await sink.finalize()

    const methods = renderer.calls.map((call) => call.method)
    expect(methods).toContain('finalizeProgressMessageStopped')
    expect(methods).toContain('addStopped')
    expect(methods).not.toContain('postSessionUsage')
  })

  it('lifecycle:stopped reason=max_steps → finalize 传递上限原因并保留 usage', async () => {
    const { sink, renderer } = makeSink()
    const usage: SessionUsageInfo = {
      durationMs: 1,
      totalCostUSD: 0,
      modelUsage: [],
    }

    await sink.onEvent({ type: 'lifecycle', phase: 'started' })
    await sink.onEvent({
      type: 'activity-state',
      state: { status: '正在 x…', activities: [], newToolCalls: ['x'] },
    })
    await sink.onEvent({ type: 'usage-info', usage })
    await sink.onEvent({ type: 'lifecycle', phase: 'stopped', reason: 'max_steps' })
    await sink.finalize()

    const stoppedCalls = getMethodCalls(renderer, 'finalizeProgressMessageStopped')
    expect(stoppedCalls[0]?.args[4]).toBe('max_steps')
    expect(getMethodCalls(renderer, 'postSessionUsage')).toHaveLength(1)
    expect(getMethodCalls(renderer, 'addStopped')).toHaveLength(1)
  })

  it('lifecycle:stopped 且 reason=superseded → finalize 直接删除 progress', async () => {
    const { sink, renderer } = makeSink()

    await sink.onEvent({ type: 'lifecycle', phase: 'started' })
    await sink.onEvent({
      type: 'activity-state',
      state: { status: '正在 x…', activities: [], newToolCalls: ['x'] },
    })
    await sink.onEvent({ type: 'lifecycle', phase: 'stopped', reason: 'superseded' })
    await sink.finalize()

    expect(getMethodCalls(renderer, 'finalizeProgressMessageStopped')).toHaveLength(0)
    expect(getMethodCalls(renderer, 'deleteProgressMessage')).toHaveLength(1)
    expect(getMethodCalls(renderer, 'addStopped')).toHaveLength(1)
  })

  it('lifecycle:failed → finalize 调 finalizeError + addError', async () => {
    const { sink, renderer } = makeSink()

    await sink.onEvent({ type: 'lifecycle', phase: 'started' })
    await sink.onEvent({
      type: 'activity-state',
      state: { status: '正在 x…', activities: [], newToolCalls: ['x'] },
    })
    await sink.onEvent({ type: 'lifecycle', phase: 'failed', error: { message: 'boom' } })
    await sink.finalize()

    const methods = renderer.calls.map((call) => call.method)
    expect(methods).toContain('finalizeProgressMessageError')
    expect(methods).toContain('addError')
  })

  it('finalize 遇到孤儿 progress 时兜底删除并记录告警', async () => {
    const { sink, renderer, logs } = makeSink()

    await sink.onEvent({ type: 'lifecycle', phase: 'started' })
    await sink.onEvent({
      type: 'activity-state',
      state: { status: '正在 x…', activities: [], newToolCalls: ['x'] },
    })
    await sink.finalize()

    expect(getMethodCalls(renderer, 'finalizeProgressMessageDone')).toHaveLength(0)
    expect(getMethodCalls(renderer, 'finalizeProgressMessageStopped')).toHaveLength(0)
    expect(getMethodCalls(renderer, 'finalizeProgressMessageError')).toHaveLength(0)
    expect(getMethodCalls(renderer, 'deleteProgressMessage')).toHaveLength(1)
    expect(logs.warns).toContainEqual({
      message: 'finalize 时存在 progress 但没有 terminalPhase，按兜底删除 progress',
      meta: { progressMessageTs: 'prog-ts' },
    })
  })

  it('terminalPhase first-write-wins', async () => {
    const { sink } = makeSink()

    await sink.onEvent({ type: 'lifecycle', phase: 'started' })
    await sink.onEvent({ type: 'lifecycle', phase: 'completed', finalMessages: [] })
    await sink.onEvent({ type: 'lifecycle', phase: 'failed', error: { message: 'late' } })

    expect(sink.terminalPhase).toBe('completed')
  })
})

describe('SlackEventSink: isMeaningful pin 行为', () => {
  const cases: Array<{
    label: string
    state: ActivityState
    shouldActivateProgress: boolean
  }> = [
    {
      label: '默认 thinking 态 → 不激活',
      state: { status: '思考中…', activities: ['a', 'b'] },
      shouldActivateProgress: false,
    },
    {
      label: 'composing=true 且无其他信号 → 不激活',
      state: { status: '思考中…', activities: ['a'], composing: true },
      shouldActivateProgress: false,
    },
    {
      label: 'status=回复中… → 激活（非默认 thinking）',
      state: { status: '回复中…', activities: ['a'] },
      shouldActivateProgress: true,
    },
    {
      label: 'reasoningTail 存在 → 激活',
      state: {
        status: '推理中…',
        activities: ['a'],
        reasoningTail: 'thinking deeply',
      },
      shouldActivateProgress: true,
    },
    {
      label: 'status 含 tool 文案 → 激活',
      state: {
        status: '正在 read_file…',
        activities: ['正在 read_file…'],
        newToolCalls: ['read_file'],
      },
      shouldActivateProgress: true,
    },
    {
      label: 'thinking 状态 + newToolCalls 非空 → 激活',
      state: { status: '思考中…', activities: ['a'], newToolCalls: ['bash'] },
      shouldActivateProgress: true,
    },
    {
      label: 'clear=true → 不激活（且不走激活路径）',
      state: { clear: true },
      shouldActivateProgress: false,
    },
  ]

  for (const { label, state, shouldActivateProgress } of cases) {
    it(label, async () => {
      const { sink, renderer } = makeSink()

      await sink.onEvent({ type: 'lifecycle', phase: 'started' })

      const beforeUpsertCount = getMethodCalls(renderer, 'upsertProgressMessage').length
      await sink.onEvent({ type: 'activity-state', state })
      const afterUpsertCount = getMethodCalls(renderer, 'upsertProgressMessage').length

      if (shouldActivateProgress) {
        expect(afterUpsertCount).toBeGreaterThan(beforeUpsertCount)
      } else {
        expect(afterUpsertCount).toBe(beforeUpsertCount)
      }
    })
  }
})
