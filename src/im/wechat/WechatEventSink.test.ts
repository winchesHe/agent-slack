import { describe, it, expect, vi } from 'vitest'
import { createWechatEventSink } from './WechatEventSink.ts'
import { createWechatRenderer } from './WechatRenderer.ts'
import type { AgentExecutionEvent } from '@/core/events.ts'
import type { Logger } from '@/logger/logger.ts'
import type { WechatApi } from './WechatApi.ts'

const stubLogger = (): Logger => {
  const make = (): Logger => ({
    trace: () => {},
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
    withTag: () => make(),
  })
  return make()
}

interface StubApi {
  sendText: ReturnType<typeof vi.fn>
}

const stubApi = (): StubApi & WechatApi => {
  const sendText = vi.fn().mockResolvedValue(undefined)
  return { sendText, baseUrl: '', cdnBaseUrl: '' } as never
}

describe('WechatEventSink', () => {
  it('首个事件触发"开始处理..."消息（不阻塞 onEvent 返回）', async () => {
    const api = stubApi()
    const renderer = createWechatRenderer({ logger: stubLogger() })
    const sink = createWechatEventSink({
      api,
      renderer,
      toUserId: 'uA',
      contextToken: 'ctx',
      logger: stubLogger(),
    })
    await sink.onEvent({ type: 'assistant-message', text: 'hi' } as AgentExecutionEvent)
    // 等微任务清空
    await new Promise((r) => setTimeout(r, 10))
    expect(api.sendText).toHaveBeenCalledWith('uA', '开始处理...', 'ctx')
  })

  it('finalize 串行发所有 segment；段间 500ms sleep', async () => {
    const api = stubApi()
    const renderer = createWechatRenderer({ logger: stubLogger() })
    // 灌入：1 个工具 + 1 段 assistant text → flush() 返回 2 个 segment
    renderer.onEvent({
      type: 'activity-state',
      state: { status: 's', activities: [], newToolCalls: ['bash'] },
    } as AgentExecutionEvent)
    renderer.onEvent({ type: 'assistant-message', text: '完成' } as AgentExecutionEvent)
    renderer.onEvent({
      type: 'lifecycle',
      phase: 'completed',
      finalMessages: [],
    } as AgentExecutionEvent)

    const sink = createWechatEventSink({
      api,
      renderer,
      toUserId: 'uA',
      contextToken: 'ctx',
      logger: stubLogger(),
    })
    const t0 = Date.now()
    await sink.finalize()
    const elapsed = Date.now() - t0

    // sendText 被调用：2 个 segment（finalize 不发起始消息）
    expect(api.sendText.mock.calls.length).toBe(2)
    expect(api.sendText.mock.calls[0]).toEqual(['uA', '🔧 使用了工具: bash', 'ctx'])
    expect(api.sendText.mock.calls[1]).toEqual(['uA', '完成', 'ctx'])
    // 段间 sleep ~500ms（允许时序抖动）
    expect(elapsed).toBeGreaterThanOrEqual(450)
    expect(elapsed).toBeLessThan(2_000)
  })

  it('段内发送失败 → log + 尝试发"[消息发送失败]"（不抛、不停发后续段）', async () => {
    const api = {
      sendText: vi
        .fn()
        .mockRejectedValueOnce(new Error('limit')) // 第 1 段失败
        .mockResolvedValueOnce(undefined) // [消息发送失败] 提示成功
        .mockResolvedValueOnce(undefined), // 第 2 段成功
    } as never
    const renderer = createWechatRenderer({ logger: stubLogger() })
    renderer.onEvent({ type: 'assistant-message', text: 'A'.repeat(5000) } as AgentExecutionEvent)
    renderer.onEvent({
      type: 'lifecycle',
      phase: 'completed',
      finalMessages: [],
    } as AgentExecutionEvent)

    const sink = createWechatEventSink({
      api,
      renderer,
      toUserId: 'uA',
      contextToken: 'ctx',
      logger: stubLogger(),
    })
    await sink.finalize()
    // 至少 3 次调用：失败段 + 失败提示 + 后续段
    expect((api as unknown as { sendText: { mock: { calls: unknown[] } } }).sendText.mock.calls.length).toBeGreaterThanOrEqual(3)
  })

  it('terminalPhase 在 lifecycle 终态后可读', async () => {
    const renderer = createWechatRenderer({ logger: stubLogger() })
    const sink = createWechatEventSink({
      api: stubApi(),
      renderer,
      toUserId: 'uA',
      contextToken: 'ctx',
      logger: stubLogger(),
    })
    expect(sink.terminalPhase).toBeUndefined()
    await sink.onEvent({
      type: 'lifecycle',
      phase: 'completed',
      finalMessages: [],
    } as AgentExecutionEvent)
    expect(sink.terminalPhase).toBe('completed')
  })
})
