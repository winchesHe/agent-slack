import type { CoreMessage } from 'ai'

export interface ModelMessageBudget {
  maxApproxChars: number
  keepRecentMessages: number
  keepRecentToolResults: number
}

export const DEFAULT_MODEL_MESSAGE_BUDGET: ModelMessageBudget = {
  maxApproxChars: 120_000,
  keepRecentMessages: 80,
  keepRecentToolResults: 20,
}

export interface BuildModelMessagesArgs {
  history: CoreMessage[]
  userMessage: CoreMessage
  budget: ModelMessageBudget
  messagesJsonlPath: string
}

export const MODEL_CONTEXT_PRUNED_NOTICE_TITLE = '[历史上下文已按预算裁剪]'
export const TOOL_RESULT_COMPACTED_NOTICE_TITLE = '[旧工具结果已压缩]'

function estimateMessageChars(message: CoreMessage): number {
  return JSON.stringify(message).length
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
  history,
  userMessage,
  budget,
  messagesJsonlPath,
}: BuildModelMessagesArgs): CoreMessage[] {
  const maxApproxChars = Math.max(1, budget.maxApproxChars)
  const keepRecentMessages = Math.max(1, budget.keepRecentMessages)
  const keepRecentToolResults = Math.max(1, budget.keepRecentToolResults)
  let selectedStart = history.length
  let selectedChars = estimateMessageChars(userMessage)
  let selectedMessageCount = 1

  for (let i = history.length - 1; i >= 0; i -= 1) {
    const nextMessage = history[i]!
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
      [...history, userMessage],
      keepRecentToolResults,
      messagesJsonlPath,
    )
  }

  const adjustedStart = adjustStartToPreserveToolPairs(history, selectedStart)
  if (adjustedStart === 0) {
    return compactOldToolResults(
      [...history, userMessage],
      keepRecentToolResults,
      messagesJsonlPath,
    )
  }

  return compactOldToolResults(
    [createPrunedNotice(messagesJsonlPath), ...history.slice(adjustedStart), userMessage],
    keepRecentToolResults,
    messagesJsonlPath,
  )
}
