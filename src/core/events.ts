import type { StepUsage, TotalUsage } from './usage.ts'

export type AgentExecutionEvent =
  | { type: 'text_delta'; text: string }
  | { type: 'reasoning_delta'; text: string }
  | { type: 'tool_input_delta'; toolCallId: string; toolName: string; partial: string }
  | { type: 'tool_call_start'; toolCallId: string; toolName: string; input: unknown }
  | {
      type: 'tool_call_end'
      toolCallId: string
      toolName: string
      output: unknown
      isError: boolean
    }
  | { type: 'step_start' }
  | { type: 'step_finish'; usage?: StepUsage }
  | { type: 'done'; finalText: string; totalUsage: TotalUsage }
  | { type: 'error'; error: Error }
