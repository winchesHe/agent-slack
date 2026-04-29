import {
  streamText,
  type FinishReason,
  type LanguageModel,
  type ProviderMetadata,
  type ToolSet,
} from 'ai'
import type { AgentExecutor, AgentExecutionRequest } from './AgentExecutor.ts'
import type { ActivityState, AgentExecutionEvent, SessionUsageInfo } from '@/core/events.ts'
import { STATUS, TOOL_PHRASE, getShuffledLoadingMessages } from '@/im/slack/thinking-messages.ts'
import type { Logger } from '@/logger/logger.ts'
import { extractCostFromMetadata } from './litellm-cost.ts'

export interface AiSdkExecutorDeps {
  model: LanguageModel
  tools: ToolSet
  maxSteps: number
  logger: Logger
  modelName?: string
  // provider 名称（如 'litellm'），用于构建 providerOptions 请求流式 usage。
  providerName?: string
  // 由 createApplication 装配：当 provider='openai-responses' 时携带
  // { openai: { reasoningEffort, reasoningSummary, store } }。
  // providerOptions 的 key 必须是 'openai' 字面量（@ai-sdk/openai 内部 parseProviderOptions
  // 写死），与 createOpenAI({ name: 'openai-responses' }) 的 name 字段无关。
  extraProviderOptions?: ProviderMetadata
}

type LifecycleFinalMessages = Extract<
  Extract<AgentExecutionEvent, { type: 'lifecycle' }>,
  { phase: 'completed' }
>['finalMessages']

interface ModelUsageSnapshot {
  inputTokens: number
  outputTokens: number
  cachedInputTokens: number
  reasoningTokens: number
  costUSD: number
}

interface AggregatorState {
  turnStartedAt: number
  modelUsage: Map<string, ModelUsageSnapshot>
  defaultLoadingMessages: string[]
  lastEmittedActivityKey?: string

  stepTextBuffer: string
  assistantMessages: string[]
  stepCount: number
  toolCallCounts: Map<string, number>
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
  | { type: 'tool-call'; toolCallId: string; toolName: string; args: Record<string, unknown> }
  | { type: 'tool-result'; toolCallId: string }
  | {
      type: 'step-finish'
      finishReason: FinishReason
      response: { modelId?: string }
      usage: Record<string, unknown>
      providerMetadata: unknown
    }
  | { type: 'finish'; finishReason: FinishReason }
  | { type: 'error'; error: unknown }

const TOOL_LABEL_CMD_MAX_LEN = 40

// 模型经常以 `cd <path> && <real_cmd>` 或 `cd <path>; <real_cmd>` 开头，
// 前缀 cd 会占满截断长度导致看不到真正的命令，这里剥掉它。
const CD_PREFIX_RE = /^cd\s+\S+\s*(?:&&|;)\s*/

// bash 工具的 progress 显示友好名，让用户直观看到正在执行的命令。
// 其他工具保持原名。
function toolDisplayLabel(toolName: string, args?: Record<string, unknown>): string {
  if (toolName === 'bash' && args && typeof args.cmd === 'string') {
    const stripped = args.cmd.replace(CD_PREFIX_RE, '')
    const cmd =
      stripped.length > TOOL_LABEL_CMD_MAX_LEN
        ? `${stripped.slice(0, TOOL_LABEL_CMD_MAX_LEN)}…`
        : stripped

    return `bash(${cmd})`
  }

  return toolName
}

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
    assistantMessages: [],
    stepCount: 0,
    toolCallCounts: new Map(),
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
  if (
    nextKey === agg.lastEmittedActivityKey &&
    (!('newToolCalls' in state) || !state.newToolCalls?.length)
  ) {
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
    activities: [
      TOOL_PHRASE.running(activeTool.toolName),
      ...agg.defaultLoadingMessages.slice(0, 4),
    ],
  }
}

// AI SDK / LiteLLM 有时返回 null 或 NaN 的 token 计数，统一兜底为 0。
function toSafeInt(v: unknown): number {
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}

