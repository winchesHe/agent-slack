import type { CoreMessage } from 'ai'

/**
 * 按 API round 切分：每个 user message 是一组的起点。
 * 这是 PTL retry 砍头的最小单元——保证 tool_use/tool_result 配对完整。
 *
 * 参考 free-code services/compact/grouping.ts；agent-slack 的 message 没有
 * `id` 共享语义（每条 assistant message 独立 id），所以用 user role 作为分组锚。
 */
export function groupMessagesByApiRound(messages: CoreMessage[]): CoreMessage[][] {
  const groups: CoreMessage[][] = []
  let current: CoreMessage[] = []

  for (const msg of messages) {
    if (msg.role === 'user' && current.length > 0) {
      groups.push(current)
      current = [msg]
    } else {
      current.push(msg)
    }
  }
  if (current.length > 0) groups.push(current)
  return groups
}
