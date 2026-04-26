import type { CoreAssistantMessage, CoreToolMessage } from 'ai'

// 生命周期阶段由 executor 发出，供 sink/orchestrator 做终态处理。
export type LifecyclePhase = 'started' | 'completed' | 'stopped' | 'failed'

// stopped 场景的停止原因。
export type StopReason = 'user' | 'superseded' | 'shutdown' | 'max_steps'

interface ActiveActivityState {
  status: string
  activities: string[]
  clear?: false | undefined
  composing?: boolean
  newToolCalls?: string[]
  reasoningTail?: string
}

interface ClearActivityState {
  clear: true
  status?: never
  activities?: never
  composing?: never
  newToolCalls?: never
  reasoningTail?: never
}

// 活动态快照，支持 clear-only 事件，也约束普通状态必须带完整文案。
export type ActivityState = ActiveActivityState | ClearActivityState

export interface SessionUsageInfo {
  durationMs: number
  totalCostUSD: number
  modelUsage: Array<{
    model: string
    inputTokens: number
    outputTokens: number
    cachedInputTokens: number
    cacheHitRate: number
  }>
}

type LifecycleFinalMessage = (CoreAssistantMessage | CoreToolMessage) & {
  id: string
}

type LifecycleEvent =
  | {
      type: 'lifecycle'
      phase: 'started'
    }
  | {
      type: 'lifecycle'
      phase: 'completed'
      finalMessages: LifecycleFinalMessage[]
    }
  | {
      type: 'lifecycle'
      phase: 'stopped'
      reason: StopReason
      finalMessages?: LifecycleFinalMessage[]
      summary?: string
    }
  | {
      type: 'lifecycle'
      phase: 'failed'
      error: { message: string }
    }

export type AgentExecutionEvent =
  | { type: 'activity-state'; state: ActivityState }
  | { type: 'assistant-message'; text: string }
  | { type: 'usage-info'; usage: SessionUsageInfo }
  | LifecycleEvent