// 从 finish chunk 的 providerMetadata 中提取 OpenAI Responses API 的 reasoning_tokens。
// 字段路径：providerMetadata.openai.reasoningTokens（@ai-sdk/openai 已 camelCase 映射）。
function extractReasoningTokens(providerMetadata: unknown): number {
  if (!providerMetadata || typeof providerMetadata !== 'object') return 0
  const openai = (providerMetadata as Record<string, unknown>).openai
  if (!openai || typeof openai !== 'object') return 0
  const v = (openai as Record<string, unknown>).reasoningTokens
  return toSafeInt(v)
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
    reasoningTokens: 0,
    costUSD: 0,
  }

  agg.modelUsage.set(modelName, {
    inputTokens: current.inputTokens + toSafeInt(usage.promptTokens ?? usage.inputTokens),
    outputTokens: current.outputTokens + toSafeInt(usage.completionTokens ?? usage.outputTokens),
    cachedInputTokens: current.cachedInputTokens + toSafeInt(usage.cachedInputTokens),
    reasoningTokens: current.reasoningTokens + extractReasoningTokens(providerMetadata),
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
    // 仅 >0 才写入字段；零值时缺省，避免 Slack usage 行误增 (0 thinking) 段。
    ...(usage.reasoningTokens > 0 ? { reasoningTokens: usage.reasoningTokens } : {}),
  }))

  return {
    durationMs: Date.now() - agg.turnStartedAt,
    totalCostUSD: Array.from(agg.modelUsage.values()).reduce(
      (sum, usage) => sum + usage.costUSD,
      0,
    ),
    modelUsage,
  }
}

function formatToolCallSummary(toolCallCounts: Map<string, number>): string {
  const parts = Array.from(toolCallCounts.entries()).map(([name, count]) => `${name} x${count}`)

  return parts.length > 0 ? parts.join(' · ') : '无工具调用记录'
}

function summarizeText(text: string): string {
  const normalized = text.replace(/\s+/g, ' ').trim()

  if (normalized.length <= 160) {
    return normalized
  }

  return `${normalized.slice(0, 157)}…`
}

