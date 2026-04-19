import { streamText, type LanguageModel, type ToolSet } from 'ai'
import type { AgentExecutor, AgentExecutionRequest } from './AgentExecutor.ts'
import type {
  ActivityState,
  AgentExecutionEvent,
  SessionUsageInfo,
} from '@/core/events.ts'
import { STATUS, TOOL_PHRASE, getShuffledLoadingMessages } from '@/im/slack/thinking-messages.ts'
import type { Logger } from '@/logger/logger.ts'
import { extractCostFromMetadata } from './litellm-cost.ts'

export interface AiSdkExecutorDeps {
  model: LanguageModel
  tools: ToolSet
  maxSteps: number
  logger: Logger
  modelName?: string
}

type LifecycleFinalMessages = Extract<
  Extract<AgentExecutionEvent, { type: 'lifecycle' }>,
  { phase: 'completed' }
>['finalMessages']

interface ModelUsageSnapshot {
  inputTokens: number
  outputTokens: number
  cachedInputTokens: number
  costUSD: number
}

interface AggregatorState {
  turnStartedAt: number
  modelUsage: Map<string, ModelUsageSnapshot>
  defaultLoadingMessages: string[]
  lastEmittedActivityKey?: string

  stepTextBuffer: string
  activeTools: Map<string, { toolName: string; status: 'input' | 'running' }>
  composing: boolean

  currentReasoning: string
  lastReasoningEmitAt: number
  lastReasoningEmitChars: number
}

type ExecutorStreamPart =
  | { type: 'step-start' }
  | { type: 'text-delta'; textDelta: string }
  | { type: 'reasoning'; textDelta: string }
  | { type: 'reasoning-signature' }
  | { type: 'redacted-reasoning' }
  | { type: 'source' }
  | { type: 'file' }
  | { type: 'tool-call-streaming-start'; toolCallId: string; toolName: string }
  | { type: 'tool-call-delta' }
  | { type: 'tool-call'; toolCallId: string; toolName: string }
  | { type: 'tool-result'; toolCallId: string }
  | {
      type: 'step-finish'
      response: { modelId?: string }
      usage: Record<string, unknown>
      providerMetadata: unknown
    }
  | { type: 'finish' }
  | { type: 'error'; error: unknown }

const ERROR_REDACTION_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  // Bearer / token / key 这类敏感片段不应该透传到 Slack 或持久化层。
  [/\b(xox[baprs]-[A-Za-z0-9-]+)\b/g, '[REDACTED]'],
  [/\b(sk-(?:proj-|live-|test-)?[A-Za-z0-9_-]+)\b/g, '[REDACTED]'],
  [/(Bearer\s+)[^\s]+/gi, '$1[REDACTED]'],
  [/((?:api[_ -]?key|token|secret)\s*[:=]\s*)[^\s,;]+/gi, '$1[REDACTED]'],
]

function createAggregator(): AggregatorState {
  return {
    turnStartedAt: Date.now(),
    modelUsage: new Map(),
    defaultLoadingMessages: getShuffledLoadingMessages(8),
    stepTextBuffer: '',
    activeTools: new Map(),
    composing: false,
    currentReasoning: '',
    lastReasoningEmitAt: 0,
    lastReasoningEmitChars: 0,
  }
}

function makeActivityKey(state: ActivityState): string {
  if (state.clear) {
    return JSON.stringify({ clear: true })
  }

  const { newToolCalls: _ignored, ...rest } = state
  return JSON.stringify(rest)
}

function* emitActivity(
  agg: AggregatorState,
  state: ActivityState,
): Generator<AgentExecutionEvent, void, undefined> {
  const nextKey = makeActivityKey(state)

  // key diff 只忽略 newToolCalls；同一状态若带了新工具调用，仍要强制透传给 sink 做次数累加。
  if (nextKey === agg.lastEmittedActivityKey && (!('newToolCalls' in state) || !state.newToolCalls?.length)) {
    return
  }

  agg.lastEmittedActivityKey = nextKey
  yield { type: 'activity-state', state }
}

function clearReasoning(agg: AggregatorState): void {
  agg.currentReasoning = ''
  agg.lastReasoningEmitAt = 0
  agg.lastReasoningEmitChars = 0
}

function normalizeReasoningTail(reasoning: string): string {
  return reasoning.replace(/\s+/g, ' ').trim().slice(-80)
}

