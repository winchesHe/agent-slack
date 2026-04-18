import { streamText, type LanguageModel, type ToolSet } from 'ai'
import type { AgentExecutor, AgentExecutionRequest } from './AgentExecutor.ts'
import type { AgentExecutionEvent } from '@/core/events.ts'
import { emptyTotalUsage, type StepUsage, type TotalUsage } from '@/core/usage.ts'
import type { Logger } from '@/logger/logger.ts'

export interface AiSdkExecutorDeps {
  model: LanguageModel
  tools: ToolSet
  maxSteps: number
  logger: Logger
  modelName?: string
}

export function createAiSdkExecutor(deps: AiSdkExecutorDeps): AgentExecutor {
  const log = deps.logger.withTag('agent')
  return {
    async *execute(req: AgentExecutionRequest): AsyncGenerator<AgentExecutionEvent> {
      const startedAt = Date.now()
      const total: TotalUsage = emptyTotalUsage(deps.modelName ?? 'unknown')

      const result = streamText({
        model: deps.model,
        ...(req.systemPrompt ? { system: req.systemPrompt } : {}),
        messages: req.messages,
        tools: deps.tools,
        maxSteps: deps.maxSteps,
        abortSignal: req.abortSignal,
      })

      try {
        for await (const part of result.fullStream) {
          const mapped = mapPart(part, total)
          if (mapped) yield mapped
        }
        const finalText = await result.text
        total.durationMs = Date.now() - startedAt
        yield { type: 'done', finalText, totalUsage: total }
      } catch (err) {
        log.error('executor stream error', err)
        yield { type: 'error', error: err instanceof Error ? err : new Error(String(err)) }
      }
    },
  }
}

function mapPart(part: unknown, total: TotalUsage): AgentExecutionEvent | null {
  const p = part as { type: string; [k: string]: unknown }
  switch (p.type) {
    case 'text-delta':
      return { type: 'text_delta', text: String(p.textDelta ?? p.text ?? '') }
    case 'reasoning':
      return { type: 'reasoning_delta', text: String(p.textDelta ?? p.text ?? '') }
    case 'tool-call-streaming-start':
    case 'tool-call-delta':
      return {
        type: 'tool_input_delta',
        toolCallId: String(p.toolCallId ?? ''),
        toolName: String(p.toolName ?? ''),
        partial: String(p.argsTextDelta ?? p.partial ?? ''),
      }
    case 'tool-call':
      return {
        type: 'tool_call_start',
        toolCallId: String(p.toolCallId ?? ''),
        toolName: String(p.toolName ?? ''),
        input: p.args ?? p.input,
      }
    case 'tool-result':
      return {
        type: 'tool_call_end',
        toolCallId: String(p.toolCallId ?? ''),
        toolName: String(p.toolName ?? ''),
        output: p.result ?? p.output,
        isError: Boolean(p.isError),
      }
    case 'step-start':
      return { type: 'step_start' }
    case 'step-finish': {
      const usage = (p.usage ?? {}) as Record<string, number | undefined>
      const meta = (p.providerMetadata ?? {}) as { litellm?: { cost?: number } }
      const step: StepUsage = {
        inputTokens: usage.promptTokens ?? usage.inputTokens ?? 0,
        outputTokens: usage.completionTokens ?? usage.outputTokens ?? 0,
        ...(usage.cachedInputTokens !== undefined
          ? { cachedInputTokens: usage.cachedInputTokens }
          : {}),
        ...(usage.reasoningTokens !== undefined ? { reasoningTokens: usage.reasoningTokens } : {}),
        ...(meta.litellm?.cost !== undefined ? { costUSD: meta.litellm.cost } : {}),
      }
      total.inputTokens += step.inputTokens
      total.outputTokens += step.outputTokens
      total.cachedInputTokens += step.cachedInputTokens ?? 0
      total.totalCostUSD = (total.totalCostUSD ?? 0) + (step.costUSD ?? 0)
      if (total.inputTokens > 0) total.cacheHitRate = total.cachedInputTokens / total.inputTokens
      return { type: 'step_finish', usage: step }
    }
    case 'finish':
      return null
    case 'error':
      return { type: 'error', error: new Error(String((p as { error?: unknown }).error)) }
    default:
      return null
  }
}
