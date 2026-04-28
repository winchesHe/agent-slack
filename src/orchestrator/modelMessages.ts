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
  // 900_000 字符 ≈ 300k tokens，对应 400k token 窗口模型；triggerRatio 0.8 时在 ~240k tokens 触发压缩。
  maxApproxChars: 900_000,
  keepRecentMessages: 80,
  keepRecentToolResults: 20,
  autoCompact: {
    enabled: true,
    triggerRatio: 0.8,
    maxFailures: 2,
  },
}

export interface BuildModelMessagesArgs {
  history: CoreMessage[]
  userMessage: CoreMessage
  budget: ModelMessageBudget
  messagesJsonlPath: string
  compactMessageIds?: string[]
}

export const MODEL_CONTEXT_PRUNED_NOTICE_TITLE = '[历史上下文已按预算裁剪]'
export const TOOL_RESULT_COMPACTED_NOTICE_TITLE = '[旧工具结果已压缩]'
export const COMPACT_SUMMARY_PREFIX = '[compact:'

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

function messageId(message: CoreMessage): string | undefined {
  return 'id' in message && typeof message.id === 'string' ? message.id : undefined
}

function isCompactSummaryMessage(message: CoreMessage, compactMessageIds: Set<string>): boolean {
  const id = messageId(message)
  if (id && compactMessageIds.has(id)) {
    return true
  }

  return message.role === 'assistant' && typeof message.content === 'string'
    ? message.content.trimStart().startsWith(COMPACT_SUMMARY_PREFIX)
    : false
}

function splitHistoryAtLastCompact(
  history: CoreMessage[],
  compactMessageIds: Set<string>,
): {
  compactSummary: CoreMessage | undefined
  tailHistory: CoreMessage[]
} {
  for (let i = history.length - 1; i >= 0; i -= 1) {
    const message = history[i]!
    if (isCompactSummaryMessage(message, compactMessageIds)) {
      return {
        compactSummary: message,
        tailHistory: history.slice(i + 1),
      }
    }
  }

  return { compactSummary: undefined, tailHistory: history }
}

export function buildCompactCandidateMessages(input: {
  compactMessageIds?: string[]
  history: CoreMessage[]
  userMessage: CoreMessage
}): CoreMessage[] {
  const { compactSummary, tailHistory } = splitHistoryAtLastCompact(
    input.history,
    new Set(input.compactMessageIds ?? []),
  )
  return [...(compactSummary ? [compactSummary] : []), ...tailHistory, input.userMessage]
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

function compactOldToolResults(
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
  compactMessageIds,
  history,
  userMessage,
  budget,
  messagesJsonlPath,
}: BuildModelMessagesArgs): CoreMessage[] {
  const maxApproxChars = Math.max(1, budget.maxApproxChars)
  const keepRecentMessages = Math.max(1, budget.keepRecentMessages)
  const keepRecentToolResults = Math.max(1, budget.keepRecentToolResults)
  const { compactSummary, tailHistory } = splitHistoryAtLastCompact(
    history,
    new Set(compactMessageIds ?? []),
  )
  let selectedStart = tailHistory.length
  let selectedChars =
    estimateMessageChars(userMessage) + (compactSummary ? estimateMessageChars(compactSummary) : 0)
  let selectedMessageCount = 1 + (compactSummary ? 1 : 0)

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

  const prefixMessages = compactSummary ? [compactSummary] : []

  if (selectedStart === 0) {
    return compactOldToolResults(
      [...prefixMessages, ...tailHistory, userMessage],
      keepRecentToolResults,
      messagesJsonlPath,
    )
  }

  const adjustedStart = adjustStartToPreserveToolPairs(tailHistory, selectedStart)
  if (adjustedStart === 0) {
    return compactOldToolResults(
      [...prefixMessages, ...tailHistory, userMessage],
      keepRecentToolResults,
      messagesJsonlPath,
    )
  }

  return compactOldToolResults(
    [
      ...prefixMessages,
      createPrunedNotice(messagesJsonlPath),
      ...tailHistory.slice(adjustedStart),
      userMessage,
    ],
    keepRecentToolResults,
    messagesJsonlPath,
  )
}
