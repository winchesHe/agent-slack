import type { WebClient } from '@slack/web-api'
import type { Logger } from '@/logger/logger.ts'
import type { ConfirmCallback, ConfirmDecision, ConfirmItem, ConfirmLabels } from '@/im/types.ts'

// 向后兼容：从 im/types.ts re-export，保持原有调用方不受影响
export type { ConfirmCallback, ConfirmDecision, ConfirmItem, ConfirmLabels }

// ── SlackConfirm 接口与工厂 ──────────────────────────

export interface SlackConfirm {
  /**
   * 向指定 channel/thread 发送一批待确认条目。
   * 每个条目一条消息，带 accept/reject 按钮。
   * @param namespace 业务命名空间，用于 action_id 路由隔离
   */
  send(opts: {
    web: WebClient
    channelId: string
    threadTs: string
    items: ConfirmItem[]
    namespace: string
    labels?: ConfirmLabels
    onDecision: ConfirmCallback
  }): Promise<void>

  /** 获取指定 namespace 的回调（供 action handler 使用） */
  getCallback(namespace: string): ConfirmCallback | undefined
}

export function createSlackConfirm(deps: { logger: Logger }): SlackConfirm {
  const log = deps.logger.withTag('slack:confirm')
  const callbackRegistry = new Map<string, ConfirmCallback>()

  return {
    async send({ web, channelId, threadTs, items, namespace, labels, onDecision }) {
      callbackRegistry.set(namespace, onDecision)

      for (const item of items) {
        try {
          await web.chat.postMessage({
            channel: channelId,
            thread_ts: threadTs,
            blocks: buildConfirmBlocks(item, namespace, labels),
            text: item.body,
          } as Parameters<WebClient['chat']['postMessage']>[0])
        } catch (err) {
          log.warn('发送确认消息失败', { itemId: item.id, err })
        }
      }
    },

    getCallback(namespace: string) {
      return callbackRegistry.get(namespace)
    },
  }
}

// ── Block Kit 构建（纯函数，可单测） ──────────────────

/** action_id 格式: confirm:<namespace>:<decision>:<itemId> */
export function buildConfirmActionId(
  namespace: string,
  decision: ConfirmDecision,
  itemId: string,
): string {
  return `confirm:${namespace}:${decision}:${itemId}`
}

/** 解析 action_id，返回 { namespace, decision, itemId } 或 undefined */
export function parseConfirmActionId(
  actionId: string,
): { namespace: string; decision: ConfirmDecision; itemId: string } | undefined {
  const match = actionId.match(/^confirm:([^:]+):(accept|reject):(.+)$/)
  if (!match) return undefined
  return {
    namespace: match[1]!,
    decision: match[2] as ConfirmDecision,
    itemId: match[3]!,
  }
}

// 使用 Record<string, unknown> 来表示 Slack Block，与项目中 SlackRenderer.ts 风格一致
export type SlackBlock = Record<string, unknown>

export function buildConfirmBlocks(
  item: ConfirmItem,
  namespace: string,
  labels?: ConfirmLabels,
): SlackBlock[] {
  const acceptLabel = labels?.accept ?? '✅ 采纳'
  const rejectLabel = labels?.reject ?? '❌ 跳过'

  const blocks: SlackBlock[] = [
    {
      type: 'section',
      text: { type: 'mrkdwn', text: item.body },
    },
  ]

  if (item.context) {
    blocks.push({
      type: 'context',
      elements: [{ type: 'mrkdwn', text: item.context }],
    })
  }

  blocks.push({
    type: 'actions',
    block_id: `confirm:${namespace}:${item.id}`,
    elements: [
      {
        type: 'button',
        action_id: buildConfirmActionId(namespace, 'accept', item.id),
        text: { type: 'plain_text', text: acceptLabel },
        style: 'primary',
        value: item.id,
      },
      {
        type: 'button',
        action_id: buildConfirmActionId(namespace, 'reject', item.id),
        text: { type: 'plain_text', text: rejectLabel },
        style: 'danger',
        value: item.id,
      },
    ],
  })

  return blocks
}

/** 构建用户点击后的替换 blocks（移除按钮，显示结果） */
export function buildConfirmResultBlocks(
  originalBlocks: SlackBlock[],
  decision: ConfirmDecision,
): SlackBlock[] {
  const resultText = decision === 'accept' ? '✅ 已采纳' : '❌ 已跳过'
  const result: SlackBlock[] = []

  // 保留 section 和 context，移除 actions
  for (const block of originalBlocks) {
    if (block.type === 'section' || block.type === 'context') {
      result.push(block)
    }
  }

  // 追加结果 context
  result.push({
    type: 'context',
    elements: [{ type: 'mrkdwn', text: resultText }],
  })

  return result
}
