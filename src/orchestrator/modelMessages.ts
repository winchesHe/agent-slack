import type { CoreMessage } from 'ai'

export interface ModelMessageBudget {
  maxApproxChars: number
  keepRecentMessages: number
  keepRecentToolResults: number
  autoCompact?: {
    enabled: boolean
    triggerRatio: number
    maxFailures: number
  }
}

export const DEFAULT_MODEL_MESSAGE_BUDGET: ModelMessageBudget = {
  // 字符数预算 (JSON.stringify 后)，约 3 字符 ≈ 1 token。
  // 1_000_000 字符 ≈ 250K-330K tokens，覆盖 Sonnet 1M context beta；triggerRatio 0.8 时在 ~800K chars / ~270K tokens 触发压缩。
  maxApproxChars: 1_000_000,
  // 仅作模型视图尾部保留窗口；不参与 autoCompact 触发判定（条数与 token 无稳定换算关系）。
  keepRecentMessages: 80,
  keepRecentToolResults: 20,
  autoCompact: {
    enabled: true,
    triggerRatio: 0.8,
    maxFailures: 2,
  },
}

export interface BuildModelMessagesArgs {
  /**
   * 已经过 SessionStore.loadMessages 切片的历史——若存在 compact boundary，
   * 必为 history[0]（含 boundary 自身）。本函数不再扫描旧 boundary。
   */
  history: CoreMessage[]
  userMessage: CoreMessage
  budget: ModelMessageBudget
  messagesJsonlPath: string
}

export const MODEL_CONTEXT_PRUNED_NOTICE_TITLE = '[历史上下文已按预算裁剪]'
export const TOOL_RESULT_COMPACTED_NOTICE_TITLE = '[旧工具结果已压缩]'

const COMPACT_BOUNDARY_REGEX = /^\[compact: (manual|auto)\]\n/

function estimateMessageChars(message: CoreMessage): number {
  return JSON.stringify(message).length
}

export function estimateMessagesChars(messages: CoreMessage[]): number {
  return messages.reduce((sum, message) => sum + estimateMessageChars(message), 0)
}

function createPrunedNotice(messagesJsonlPath: string): CoreMessage {
  return {
    role: 'user',
    content: `${MODEL_CONTEXT_PRUNED_NOTICE_TITLE}\n本次仅加载最近对话片段；完整会话记录仍保存在：${messagesJsonlPath}`,
  }
}

function createCompactedToolResultNotice(messagesJsonlPath: string): string {
  return `${TOOL_RESULT_COMPACTED_NOTICE_TITLE}；完整内容保存在：${messagesJsonlPath}`
}

function isBoundaryMessage(message: CoreMessage): boolean {
  return (
    message.role === 'assistant' &&
    typeof message.content === 'string' &&
    COMPACT_BOUNDARY_REGEX.test(message.content)
  )
}

function assistantToolCallIds(message: CoreMessage): Set<string> {
  const ids = new Set<string>()
  if (message.role !== 'assistant' || !Array.isArray(message.content)) {
    return ids
  }

  for (const part of message.content) {
    if (part.type === 'tool-call') {
      ids.add(part.toolCallId)
    }
  }
  return ids
}

function toolResultIds(message: CoreMessage): Set<string> {
  const ids = new Set<string>()
  if (message.role !== 'tool' || !Array.isArray(message.content)) {
    return ids
  }

  for (const part of message.content) {
    if (part.type === 'tool-result') {
      ids.add(part.toolCallId)
    }
  }
  return ids
}

function collectToolIds(messages: CoreMessage[]): {
  toolCalls: Set<string>
  toolResults: Set<string>
} {
  const toolCalls = new Set<string>()
  const toolResults = new Set<string>()

  for (const message of messages) {
    for (const id of assistantToolCallIds(message)) {
      toolCalls.add(id)
    }
    for (const id of toolResultIds(message)) {
      toolResults.add(id)
    }
  }

  return { toolCalls, toolResults }
}

function findNearestMissingToolCallIndex(history: CoreMessage[], startIndex: number): number {
  const selected = history.slice(startIndex)
  const { toolCalls, toolResults } = collectToolIds(selected)
  const missingToolCalls = new Set<string>()

  for (const resultId of toolResults) {
    if (!toolCalls.has(resultId)) {
      missingToolCalls.add(resultId)
    }
  }

  if (missingToolCalls.size === 0) {
    return startIndex
  }

  for (let i = startIndex - 1; i >= 0; i -= 1) {
    const callIds = assistantToolCallIds(history[i]!)
    for (const id of callIds) {
      if (missingToolCalls.has(id)) {
        return i
      }
    }
  }

  return startIndex
}

