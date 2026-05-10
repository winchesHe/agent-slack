import type { CoreMessage } from 'ai'

/**
 * 把 user message 与 tool_result 中的 image / file block 替换为占位文字。
 * 图片/文档对生成摘要无价值，但容易让 compact 调用炸窗口。
 *
 * 参考 free-code services/compact/compact.ts:stripImagesFromMessages。
 *
 * 覆盖三种位置：
 * 1. user.content 数组里的 ImagePart / FilePart
 * 2. tool.content 里的 ToolResultPart.experimental_content（多模态多 part 形态）
 * 3. tool.content 里的 ToolResultPart.result（运行时偶见数组形态）
 */
export function stripImagesFromMessages(messages: CoreMessage[]): CoreMessage[] {
  return messages.map((msg) => {
    if (msg.role === 'user') return stripUserMessage(msg)
    if (msg.role === 'tool') return stripToolMessage(msg)
    return msg
  })
}

function stripUserMessage(msg: CoreMessage & { role: 'user' }): CoreMessage {
  if (!Array.isArray(msg.content)) return msg
  let changed = false
  const newContent = msg.content.map((part) => {
    if (part.type === 'image') {
      changed = true
      return { type: 'text' as const, text: '[image]' }
    }
    if (part.type === 'file') {
      changed = true
      return { type: 'text' as const, text: '[document]' }
    }
    return part
  })
  return changed ? ({ ...msg, content: newContent } as CoreMessage) : msg
}

function stripToolMessage(msg: CoreMessage & { role: 'tool' }): CoreMessage {
  if (!Array.isArray(msg.content)) return msg
  let changed = false
  const newContent = msg.content.map((part) => {
    if (part.type !== 'tool-result') return part
    let partChanged = false
    let nextPart: Record<string, unknown> = { ...(part as unknown as Record<string, unknown>) }

    if (Array.isArray((part as { experimental_content?: unknown }).experimental_content)) {
      const stripped = stripMultipartArray(
        (part as { experimental_content: unknown[] }).experimental_content,
      )
      if (stripped.changed) {
        partChanged = true
        nextPart.experimental_content = stripped.result
      }
    }

    if (Array.isArray((part as { result: unknown }).result)) {
      const stripped = stripMultipartArray((part as { result: unknown[] }).result)
      if (stripped.changed) {
        partChanged = true
        nextPart.result = stripped.result
      }
    }

    if (partChanged) {
      changed = true
      return nextPart as unknown as typeof part
    }
    return part
  })

  return changed ? ({ ...msg, content: newContent } as CoreMessage) : msg
}

function stripMultipartArray(items: unknown[]): { changed: boolean; result: unknown[] } {
  let changed = false
  const result = items.map((item) => {
    if (typeof item !== 'object' || item === null) return item
    const type = (item as { type?: string }).type
    if (type === 'image') {
      changed = true
      return { type: 'text', text: '[image]' }
    }
    if (type === 'file') {
      changed = true
      return { type: 'text', text: '[document]' }
    }
    return item
  })
  return { changed, result }
}
