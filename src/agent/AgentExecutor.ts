import type { CoreMessage } from 'ai'
import type { AgentExecutionEvent } from '@/core/events.ts'

export interface AgentExecutionRequest {
  systemPrompt: string
  messages: CoreMessage[]
  abortSignal: AbortSignal
}

export interface AgentExecutor {
  execute(req: AgentExecutionRequest): AsyncGenerator<AgentExecutionEvent>
}