function adjustStartToPreserveToolPairs(history: CoreMessage[], startIndex: number): number {
  let adjustedStart = startIndex

  while (adjustedStart > 0) {
    const nextStart = findNearestMissingToolCallIndex(history, adjustedStart)
    if (nextStart === adjustedStart) {
      return adjustedStart
    }
    adjustedStart = nextStart
  }

  return adjustedStart
}

function toolResultPositionKey(messageIndex: number, partIndex: number): string {
  return `${messageIndex}:${partIndex}`
}

export function compactOldToolResults(
  messages: CoreMessage[],
  keepRecentToolResults: number,
  messagesJsonlPath: string,
): CoreMessage[] {
  const positionsToCompact = new Set<string>()
  let seenToolResults = 0

  for (let messageIndex = messages.length - 1; messageIndex >= 0; messageIndex -= 1) {
    const message = messages[messageIndex]!
    if (message.role !== 'tool' || !Array.isArray(message.content)) {
      continue
    }

    for (let partIndex = message.content.length - 1; partIndex >= 0; partIndex -= 1) {
      const part = message.content[partIndex]!
      if (part.type !== 'tool-result') {
        continue
      }
      seenToolResults += 1
      if (seenToolResults > keepRecentToolResults) {
        positionsToCompact.add(toolResultPositionKey(messageIndex, partIndex))
      }
    }
  }

  if (positionsToCompact.size === 0) {
    return messages
  }

  const compactedNotice = createCompactedToolResultNotice(messagesJsonlPath)
  return messages.map((message, messageIndex) => {
    if (message.role !== 'tool' || !Array.isArray(message.content)) {
      return message
    }

    let changed = false
    const content = message.content.map((part, partIndex) => {
      if (
        part.type === 'tool-result' &&
        positionsToCompact.has(toolResultPositionKey(messageIndex, partIndex))
      ) {
        changed = true
        return { ...part, result: compactedNotice }
      }
      return part
    })

    return changed ? { ...message, content } : message
  })
}

export function buildModelMessages({
  history,
  userMessage,
  budget,
  messagesJsonlPath,
}: BuildModelMessagesArgs): CoreMessage[] {
  const maxApproxChars = Math.max(1, budget.maxApproxChars)
  const keepRecentMessages = Math.max(1, budget.keepRecentMessages)
  const keepRecentToolResults = Math.max(1, budget.keepRecentToolResults)

  // history 来自 SessionStore.loadMessages 切片版：若存在 boundary，必为 history[0]。
  // boundary pin 住，预算裁剪只作用于 boundary 之后的 tail。
  const hasBoundary = history.length > 0 && isBoundaryMessage(history[0]!)
  const boundaryPrefix = hasBoundary ? [history[0]!] : []
  const tailHistory = hasBoundary ? history.slice(1) : history

  let selectedStart = tailHistory.length
  let selectedChars =
    estimateMessageChars(userMessage) +
    (hasBoundary ? estimateMessageChars(history[0]!) : 0)
  let selectedMessageCount = 1 + (hasBoundary ? 1 : 0)

  for (let i = tailHistory.length - 1; i >= 0; i -= 1) {
    const nextMessage = tailHistory[i]!
    const nextChars = selectedChars + estimateMessageChars(nextMessage)
    const nextMessageCount = selectedMessageCount + 1
    if (nextChars > maxApproxChars || nextMessageCount > keepRecentMessages) {
      break
    }

    selectedStart = i
    selectedChars = nextChars
    selectedMessageCount = nextMessageCount
  }

  if (selectedStart === 0) {
    return compactOldToolResults(
      [...boundaryPrefix, ...tailHistory, userMessage],
      keepRecentToolResults,
      messagesJsonlPath,
    )
  }

  const adjustedStart = adjustStartToPreserveToolPairs(tailHistory, selectedStart)
  if (adjustedStart === 0) {
    return compactOldToolResults(
      [...boundaryPrefix, ...tailHistory, userMessage],
      keepRecentToolResults,
      messagesJsonlPath,
    )
  }

  return compactOldToolResults(
    [
      ...boundaryPrefix,
      createPrunedNotice(messagesJsonlPath),
      ...tailHistory.slice(adjustedStart),
      userMessage,
    ],
    keepRecentToolResults,
    messagesJsonlPath,
  )
}
