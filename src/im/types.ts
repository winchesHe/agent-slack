import type { AgentExecutionEvent } from '@/core/events.ts'

// ── 通用确认交互（IM-agnostic） ────────────────────────
// ConfirmSender 由 IM Adapter 实现并在每次 handle 时注入 ToolContext。
// tool 层不直接接触 WebClient / Slack Block Kit。

/** 一个待确认条目（业务无关） */
export interface ConfirmItem {
  /** 唯一 ID，用于 action_id 路由 */
  id: string
  /** 消息正文（mrkdwn） */
  body: string
  /** 可选上下文说明（证据、来源等） */
  context?: string
}

/** 按钮文案，可由调用方自定义 */
export interface ConfirmLabels {
  accept?: string
  reject?: string
}

/** 用户点击后的决策 */
export type ConfirmDecision = 'accept' | 'reject'

/** 用户点击后的业务回调 */
export type ConfirmCallback = (itemId: string, decision: ConfirmDecision) => Promise<void>

/**
 * IM-agnostic 确认消息发送器。
 * 由 IM Adapter 在每次 handle 时构造并绑定当前会话上下文（channel/thread/web client），
 * 经 InboundMessage 透传到 Orchestrator，再经 ToolsBuilder 写入 ToolContext。
 */
export interface ConfirmSender {
  /**
   * 当前会话的不透明 id（由 IM Adapter 决定其含义，Slack 下取 threadTs）。
   * ConfirmBridge 用它作 per-session 单 pending 的 key；tool 层不应解析其内容。
   */
  readonly sessionId: string

  send(opts: {
    items: ConfirmItem[]
    namespace: string
    labels?: ConfirmLabels
    onDecision: ConfirmCallback
  }): Promise<void>
}

export interface InboundMessage {
  imProvider: 'slack'
  channelId: string
  channelName: string
  threadTs: string
  userId: string
  /** 用户显示名（Slack real_name / name）；用于 memory filename 可读前缀 */
  userName: string
  text: string
  messageTs: string
  /** 由 IM Adapter 绑定当前会话上下文构造的确认发送器；tool 层按需调用 */
  confirmSender?: ConfirmSender
}

export interface EventSink {
  onEvent(event: AgentExecutionEvent): Promise<void>
  finalize(): Promise<void>
  readonly terminalPhase: 'completed' | 'stopped' | 'failed' | undefined
}
