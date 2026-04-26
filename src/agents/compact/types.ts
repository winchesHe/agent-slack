import type { CoreMessage } from 'ai'

export interface CompactAgentInput {
  messages: CoreMessage[]
}

export interface CompactAgent {
  summarize(input: CompactAgentInput): Promise<string>
}
