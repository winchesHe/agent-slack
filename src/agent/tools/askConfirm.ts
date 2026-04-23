import { tool } from 'ai'
import { z } from 'zod'
import type { Logger } from '@/logger/logger.ts'
import {
  ConfirmAbortError,
  ConfirmTimeoutError,
  type ConfirmBridge,
} from '@/im/slack/ConfirmBridge.ts'
import type { ConfirmDecision, ConfirmItem } from '@/im/types.ts'
import type { ToolContext } from './bash.ts'

export interface AskConfirmDeps {
  bridge: ConfirmBridge
  logger: Logger
}

// ask_confirm 单个条目：比 ConfirmItem 多了 description（展示为 context 灰字）
const askConfirmItemSchema = z.object({
  id: z.string().min(1).describe('条目唯一 id，用于回传决定'),
  title: z.string().min(1).describe('条目主标题，显示在卡片上'),
  description: z.string().optional().describe('条目说明，显示为灰色辅助文本'),
})

type AskConfirmItem = z.infer<typeof askConfirmItemSchema>

const DEFAULT_TIMEOUT_MS = 600_000

/**
 * ask_confirm：向用户发送 Slack 按钮请求阻塞式确认。
 * 收到用户全部点击或超时才返回 { decisions }。
 * 仅在 Slack 环境有效（ctx.confirm 存在）；其他环境返回 reason: 'no_confirm_channel'。
 */
export function askConfirmTool(ctx: ToolContext, deps: AskConfirmDeps) {
  return tool({
    description:
      '向用户发送 Slack 按钮请求确认并阻塞等待用户点击，返回每个 item 的 accept/reject 决定。' +
      '当你需要询问用户是否同意或确认某个操作时（例如“是否同意执行开白的操作”）。' +
      'tool 会等用户全部点完或超时才返回，所以在拿到返回值前不要假设用户已同意。' +
      '返回 decisions 里每个条目可能是 accept / reject / timeout。',
    parameters: z.object({
      title: z
        .string()
        .min(1)
        .describe('确认卡片顶部总标题'),
      items: z.array(askConfirmItemSchema).min(1).max(20),
      timeoutMs: z
        .number()
        .int()
        .positive()
        .optional()
        .describe(
          `超时毫秒数，默认 ${DEFAULT_TIMEOUT_MS} (10 分钟)。超时后未点击的条目视为 timeout`,
        ),
    }),
    async execute({ title, items, timeoutMs = DEFAULT_TIMEOUT_MS }, { toolCallId, abortSignal }) {
      if (!ctx.confirm) {
        deps.logger.warn('ask_confirm 被调用但无 IM 确认通道', { itemCount: items.length })
        return {
          reason: 'no_confirm_channel' as const,
          decisions: [],
        }
      }

      const sessionId = ctx.confirm.sessionId

      // 1. 并发检查：同会话已有 pending 就拒绝
      if (deps.bridge.hasPending(sessionId)) {
        deps.logger.warn('ask_confirm 并发冲突，已拒绝', { sessionId, toolCallId })
        return {
          reason: 'concurrent_pending' as const,
          decisions: [],
        }
      }

      const itemIds = items.map((i) => i.id)

      // 2. 发送按钮卡片（namespace 用 ask-<toolCallId> 与 self_improve 隔离；
      // 禁止用冒号分隔，会被 parseConfirmActionId 的正则拆错）
      const namespace = `ask-${toolCallId}`
      await ctx.confirm.send({
        items: items.map(toConfirmItem(title)),
        namespace,
        labels: { accept: '✅ 确认', reject: '❌ 拒绝' },
        onDecision: async (itemId, decision) => {
          deps.bridge.resolveOne({
            toolCallId,
            threadTs: sessionId,
            itemId,
            decision,
          })
        },
      })

      // 3. 阻塞等待所有决定
      let decisions: Map<string, ConfirmDecision>
      let timedOut = false
      let aborted = false
      try {
        decisions = await deps.bridge.awaitAllDecisions({
          toolCallId,
          threadTs: sessionId,
          itemIds,
          timeoutMs,
          ...(abortSignal ? { signal: abortSignal } : {}),
        })
      } catch (err) {
        if (err instanceof ConfirmTimeoutError) {
          timedOut = true
          decisions = err.partialDecisions
        } else if (err instanceof ConfirmAbortError) {
          aborted = true
          decisions = err.partialDecisions
        } else {
          throw err
        }
      }

      // 4. 组装返回
      return {
        decisions: items.map((i) => ({
          id: i.id,
          decision: decisions.get(i.id) ?? ('timeout' as const),
        })),
        ...(timedOut ? { timedOut: true as const } : {}),
        ...(aborted ? { aborted: true as const } : {}),
      }
    },
  })
}

/** 把 AskConfirmItem 映射为 ConfirmItem（按钮卡片消息） */
function toConfirmItem(title: string): (i: AskConfirmItem) => ConfirmItem {
  return (i) => {
    const base: ConfirmItem = {
      id: i.id,
      body: `*${title}*\n\n> ${i.title}`,
    }
    return i.description ? { ...base, context: i.description } : base
  }
}
