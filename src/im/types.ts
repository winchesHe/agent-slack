import type { AgentExecutionEvent } from '@/core/events.ts'

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
}

export interface EventSink {
  emit(event: AgentExecutionEvent): void
  done(): Promise<void>
  fail(err: Error): Promise<void>
}
