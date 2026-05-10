import { randomUUID } from 'node:crypto'
import type { CoreMessage } from 'ai'
import type { AgentExecutionEvent } from '@/core/events.ts'
import type { Logger } from '@/logger/logger.ts'
import type { Session } from '@/store/SessionStore.ts'
import { formatCompactSummary, type CompactAgent } from '@/agents/compact/index.ts'
import type { CompactAgentOutput } from '@/agents/compact/types.ts'
import { groupMessagesByApiRound } from '@/agents/compact/groupMessagesByApiRound.ts'
import { stripImagesFromMessages } from '@/agents/compact/stripImagesFromMessages.ts'
import {
  compactOldToolResults,
  estimateMessagesChars,
} from '@/orchestrator/modelMessages.ts'

export type ManualCompactTrigger = 'mention_command'
export type AutoCompactTrigger = 'budget'
type CompletedFinalMessages = Extract<
  Extract<AgentExecutionEvent, { type: 'lifecycle' }>,
  { phase: 'completed' }
>['finalMessages']

/**
 * 公共的 compact 成功侧度量数据，供 orchestrator 写 compact_succeeded 事件。
 * 这些字段不会进 jsonl，仅由 ContextCompactor 计算后回传。
 */
export interface CompactSuccessMetrics {
  preCompactApproxChars: number
  postCompactApproxChars: number
  compactionDurationMs: number
  compactionUsage: {
    inputTokens: number
    outputTokens: number
    cachedInputTokens: number
  }
  ptlRetryCount: number
  ptlDroppedMessages: number
}

export type ManualCompactResult =
  | {
      status: 'compacted'
      responseText: string
      finalMessages: CompletedFinalMessages
      metrics: CompactSuccessMetrics
    }
  | {
      status: 'skipped'
      responseText: string
      finalMessages: CompletedFinalMessages
    }

export interface ManualCompactArgs {
  session: Session
  history: CoreMessage[]
  trigger: ManualCompactTrigger
  userId: string
  messagesJsonlPath: string
}

export interface AutoCompactArgs {
  session: Session
  messages: CoreMessage[]
  trigger: AutoCompactTrigger
  messagesJsonlPath: string
}

export type AutoCompactResult =
  | {
      status: 'compacted'
      finalMessages: CompletedFinalMessages
      metrics: CompactSuccessMetrics
    }
  | {
      status: 'skipped'
      reason: string
      finalMessages: CompletedFinalMessages
    }

export interface ContextCompactor {
  manualCompact(args: ManualCompactArgs): Promise<ManualCompactResult>
  autoCompact(args: AutoCompactArgs): Promise<AutoCompactResult>
}

export interface ContextCompactorDeps {
  compactAgent: CompactAgent
  logger: Logger
  /**
   * 与模型视图层同款：超出该数量的旧 tool_result 在 compact 输入中替换为占位文本。
   * 通常注入 `agent.context.keepRecentToolResults`。
   */
  keepRecentToolResults: number
}

const MAX_PTL_RETRIES = 3

function assistantMessage(content: string): CompletedFinalMessages[number] {
  return { id: randomUUID(), role: 'assistant', content }
}

/**
 * compact 入口预处理（参考 free-code services/compact/compact.ts）：
 * 1. tool_result 占位：超出 keepRecentToolResults 的旧结果替换为占位文本（含 jsonl 路径）
 * 2. 媒体剥离：image / file part 替换为 [image] / [document] 占位
 */
function preprocessForCompact(
  messages: CoreMessage[],
  keepRecentToolResults: number,
  messagesJsonlPath: string,
): CoreMessage[] {
  const placeheld = compactOldToolResults(messages, keepRecentToolResults, messagesJsonlPath)
  return stripImagesFromMessages(placeheld)
}

/**
 * 把 compact 调用抛出的错误归类为 events.jsonl 的 reason 字段值。
 * - prompt_too_long：所有 PTL retry 砍头后仍 PTL；不计入熔断
 * - network/api_error：可重试类，计入熔断
 * - no_summary：模型返回空文本；计入熔断
 * - unknown：兜底
 */
export function classifyCompactError(
  error: unknown,
): 'prompt_too_long' | 'network' | 'api_error' | 'no_summary' | 'unknown' {
  if (isPromptTooLongError(error)) return 'prompt_too_long'
  if (!(error instanceof Error)) return 'unknown'
  const name = (error as { name?: string }).name ?? ''
  if (name === 'AI_NoTextGeneratedError' || /no.*summary|empty.*completion/i.test(error.message)) {
    return 'no_summary'
  }
  if (/timeout|fetch.*failed|ECONN|ENOTFOUND|EAI_AGAIN/i.test(error.message)) {
    return 'network'
  }
  if (name === 'AI_APICallError' || name === 'APICallError' || /\b\d{3}\b/.test(error.message)) {
    return 'api_error'
  }
  return 'unknown'
}

export function isPromptTooLongError(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  const name = (error as { name?: string }).name
  if (name === 'PROMPT_TOO_LONG') return true
  if (name === 'AI_APICallError' || name === 'APICallError') {
    const status = (error as { statusCode?: number }).statusCode
    if (status === 413) return true
  }
  return /prompt.+too.+long|context.+window|too.+many.+tokens/i.test(error.message)
}