function buildMaxStepsSummary(agg: AggregatorState, maxSteps: number): string {
  const lines = [
    `⚠️ 已达到 maxSteps 上限（${maxSteps} 步），任务已暂停，未标记为完成。`,
    '',
    '当前已知上下文总结：',
    `- 已执行 ${agg.stepCount} 个模型步骤。`,
    `- 工具调用：${formatToolCallSummary(agg.toolCallCounts)}。`,
  ]

  const latestAssistantMessage = [...agg.assistantMessages].reverse().find((text) => text.trim())
  if (latestAssistantMessage) {
    lines.push(`- 已产出的最后一段回复：${summarizeText(latestAssistantMessage)}。`)
  } else {
    lines.push('- 当前没有可直接交付的最终回复，最后一步仍在请求继续调用工具。')
  }

  lines.push(
    '如需继续，请提高 `config.yaml` 中的 `agent.maxSteps` 后重试，或基于当前线程继续处理。',
  )

  return lines.join('\n')
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
      let terminatedByMaxSteps = false
      let result: ReturnType<typeof streamText> | undefined

      try {
        // providerOptions 用于：
        //  - litellm 路径：注入 stream_options.include_usage（流式响应必须显式开启 usage）
        //  - openai-responses 路径：注入 reasoningEffort / reasoningSummary / store 三字段
        const providerOpts: ProviderMetadata = {
          ...(deps.providerName
            ? { [deps.providerName]: { stream_options: { include_usage: true } } }
            : {}),
          ...(deps.extraProviderOptions ?? {}),
        }
        const hasOpts = Object.keys(providerOpts).length > 0

        result = streamText({
          model: deps.model,
          ...(req.systemPrompt ? { system: req.systemPrompt } : {}),
          messages: req.messages,
          tools: deps.tools,
          maxSteps: deps.maxSteps,
          toolCallStreaming: true,
          abortSignal: req.abortSignal,
          ...(hasOpts ? { providerOptions: providerOpts } : {}),
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
                activities: [
                  TOOL_PHRASE.input(part.toolName),
                  ...agg.defaultLoadingMessages.slice(0, 4),
                ],
                // newToolCalls 延迟到 tool-call 时发出，此时才有完整 args 可构建 display label
              })
              break
            }

            case 'tool-call': {
              clearReasoning(agg)
              agg.activeTools.set(part.toolCallId, { toolName: part.toolName, status: 'running' })
              agg.toolCallCounts.set(
                part.toolName,
                (agg.toolCallCounts.get(part.toolName) ?? 0) + 1,
              )
              const label = toolDisplayLabel(part.toolName, part.args)
              yield* emitActivity(agg, {
                status: TOOL_PHRASE.running(part.toolName),
                activities: [
                  TOOL_PHRASE.running(part.toolName),
                  ...agg.defaultLoadingMessages.slice(0, 4),
                ],
                // 始终携带 newToolCalls，让 sink 能累加工具计数。
                // display label 对 bash 工具会包含具体命令，如 bash(cat config.yaml)。
                newToolCalls: [label],
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
              agg.stepCount += 1
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
                agg.assistantMessages.push(finalStepText)
                yield { type: 'assistant-message', text: finalStepText }
              }

              agg.stepTextBuffer = ''
              agg.composing = false
              break
            }

            case 'finish': {
              // AI SDK v4 在 tool-calls 后若已无剩余 step，会用最后一步的 finishReason 收尾；
              // final finishReason=tool-calls 且 stepCount 达到上限，即代表 maxSteps 被耗尽。
              if (part.finishReason === 'tool-calls' && agg.stepCount >= deps.maxSteps) {
                const summary = buildMaxStepsSummary(agg, deps.maxSteps)
                yield { type: 'assistant-message', text: summary }
                yield { type: 'usage-info', usage: buildUsageInfo(agg) }
                yield {
                  type: 'lifecycle',
                  phase: 'stopped',
                  reason: 'max_steps',
                  summary,
                }
                terminatedByMaxSteps = true
              }
              break
            }

            case 'error': {
              terminatedByErrorPart = true
              // 完整打印 error 详情供排查（redactErrorMessage 仅做敏感词脱敏，丢失结构）
              log.error('[error-part] received error stream chunk', {
                errorType: typeof part.error,
                errorString: String(part.error),
                errorJson: (() => {
                  try {
                    return JSON.stringify(part.error, Object.getOwnPropertyNames(part.error))
                  } catch {
                    return '[unserializable]'
                  }
                })(),
                errorStack: part.error instanceof Error ? part.error.stack : undefined,
              })
              // error part 代表 provider 已给出明确终态，这里直接转成 failed 并停止后续消费。
              yield {
                type: 'lifecycle',
                phase: 'failed',
                error: { message: redactErrorMessage(part.error) },
              }
              break
            }
          }

          if (terminatedByErrorPart || terminatedByMaxSteps) {
            break
          }
        }

        if (terminatedByErrorPart || terminatedByMaxSteps) {
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
        log.error('[catch-error] executor stream error', {
          errorType: typeof err,
          errorString: String(err),
          errorMessage: err instanceof Error ? err.message : undefined,
          errorName: err instanceof Error ? err.name : undefined,
          errorStack: err instanceof Error ? err.stack : undefined,
          errorCause: err instanceof Error ? String((err as { cause?: unknown }).cause) : undefined,
          errorJson: (() => {
            try {
              return JSON.stringify(err, Object.getOwnPropertyNames(err ?? {}))
            } catch {
              return '[unserializable]'
            }
          })(),
        })
        yield {
          type: 'lifecycle',
          phase: 'failed',
          error: { message: redactErrorMessage(err) },
        }
      }
    },
  }
}
