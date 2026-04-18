import type { AgentExecutionEvent } from '@/core/events.ts'

export interface InboundMessage {
  imProvider: 'slack'
  channelId: string
  channelName: string
  threadTs: string
  userId: string
  text: string
  messageTs: string
}

export interface EventSink {
  emit(event: AgentExecutionEvent): void
  done(): Promise<void>
  fail(err: Error): Promise<void>
}