interface PTLRetryResult {
  output: CompactAgentOutput
  ptlRetryCount: number
  ptlDroppedMessages: number
}

async function summarizeWithPTLRetry(
  compactAgent: CompactAgent,
  messages: CoreMessage[],
  log: Logger,
): Promise<PTLRetryResult> {
  let attempts = 0
  let working = messages
  let totalDropped = 0

  for (;;) {
    try {
      const output = await compactAgent.summarize({ messages: working })
      return { output, ptlRetryCount: attempts, ptlDroppedMessages: totalDropped }
    } catch (error) {
      if (!isPromptTooLongError(error) || attempts >= MAX_PTL_RETRIES) {
        throw error
      }
      const groups = groupMessagesByApiRound(working)
      if (groups.length <= 1) {
        // 不能再砍——抛 PTL 让上层熔断
        throw error
      }
      attempts += 1
      const dropped = groups.shift()!
      totalDropped += dropped.length
      working = groups.flat()
      log.warn('compact PTL retry: dropped oldest API round', {
        attempt: attempts,
        droppedMessages: dropped.length,
        totalDropped,
        remainingMessages: working.length,
      })
    }
  }
}

export function createContextCompactor(deps: ContextCompactorDeps): ContextCompactor {
  const log = deps.logger.withTag('context:compact')

  // 切片版 history 通常只在 head 含 boundary 自身——manualCompact 不该把上一次
  // boundary 再压一次（避免摘要叠摘要），过滤之；严格正则避免假阳性。
  const COMPACT_BOUNDARY_REGEX = /^\[compact: (manual|auto)\]\n/

  return {
    async manualCompact(args) {
      const compactableMessages = args.history.filter(
        (message) =>
          !(
            message.role === 'assistant' &&
            typeof message.content === 'string' &&
            COMPACT_BOUNDARY_REGEX.test(message.content)
          ),
      )

      if (compactableMessages.length < 2) {
        const responseText = '当前线程还没有足够的历史上下文可压缩。'
        return {
          status: 'skipped',
          responseText,
          finalMessages: [assistantMessage(responseText)],
        }
      }

      const preCompactApproxChars = estimateMessagesChars(compactableMessages)
      const startedAt = Date.now()

      const preprocessed = preprocessForCompact(
        compactableMessages,
        deps.keepRecentToolResults,
        args.messagesJsonlPath,
      )

      const { output, ptlRetryCount, ptlDroppedMessages } = await summarizeWithPTLRetry(
        deps.compactAgent,
        preprocessed,
        log,
      )
      const compactMessage = formatCompactSummary({ summary: output.summary })
      const compactionDurationMs = Date.now() - startedAt
      const finalMessages: CompletedFinalMessages = [assistantMessage(compactMessage)]
      const postCompactApproxChars = estimateMessagesChars(
        finalMessages.map((m) => ({ role: m.role, content: m.content })) as CoreMessage[],
      )

      log.info('manual compact completed', {
        historyMessages: args.history.length,
        preprocessedMessages: preprocessed.length,
        preCompactApproxChars,
        postCompactApproxChars,
        compactionDurationMs,
        ptlRetryCount,
        ptlDroppedMessages,
        inputTokens: output.usage.inputTokens,
        outputTokens: output.usage.outputTokens,
        trigger: args.trigger,
        userId: args.userId,
      })

      return {
        status: 'compacted',
        responseText: compactMessage,
        finalMessages,
        metrics: {
          preCompactApproxChars,
          postCompactApproxChars,
          compactionDurationMs,
          compactionUsage: output.usage,
          ptlRetryCount,
          ptlDroppedMessages,
        },
      }
    },

    async autoCompact(args) {
      if (args.messages.length < 2) {
        return {
          status: 'skipped',
          reason: 'not_enough_messages',
          finalMessages: [],
        }
      }

      const preCompactApproxChars = estimateMessagesChars(args.messages)
      const startedAt = Date.now()

      const preprocessed = preprocessForCompact(
        args.messages,
        deps.keepRecentToolResults,
        args.messagesJsonlPath,
      )

      const { output, ptlRetryCount, ptlDroppedMessages } = await summarizeWithPTLRetry(
        deps.compactAgent,
        preprocessed,
        log,
      )
      const compactMessage = formatCompactSummary({ mode: 'auto', summary: output.summary })
      const compactionDurationMs = Date.now() - startedAt
      const finalMessages: CompletedFinalMessages = [assistantMessage(compactMessage)]
      const postCompactApproxChars = estimateMessagesChars(
        finalMessages.map((m) => ({ role: m.role, content: m.content })) as CoreMessage[],
      )

      log.info('auto compact completed', {
        historyMessages: args.messages.length,
        preprocessedMessages: preprocessed.length,
        preCompactApproxChars,
        postCompactApproxChars,
        compactionDurationMs,
        ptlRetryCount,
        ptlDroppedMessages,
        inputTokens: output.usage.inputTokens,
        outputTokens: output.usage.outputTokens,
        trigger: args.trigger,
        sessionId: args.session.id,
      })

      return {
        status: 'compacted',
        finalMessages,
        metrics: {
          preCompactApproxChars,
          postCompactApproxChars,
          compactionDurationMs,
          compactionUsage: output.usage,
          ptlRetryCount,
          ptlDroppedMessages,
        },
      }
    },
  }
}
