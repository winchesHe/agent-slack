import { App } from '@slack/bolt'
import type { WebClient } from '@slack/web-api'
import type { IMAdapter } from '@/im/IMAdapter.ts'
import type { ConversationOrchestrator } from '@/orchestrator/ConversationOrchestrator.ts'
import type { Logger } from '@/logger/logger.ts'
import type { AbortRegistry } from '@/orchestrator/AbortRegistry.ts'
import type { SessionRunQueue } from '@/orchestrator/SessionRunQueue.ts'
import type { SlackRenderer } from './SlackRenderer.ts'
import { createSlackEventSink } from './SlackEventSink.ts'
import {
  buildConfirmResultBlocks,
  parseConfirmActionId,
  type SlackBlock,
  type SlackConfirm,
} from './SlackConfirm.ts'

export interface SlackAdapterDeps {
  orchestrator: ConversationOrchestrator
  abortRegistry: AbortRegistry<string>
  runQueue: SessionRunQueue
  renderer: SlackRenderer
  slackConfirm: SlackConfirm
  logger: Logger
  botToken: string
  appToken: string
  signingSecret: string
  workspaceLabel?: string
}

// ── Confirm action handler（可单测，不依赖 bolt App） ───────────────────────
export interface ConfirmActionContext {
  actionId: string
  channelId: string
  messageTs: string
  messageBlocks: SlackBlock[]
  client: WebClient
  slackConfirm: SlackConfirm
  logger: Logger
}

/**
 * 处理 confirm:* action 点击：解析 action_id → 调用业务回调 → 用 chat.update 替换为结果 blocks。
 * 从 createSlackAdapter 的闭包里拆出来，方便单测。
 */
export async function handleConfirmAction(ctx: ConfirmActionContext): Promise<void> {
  const log = ctx.logger.withTag('slack:confirm')
  const parsed = parseConfirmActionId(ctx.actionId)
  if (!parsed) {
    log.warn('无法解析 confirm action_id', { actionId: ctx.actionId })
    return
  }

  const callback = ctx.slackConfirm.getCallback(parsed.namespace)
  if (!callback) {
    log.warn('confirm callback 未注册', {
      namespace: parsed.namespace,
      itemId: parsed.itemId,
    })
    return
  }

  try {
    await callback(parsed.itemId, parsed.decision)
  } catch (err) {
    log.error('confirm callback 执行失败', { namespace: parsed.namespace, err })
  }

  const resultBlocks = buildConfirmResultBlocks(ctx.messageBlocks, parsed.decision)
  const resultText = parsed.decision === 'accept' ? '✅ 已采纳' : '❌ 已跳过'

  try {
    await ctx.client.chat.update({
      channel: ctx.channelId,
      ts: ctx.messageTs,
      blocks: resultBlocks,
      text: resultText,
    } as Parameters<WebClient['chat']['update']>[0])
  } catch (err) {
    log.warn('chat.update 替换确认消息失败', { err })
  }
}

export function createSlackAdapter(deps: SlackAdapterDeps): IMAdapter {
  const log = deps.logger.withTag('slack')
  const channelNameCache = new Map<string, string>()
  const userNameCache = new Map<string, string>()

  const app = new App({
    token: deps.botToken,
    appToken: deps.appToken,
    signingSecret: deps.signingSecret,
    socketMode: true,
  })

  app.event('app_mention', async ({ event, client }) => {
    try {
      const channelId = event.channel
      const threadTs = event.thread_ts ?? event.ts
      const messageTs = event.ts
      const sessionId = `slack:${channelId}:${threadTs}`

      let channelName: string = channelNameCache.get(channelId) ?? ''
      if (!channelName) {
        try {
          const info = await client.conversations.info({ channel: channelId })
          channelName = info.channel?.name ?? 'unknown'
          channelNameCache.set(channelId, channelName)
        } catch (err) {
          log.warn('conversations.info failed, falling back to unknown', err)
          channelName = 'unknown'
        }
      }

      // 解析 userName（优先 real_name，回落 name，再回落 userId）
      const userId = event.user ?? 'unknown'
      let userName = userNameCache.get(userId) ?? ''
      if (!userName && userId !== 'unknown') {
        try {
          const uinfo = await client.users.info({ user: userId })
          userName = uinfo.user?.real_name ?? uinfo.user?.name ?? userId
          userNameCache.set(userId, userName)
        } catch (err) {
          log.warn('users.info failed, falling back to userId', err)
          userName = userId
        }
      }
      if (!userName) userName = userId

      const sink = createSlackEventSink({
        web: client as unknown as WebClient,
        channelId,
        threadTs,
        sourceMessageTs: messageTs,
        ...(deps.workspaceLabel ? { workspaceLabel: deps.workspaceLabel } : {}),
        renderer: deps.renderer,
        logger: deps.logger,
      })

      const cleanText = (event.text ?? '').replace(/<@[^>]+>/g, '').trim()

      if (deps.runQueue.queueDepth(sessionId) > 0) {
        try {
          await client.reactions.add({
            channel: channelId,
            timestamp: messageTs,
            name: 'hourglass_flowing_sand',
          })
        } catch (err) {
          log.warn('queued mention hourglass reaction failed', err)
        }
      }

      await deps.orchestrator.handle(
        {
          imProvider: 'slack',
          channelId,
          channelName,
          threadTs,
          userId,
          userName,
          text: cleanText,
          messageTs,
        },
        sink,
      )
    } catch (err) {
      log.error('app_mention handler failed', err)
    }
  })

  app.event('reaction_added', async ({ event }) => {
    if (event.reaction !== 'stop_sign') return
    if (event.item.type !== 'message') return
    deps.abortRegistry.abort(event.item.ts, 'user_stop_reaction')
  })

  // 通用 confirm 按钮路由：action_id 前缀 "confirm:"
  app.action(/^confirm:/, async ({ action, ack, client, body }) => {
    await ack()
    const actionId = (action as { action_id?: string }).action_id
    if (!actionId) return

    // body 类型 bolt 层较宽松，运行时从点击事件中取 channel / message
    const b = body as {
      channel?: { id?: string }
      message?: { ts?: string; blocks?: SlackBlock[] }
    }
    const channelId = b.channel?.id
    const messageTs = b.message?.ts
    const messageBlocks = b.message?.blocks ?? []
    if (!channelId || !messageTs) {
      log.warn('confirm action 缺少 channel/message 信息', { actionId })
      return
    }

    await handleConfirmAction({
      actionId,
      channelId,
      messageTs,
      messageBlocks,
      client: client as unknown as WebClient,
      slackConfirm: deps.slackConfirm,
      logger: deps.logger,
    })
  })

  return {
    id: 'slack',
    async start() {
      await app.start()
      log.info('slack adapter started (socket mode)')
    },
    async stop() {
      await app.stop()
      log.info('slack adapter stopped')
    },
  }
}