function shouldEmitReasoning(agg: AggregatorState): boolean {
  const now = Date.now()
  const charsSinceLastEmit = agg.currentReasoning.length - agg.lastReasoningEmitChars
  return charsSinceLastEmit >= 30 || now - agg.lastReasoningEmitAt >= 800
}

function getActiveToolStatus(agg: AggregatorState): ActivityState | undefined {
  const activeTool = agg.activeTools.values().next().value as
    | { toolName: string; status: 'input' | 'running' }
    | undefined

  if (!activeTool) {
    return undefined
  }

  return {
    status: TOOL_PHRASE.running(activeTool.toolName),
    activities: [TOOL_PHRASE.running(activeTool.toolName), ...agg.defaultLoadingMessages.slice(0, 4)],
  }
}

function updateUsage(
  agg: AggregatorState,
  modelName: string,
  usage: Record<string, unknown>,
  providerMetadata: unknown,
): void {
  const current = agg.modelUsage.get(modelName) ?? {
    inputTokens: 0,
    outputTokens: 0,
    cachedInputTokens: 0,
    costUSD: 0,
  }

  agg.modelUsage.set(modelName, {
    inputTokens: current.inputTokens + Number(usage.promptTokens ?? usage.inputTokens ?? 0),
    outputTokens: current.outputTokens + Number(usage.completionTokens ?? usage.outputTokens ?? 0),
    cachedInputTokens: current.cachedInputTokens + Number(usage.cachedInputTokens ?? 0),
    costUSD: current.costUSD + (extractCostFromMetadata(providerMetadata) ?? 0),
  })
}

function buildUsageInfo(agg: AggregatorState): SessionUsageInfo {
  const modelUsage = Array.from(agg.modelUsage.entries()).map(([model, usage]) => ({
    model,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    cachedInputTokens: usage.cachedInputTokens,
    cacheHitRate: usage.inputTokens > 0 ? usage.cachedInputTokens / usage.inputTokens : 0,
  }))

  return {
    durationMs: Date.now() - agg.turnStartedAt,
    totalCostUSD: Array.from(agg.modelUsage.values()).reduce((sum, usage) => sum + usage.costUSD, 0),
    modelUsage,
  }
}

function isAbortError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false
  }

  return error.name === 'AbortError' || error.message.toLowerCase().includes('abort')
}

function redactErrorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error)
  const normalized = raw.trim() || 'unknown error'

  return ERROR_REDACTION_PATTERNS.reduce(
    (message, [pattern, replacement]) => message.replace(pattern, replacement),
    normalized,
  )
}

async function readStoppedFinalMessages(
  responsePromise: PromiseLike<{ messages: LifecycleFinalMessages }>,
): Promise<LifecycleFinalMessages | undefined> {
  // abort 后 response 可能永远不 settle，这里只做短暂的 best-effort 探测，避免整条执行流挂死。
  return Promise.race([
    Promise.resolve(responsePromise)
      .then((response) => response.messages)
      .catch(() => undefined),
    new Promise<undefined>((resolve) => {
      setTimeout(() => resolve(undefined), 50)
    }),
  ])
}

