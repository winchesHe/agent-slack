import type { CoreMessage } from 'ai'

export const COMPACT_SYSTEM_PROMPT = `你是 agent-slack 的上下文压缩助手。
请把输入的历史对话压缩成一份短摘要，供后续 agent 接续上下文。

要求：
- 只保留用户目标、关键决策、未完成事项、重要命令结果和错误。
- 忽略寒暄、握手测试、原样回复、无后续价值的中间回复。
- 保留工具调用带来的事实结论，不要编造未出现的信息。
- 若历史包含失败或中断，说明失败点和已知上下文。
- 不输出本地绝对路径、session/jsonl 路径、完整记录路径。
- 输出 Markdown；不要输出 JSON；不要调用工具；不超过 8 条要点。`

const COMPACT_SUMMARY_MAX_CHARS = 1_200

function serializeMessages(messages: CoreMessage[]): string {
  return messages.map((message) => JSON.stringify(message)).join('\n')
}

export function buildCompactPrompt(input: { messages: CoreMessage[] }): string {
  // 不预截输入：超长时由 ContextCompactor 的 PTL retry 按 API round 砍头处理。
  const visibleTranscript = serializeMessages(input.messages)

  return `请压缩下面这段 agent-slack session 历史。

## 历史消息 JSONL
${visibleTranscript}
`
}

export function formatCompactSummary(input: { mode?: 'auto' | 'manual'; summary: string }): string {
  const summary = compactSummaryText(input.summary)
  return `[compact: ${input.mode ?? 'manual'}]
${summary}`
}

function compactSummaryText(summary: string): string {
  const withoutPathLines = summary
    .split('\n')
    .filter((line) => !isPathNoiseLine(line) && !isLowValueNoiseLine(line))
    .join('\n')
    .trim()

  if (withoutPathLines.length <= COMPACT_SUMMARY_MAX_CHARS) {
    return withoutPathLines || '当前历史中没有需要保留的有效上下文。'
  }

  return `${withoutPathLines.slice(0, COMPACT_SUMMARY_MAX_CHARS).trimEnd()}\n…`
}

function isPathNoiseLine(line: string): boolean {
  return (
    line.includes('messages.jsonl') ||
    line.includes('.agent-slack/sessions') ||
    line.includes('完整会话记录') ||
    line.includes('JSONL 记录路径') ||
    line.includes('/Users/')
  )
}

function isLowValueNoiseLine(line: string): boolean {
  return (
    line.includes('COMPACT_COMMAND_') ||
    line.includes('Reply exactly:') ||
    line.includes('Do not use tools.') ||
    line.includes('已进入 compact 模式')
  )
}
