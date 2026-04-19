import { describe, expectTypeOf, it } from 'vitest'
import type { CoreAssistantMessage, CoreToolMessage } from 'ai'
import type {
  ActivityState,
  AgentExecutionEvent,
  LifecyclePhase,
  SessionUsageInfo,
  StopReason,
} from './events.ts'

describe('events types', () => {
  it('AgentExecutionEvent 能区分 4 类 type', () => {
    const activityEvent: AgentExecutionEvent = {
      type: 'activity-state',
      state: { status: '思考中…', activities: [] },
    }
    const messageEvent: AgentExecutionEvent = {
      type: 'assistant-message',
      text: '测试消息',
    }
    const usageEvent: AgentExecutionEvent = {
      type: 'usage-info',
      usage: { durationMs: 0, totalCostUSD: 0, modelUsage: [] },
    }
    const lifecycleEvent: AgentExecutionEvent = {
      type: 'lifecycle',
      phase: 'completed',
      finalMessages: [],
    }

    expectTypeOf(activityEvent).toMatchTypeOf<AgentExecutionEvent>()
    expectTypeOf(messageEvent).toMatchTypeOf<AgentExecutionEvent>()
    expectTypeOf(usageEvent).toMatchTypeOf<AgentExecutionEvent>()
    expectTypeOf(lifecycleEvent).toMatchTypeOf<AgentExecutionEvent>()
  })

  it('ActivityState 可选字段缺省正常', () => {
    const state: ActivityState = {
      status: '思考中…',
      activities: ['正在组织思路…'],
    }

    expectTypeOf(state).toMatchTypeOf<ActivityState>()
  })

  it('ActivityState 支持 clear-only 事件', () => {
    const state: ActivityState = { clear: true }

    expectTypeOf(state).toMatchTypeOf<ActivityState>()
  })

  it('SessionUsageInfo 必填结构完整', () => {
    const usage: SessionUsageInfo = {
      durationMs: 12,
      totalCostUSD: 0,
      modelUsage: [
        {
          model: 'gpt-test',
          inputTokens: 10,
          outputTokens: 5,
          cachedInputTokens: 0,
          cacheHitRate: 0,
        },
      ],
    }

    expectTypeOf(usage).toMatchTypeOf<SessionUsageInfo>()
  })

  it('LifecyclePhase 与 StopReason 仅允许计划中的字面量', () => {
    expectTypeOf<LifecyclePhase>().toEqualTypeOf<'started' | 'completed' | 'stopped' | 'failed'>()
    expectTypeOf<StopReason>().toEqualTypeOf<'user' | 'superseded' | 'shutdown'>()
  })

  it('lifecycle.finalMessages 对齐 response message 的更窄类型', () => {
    type CompletedEvent = Extract<
      Extract<AgentExecutionEvent, { type: 'lifecycle' }>,
      { phase: 'completed' }
    >

    expectTypeOf<CompletedEvent['finalMessages']>().toEqualTypeOf<
      Array<(CoreAssistantMessage | CoreToolMessage) & { id: string }>
    >()
  })

  it('用类型断言固定 ActivityState 与 lifecycle 的必填约束', () => {
    const completed: AgentExecutionEvent = {
      type: 'lifecycle',
      phase: 'completed',
      finalMessages: [{ id: 'msg_1', role: 'assistant', content: '已完成' }],
    }
    const stopped: AgentExecutionEvent = {
      type: 'lifecycle',
      phase: 'stopped',
      reason: 'user',
    }
    const failed: AgentExecutionEvent = {
      type: 'lifecycle',
      phase: 'failed',
      error: { message: 'boom' },
    }

    expectTypeOf(completed).toMatchTypeOf<AgentExecutionEvent>()
    expectTypeOf(stopped).toMatchTypeOf<AgentExecutionEvent>()
    expectTypeOf(failed).toMatchTypeOf<AgentExecutionEvent>()

    // @ts-expect-error clear-only 之外的状态必须同时带 status 与 activities
    const invalidActivityState: ActivityState = { composing: true }

    // @ts-expect-error completed 必须携带 finalMessages
    const invalidCompleted: AgentExecutionEvent = {
      type: 'lifecycle',
      phase: 'completed',
    }
    // @ts-expect-error stopped 必须携带 reason
    const invalidStopped: AgentExecutionEvent = {
      type: 'lifecycle',
      phase: 'stopped',
    }
    // @ts-expect-error failed 必须携带 error
    const invalidFailed: AgentExecutionEvent = {
      type: 'lifecycle',
      phase: 'failed',
    }
    // @ts-expect-error started 不能携带额外载荷
    ;({ type: 'lifecycle', phase: 'started', reason: 'user' }) satisfies AgentExecutionEvent
    ;({
      type: 'lifecycle',
      phase: 'completed',
      finalMessages: [
        // @ts-expect-error finalMessages 不接受 user message
        { id: 'msg_2', role: 'user', content: '不合法' },
      ],
    }) satisfies AgentExecutionEvent
    ;({
      type: 'lifecycle',
      phase: 'completed',
      finalMessages: [
        // @ts-expect-error finalMessages 中的消息必须带 id
        { role: 'assistant', content: '缺少 id' },
      ],
    }) satisfies AgentExecutionEvent

    expectTypeOf(invalidActivityState).toMatchTypeOf<ActivityState>()
    expectTypeOf(invalidCompleted).toMatchTypeOf<AgentExecutionEvent>()
    expectTypeOf(invalidStopped).toMatchTypeOf<AgentExecutionEvent>()
    expectTypeOf(invalidFailed).toMatchTypeOf<AgentExecutionEvent>()
  })
})
