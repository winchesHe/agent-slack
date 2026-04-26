import type { CoreMessage } from 'ai'

export interface ModelMessageBudget {
  maxApproxChars: number
  keepRecentMessages: number
}

export const DEFAULT_MODEL_MESSAGE_BUDGET: ModelMessageBudget = {
  maxApproxChars: 120_000,
  keepRecentMessages: 80,
}

export interface BuildModelMessagesArgs {
  history: CoreMessage[]
  userMessage: CoreMessage
  budget: ModelMessageBudget
  messagesJsonlPath: string
}

export const MODEL_CONTEXT_PRUNED_NOTICE_TITLE = '[历史上下文已按预算裁剪]'

function estimateMessageChars(message: CoreMessage): number {
  return JSON.stringify(message).length
}

function createPrunedNotice(messagesJsonlPath: string): CoreMessage {
  return {
    role: 'user',
    content: `${MODEL_CONTEXT_PRUNED_NOTICE_TITLE}\n本次仅加载最近对话片段；完整会话记录仍保存在：${messagesJsonlPath}`,
  }
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

export function buildModelMessages({
  history,
  userMessage,
  budget,
  messagesJsonlPath,
}: BuildModelMessagesArgs): CoreMessage[] {
  const maxApproxChars = Math.max(1, budget.maxApproxChars)
  const keepRecentMessages = Math.max(1, budget.keepRecentMessages)
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
    return [...history, userMessage]
  }

  const adjustedStart = adjustStartToPreserveToolPairs(history, selectedStart)
  if (adjustedStart === 0) {
    return [...history, userMessage]
  }

  return [createPrunedNotice(messagesJsonlPath), ...history.slice(adjustedStart), userMessage]
}