export function createAiSdkExecutor(deps: AiSdkExecutorDeps): AgentExecutor {
  const log = deps.logger.withTag('agent')

  return {
    async *execute(req: AgentExecutionRequest): AsyncGenerator<AgentExecutionEvent> {
      const agg = createAggregator()

      yield { type: 'lifecycle', phase: 'started' }
      yield* emitActivity(agg, {
        status: STATUS.thinking,
        activities: agg.defaultLoadingMessages,
      })

      let terminatedByErrorPart = false
      let result: ReturnType<typeof streamText> | undefined

      try {
        result = streamText({
          model: deps.model,
          ...(req.systemPrompt ? { system: req.systemPrompt } : {}),
          messages: req.messages,
          tools: deps.tools,
          maxSteps: deps.maxSteps,
          toolCallStreaming: true,
          abortSignal: req.abortSignal,
        })

        for await (const part of result.fullStream as AsyncIterable<ExecutorStreamPart>) {
          switch (part.type) {
            case 'step-start': {
              agg.stepTextBuffer = ''
              agg.composing = false
              break
            }

            case 'text-delta': {
              agg.stepTextBuffer += part.textDelta

              if (agg.currentReasoning) {
                clearReasoning(agg)
              }

              if (!agg.composing) {
                agg.composing = true
                yield* emitActivity(agg, {
                  status: STATUS.composing,
                  activities: [...agg.defaultLoadingMessages, '正在整理回复…'],
                  composing: true,
                })
              }
              break
            }

            case 'reasoning': {
              agg.currentReasoning += part.textDelta

              if (shouldEmitReasoning(agg)) {
                agg.lastReasoningEmitAt = Date.now()
                agg.lastReasoningEmitChars = agg.currentReasoning.length
                yield* emitActivity(agg, {
                  status: STATUS.reasoning,
                  activities: agg.defaultLoadingMessages,
                  reasoningTail: normalizeReasoningTail(agg.currentReasoning),
                })
              }
              break
            }

            case 'reasoning-signature':
            case 'redacted-reasoning':
            case 'source':
            case 'file':
            case 'tool-call-delta': {
              break
            }

            case 'tool-call-streaming-start': {
              clearReasoning(agg)
              agg.activeTools.set(part.toolCallId, { toolName: part.toolName, status: 'input' })

              yield* emitActivity(agg, {
                status: TOOL_PHRASE.running(part.toolName),
                activities: [TOOL_PHRASE.input(part.toolName), ...agg.defaultLoadingMessages.slice(0, 4)],
                newToolCalls: [part.toolName],
              })
              break
            }

            case 'tool-call': {
              clearReasoning(agg)
              const previous = agg.activeTools.get(part.toolCallId)
              agg.activeTools.set(part.toolCallId, { toolName: part.toolName, status: 'running' })
              yield* emitActivity(agg, {
                status: TOOL_PHRASE.running(part.toolName),
                activities: [TOOL_PHRASE.running(part.toolName), ...agg.defaultLoadingMessages.slice(0, 4)],
                // 某些 provider 可能直接给完整 tool-call，不先发 streaming-start。
                // 这里在首次见到该 callId 时补发 newToolCalls，避免 sink 漏记工具次数。
                ...(previous ? {} : { newToolCalls: [part.toolName] }),
              })
              break
            }

            case 'tool-result': {
              agg.activeTools.delete(part.toolCallId)

              const nextToolStatus = getActiveToolStatus(agg)
              if (nextToolStatus) {
                yield* emitActivity(agg, nextToolStatus)
              } else {
                yield* emitActivity(agg, {
                  status: STATUS.thinking,
                  activities: agg.defaultLoadingMessages,
                })
              }
              break
            }

            case 'step-finish': {
              clearReasoning(agg)
              const resolvedModelName =
                part.response.modelId ?? deps.modelName ?? deps.model.modelId ?? 'unknown'

              updateUsage(
                agg,
                resolvedModelName,
                part.usage as unknown as Record<string, unknown>,
                part.providerMetadata,
              )

              // 只用 trim 判断 step 是否为空，真正发给 sink 的文本保持原样，避免吞掉首尾空白。
              const finalStepText = agg.stepTextBuffer
              if (finalStepText.trim()) {
                yield { type: 'assistant-message', text: finalStepText }
              }

              agg.stepTextBuffer = ''
              agg.composing = false
              break
            }

            case 'finish': {
              break
            }

            case 'error': {
              terminatedByErrorPart = true
              // error part 代表 provider 已给出明确终态，这里直接转成 failed 并停止后续消费。
              yield {
                type: 'lifecycle',
                phase: 'failed',
                error: { message: redactErrorMessage(part.error) },
              }
              break
            }
          }

          if (terminatedByErrorPart) {
            break
          }
        }

        if (terminatedByErrorPart) {
          return
        }

        const response = await result.response
        yield { type: 'usage-info', usage: buildUsageInfo(agg) }
        yield {
          type: 'lifecycle',
          phase: 'completed',
          finalMessages: response.messages as LifecycleFinalMessages,
        }
      } catch (err) {
        // abort 是预期的控制流：要先 clear 状态，再把 stopped 交给上层做 finalize。
        if (isAbortError(err)) {
          yield { type: 'activity-state', state: { clear: true } }

          const finalMessages = result
            ? await readStoppedFinalMessages(
                result.response as PromiseLike<{ messages: LifecycleFinalMessages }>,
              )
            : undefined

          yield {
            type: 'lifecycle',
            phase: 'stopped',
            reason: 'user',
            ...(finalMessages && finalMessages.length > 0 ? { finalMessages } : {}),
          }
          return
        }

        // 其余异常视为真正失败，保留日志并压成统一 lifecycle(failed) 事件。
        log.error('executor stream error', err)
        yield {
          type: 'lifecycle',
          phase: 'failed',
          error: { message: redactErrorMessage(err) },
        }
      }
    },
  }
}
