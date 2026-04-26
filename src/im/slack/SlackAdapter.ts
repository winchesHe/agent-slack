import { App } from '@slack/bolt'
import type { WebClient } from '@slack/web-api'
import type { IMAdapter } from '@/im/IMAdapter.ts'
import type { ConversationOrchestrator } from '@/orchestrator/ConversationOrchestrator.ts'
import type { Logger } from '@/logger/logger.ts'
import type { AbortRegistry } from '@/orchestrator/AbortRegistry.ts'
import type { SessionRunQueue } from '@/orchestrator/SessionRunQueue.ts'
import type { ConfirmSender } from '@/im/types.ts'
import type { ConfirmBridge } from '@/im/slack/ConfirmBridge.ts'
import type { SessionStore } from '@/store/SessionStore.ts'
import type { ChannelTasksConfig } from '@/channelTasks/config.ts'
import {
  matchChannelTaskRules,
  type ChannelTaskMatch,
  type SlackChannelTaskMessageEvent,
} from '@/channelTasks/matcher.ts'
import { buildChannelTaskInput } from '@/channelTasks/inputBuilder.ts'
import type {
  ChannelTaskTriggerLedger,
  ChannelTaskTriggerRecord,
} from '@/channelTasks/triggerLedger.ts'
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
  /** ask_confirm 依赖：用于判断超时后按钮点击 fallback */
  confirmBridge?: ConfirmBridge
  /** 用于在点击确认按钮时追加 confirm_action 事件到 session events.jsonl */
  sessionStore: SessionStore
  /** 可选频道任务监听配置；缺失时不注册 message event handler。 */
  channelTasks?: {
    config: ChannelTasksConfig
    ledger: ChannelTaskTriggerLedger
  }
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
  channelName: string
  threadTs: string
  messageTs: string
  messageBlocks: SlackBlock[]
  client: WebClient
  slackConfirm: SlackConfirm
  sessionStore: SessionStore
  logger: Logger
  /** 点击按钮的 Slack user id，用于决策日志审计 */
  userId?: string
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
    log.info('confirm 决策已处理', {
      namespace: parsed.namespace,
      itemId: parsed.itemId,
      decision: parsed.decision,
      userId: ctx.userId,
      channelId: ctx.channelId,
      messageTs: ctx.messageTs,
    })
    await appendConfirmEvent(ctx, parsed, undefined)
  } catch (err) {
    log.error('confirm callback 执行失败', {
      namespace: parsed.namespace,
      itemId: parsed.itemId,
      decision: parsed.decision,
      err,
    })
    await appendConfirmEvent(ctx, parsed, err instanceof Error ? err.message : String(err))
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

/**
 * 把 confirm action 点击作为 ConfirmActionEvent 追加到 session events.jsonl。
 * 失败只 warn，不影响按钮响应（审计数据缺一条 << 用户体验受损）。
 */
async function appendConfirmEvent(
  ctx: ConfirmActionContext,
  parsed: { namespace: string; itemId: string; decision: 'accept' | 'reject' },
  callbackError: string | undefined,
): Promise<void> {
  const log = ctx.logger.withTag('slack:confirm')
  try {
    await ctx.sessionStore.appendEvent(
      {
        channelName: ctx.channelName,
        channelId: ctx.channelId,
        threadTs: ctx.threadTs,
      },
      {
        type: 'confirm_action',
        timestamp: new Date().toISOString(),
        namespace: parsed.namespace,
        itemId: parsed.itemId,
        decision: parsed.decision,
        ...(ctx.userId ? { userId: ctx.userId } : {}),
        channelId: ctx.channelId,
        messageTs: ctx.messageTs,
        ...(callbackError ? { callbackError } : {}),
      },
    )
  } catch (err) {
    log.warn('写入 confirm_action 事件失败', { err })
  }
}

export function createSlackAdapter(deps: SlackAdapterDeps): IMAdapter {
  const log = deps.logger.withTag('slack')
  const channelNameCache = new Map<string, string>()
  const userNameCache = new Map<string, string>()
  let agentUserId: string | undefined

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

      const channelName = await resolveChannelName(client as unknown as WebClient, channelId)

      // 解析 userName（优先 real_name，回落 name，再回落 userId）
      const userId = event.user ?? 'unknown'
      const userName = await resolveUserName(client as unknown as WebClient, userId)

      const sink = createSlackEventSink({
        web: client as unknown as WebClient,
        channelId,
        threadTs,
        sourceMessageTs: messageTs,
        shouldSuppressUsage: () =>
          shouldSuppressUsage({
            client: client as unknown as WebClient,
            channelId,
            logger: log,
            runQueue: deps.runQueue,
            sessionId,
            sourceMessageTs: messageTs,
            threadTs,
            userId,
          }),
        ...(deps.workspaceLabel ? { workspaceLabel: deps.workspaceLabel } : {}),
        renderer: deps.renderer,
        logger: deps.logger,
      })

      const cleanText = (event.text ?? '').replace(/<@[^>]+>/g, '').trim()

      // 构造 IM-agnostic 确认发送器，绑定本次会话的 web/channel/thread。
      // tool 层通过 ToolContext.confirm 调用；不感知 WebClient。
      const confirmSender = createBoundConfirmSender(
        client as unknown as WebClient,
        channelId,
        threadTs,
      )

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
          confirmSender,
        },
        sink,
      )
    } catch (err) {
      log.error('app_mention handler failed', err)
    }
  })

  if (deps.channelTasks) {
    const channelTasks = deps.channelTasks
    app.event('message', async ({ event, client }) => {
      try {
        const messageEvent = toChannelTaskMessageEvent(event)
        if (!messageEvent) return

        const options = await buildChannelTaskMatchOptions(
          channelTasks.config,
          client as unknown as WebClient,
        )
        const matches = matchChannelTaskRules(channelTasks.config, messageEvent, options)
        if (matches.length === 0) return

        const channelName = await resolveChannelName(
          client as unknown as WebClient,
          messageEvent.channel,
        )

        for (const match of matches) {
          await handleChannelTaskMatch({
            match,
            messageEvent,
            client: client as unknown as WebClient,
            channelName,
          })
        }
      } catch (err) {
        log.error('message handler failed', err)
      }
    })
  }

  app.event('reaction_added', async ({ event }) => {
    if (event.reaction !== 'stop_sign') return
    if (event.item.type !== 'message') return
    deps.abortRegistry.abort(event.item.ts, 'user_stop_reaction')
  })

  // 通用 confirm 按钮路由：action_id 前缀 "confirm:"
  app.action(/^confirm:/, async ({ action, ack, client, body, respond }) => {
    await ack()
    const actionId = (action as { action_id?: string }).action_id
    if (!actionId) return

    // body 类型 bolt 层较宽松，运行时从点击事件中取 channel / message / user
    const b = body as {
      channel?: { id?: string }
      message?: { ts?: string; thread_ts?: string; blocks?: SlackBlock[] }
      user?: { id?: string }
    }
    const channelId = b.channel?.id
    const messageTs = b.message?.ts
    const threadTs = b.message?.thread_ts ?? messageTs
    const messageBlocks = b.message?.blocks ?? []
    const userId = b.user?.id
    if (!channelId || !messageTs) {
      log.warn('confirm action 缺少 channel/message 信息', { actionId })
      return
    }
    const effectiveThreadTs = threadTs ?? messageTs
    const channelName = channelNameCache.get(channelId) ?? 'unknown'

    // ask_confirm 超时 fallback：namespace=ask-* 且 bridge 无 pending → ephemeral 提示已过期
    const parsed = parseConfirmActionId(actionId)
    if (
      parsed &&
      parsed.namespace.startsWith('ask-') &&
      deps.confirmBridge &&
      !deps.confirmBridge.hasPending(effectiveThreadTs)
    ) {
      try {
        await respond({
          response_type: 'ephemeral',
          replace_original: false,
          text: '⏱ 此确认已超时，请重新请求',
        })
      } catch (err) {
        log.warn('ask_confirm 超时 ephemeral 提示失败', { err })
      }
      return
    }

    await handleConfirmAction({
      actionId,
      channelId,
      channelName,
      threadTs: effectiveThreadTs,
      messageTs,
      messageBlocks,
      client: client as unknown as WebClient,
      slackConfirm: deps.slackConfirm,
      sessionStore: deps.sessionStore,
      logger: deps.logger,
      ...(userId ? { userId } : {}),
    })
  })

  async function handleChannelTaskMatch(args: {
    match: ChannelTaskMatch
    messageEvent: SlackChannelTaskMessageEvent
    client: WebClient
    channelName: string
  }): Promise<void> {
    if (!deps.channelTasks) return

    const sessionId = `slack:${args.match.channelId}:${args.match.threadTs}`
    const record: ChannelTaskTriggerRecord = {
      schemaVersion: 1,
      ruleId: args.match.rule.id,
      channelId: args.match.channelId,
      messageTs: args.match.messageTs,
      threadTs: args.match.threadTs,
      actorType: args.match.actor.type,
      actorId: args.match.actor.id,
      triggeredAt: new Date().toISOString(),
      sessionId,
    }

    const shouldRun = args.match.rule.dedupe.enabled
      ? await deps.channelTasks.ledger.recordIfNew(record)
      : await appendTriggerWithoutDedupe(deps.channelTasks.ledger, record)

    if (!shouldRun) {
      log.debug('channel task duplicated trigger skipped', {
        ruleId: args.match.rule.id,
        channelId: args.match.channelId,
        messageTs: args.match.messageTs,
      })
      return
    }

    if (deps.runQueue.queueDepth(sessionId) > 0) {
      try {
        await args.client.reactions.add({
          channel: args.match.channelId,
          timestamp: args.match.messageTs,
          name: 'hourglass_flowing_sand',
        })
      } catch (err) {
        log.warn('queued channel task hourglass reaction failed', err)
      }
    }

    const permalink = args.match.rule.task.includePermalink
      ? await resolvePermalink(args.client, args.match.channelId, args.match.messageTs)
      : undefined
    const text = buildChannelTaskInput({
      match: args.match,
      ...(permalink ? { permalink } : {}),
    })
    const userName =
      args.match.actor.type === 'user'
        ? await resolveUserName(args.client, args.match.actor.id)
        : (args.messageEvent.username ?? args.match.actor.id)
    const confirmSender = createBoundConfirmSender(
      args.client,
      args.match.channelId,
      args.match.threadTs,
    )
    const sink = createSlackEventSink({
      web: args.client,
      channelId: args.match.channelId,
      threadTs: args.match.threadTs,
      sourceMessageTs: args.match.messageTs,
      shouldSuppressUsage: () =>
        shouldSuppressUsage({
          client: args.client,
          channelId: args.match.channelId,
          logger: log,
          runQueue: deps.runQueue,
          sessionId,
          sourceMessageTs: args.match.messageTs,
          threadTs: args.match.threadTs,
          userId: args.match.actor.id,
        }),
      ...(deps.workspaceLabel ? { workspaceLabel: deps.workspaceLabel } : {}),
      renderer: deps.renderer,
      logger: deps.logger,
    })

    await deps.orchestrator.handle(
      {
        imProvider: 'slack',
        channelId: args.match.channelId,
        channelName: args.channelName,
        threadTs: args.match.threadTs,
        userId: args.match.actor.id,
        userName,
        text,
        messageTs: args.match.messageTs,
        confirmSender,
      },
      sink,
    )
  }

  async function resolveChannelName(client: WebClient, channelId: string): Promise<string> {
    let channelName: string = channelNameCache.get(channelId) ?? ''
    if (channelName) return channelName

    try {
      const info = await client.conversations.info({ channel: channelId })
      channelName = info.channel?.name ?? 'unknown'
      channelNameCache.set(channelId, channelName)
      return channelName
    } catch (err) {
      log.warn('conversations.info failed, falling back to unknown', err)
      return 'unknown'
    }
  }

  async function resolveUserName(client: WebClient, userId: string): Promise<string> {
    if (userId === 'unknown') return userId

    let userName = userNameCache.get(userId) ?? ''
    if (userName) return userName

    try {
      const uinfo = await client.users.info({ user: userId })
      userName = uinfo.user?.real_name ?? uinfo.user?.name ?? userId
      userNameCache.set(userId, userName)
      return userName
    } catch (err) {
      log.warn('users.info failed, falling back to userId', err)
      return userId
    }
  }

  function createBoundConfirmSender(
    web: WebClient,
    channelId: string,
    threadTs: string,
  ): ConfirmSender {
    return {
      sessionId: threadTs,
      async send({ items, namespace, labels, onDecision }) {
        await deps.slackConfirm.send({
          web,
          channelId,
          threadTs,
          items,
          namespace,
          ...(labels ? { labels } : {}),
          onDecision,
        })
      },
    }
  }

  async function buildChannelTaskMatchOptions(
    config: ChannelTasksConfig | undefined,
    client: WebClient,
  ): Promise<{ agentUserId?: string }> {
    const needsAgentUserId = config?.rules.some(
      (rule) => rule.enabled && rule.message.ignoreAgentMentions,
    )
    if (!needsAgentUserId) return {}

    const resolved = await resolveAgentUserId(client)
    return resolved ? { agentUserId: resolved } : {}
  }

  async function resolveAgentUserId(client: WebClient): Promise<string | undefined> {
    if (agentUserId) return agentUserId
    try {
      const auth = await client.auth.test()
      if (typeof auth.user_id === 'string' && auth.user_id.length > 0) {
        agentUserId = auth.user_id
        return agentUserId
      }
    } catch (err) {
      log.warn('auth.test failed, channel task cannot ignore agent mentions by id', err)
    }
    return undefined
  }

  async function resolvePermalink(
    client: WebClient,
    channelId: string,
    messageTs: string,
  ): Promise<string | undefined> {
    try {
      const result = await client.chat.getPermalink({ channel: channelId, message_ts: messageTs })
      return typeof result.permalink === 'string' ? result.permalink : undefined
    } catch (err) {
      log.warn('chat.getPermalink failed for channel task', err)
      return undefined
    }
  }

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

async function appendTriggerWithoutDedupe(
  ledger: ChannelTaskTriggerLedger,
  record: ChannelTaskTriggerRecord,
): Promise<true> {
  await ledger.append(record)
  return true
}

function toChannelTaskMessageEvent(event: unknown): SlackChannelTaskMessageEvent | undefined {
  if (!isRecord(event)) return undefined
  if (typeof event.channel !== 'string' || typeof event.ts !== 'string') return undefined

  const message: SlackChannelTaskMessageEvent = {
    channel: event.channel,
    ts: event.ts,
  }
  if (typeof event.text === 'string') message.text = event.text
  if (typeof event.user === 'string') message.user = event.user
  if (typeof event.subtype === 'string') message.subtype = event.subtype
  if (typeof event.thread_ts === 'string') message.thread_ts = event.thread_ts
  if (typeof event.bot_id === 'string') message.bot_id = event.bot_id
  if (typeof event.app_id === 'string') message.app_id = event.app_id
  if (typeof event.username === 'string') message.username = event.username
  return message
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

interface ShouldSuppressUsageArgs {
  client: WebClient
  channelId: string
  logger: Logger
  runQueue: SessionRunQueue
  sessionId: string
  sourceMessageTs: string
  threadTs: string
  userId: string
}

async function shouldSuppressUsage(args: ShouldSuppressUsageArgs): Promise<boolean> {
  if (args.runQueue.queueDepth(args.sessionId) > 1) {
    return true
  }

  try {
    const replies = await args.client.conversations.replies({
      channel: args.channelId,
      inclusive: false,
      limit: 10,
      oldest: args.sourceMessageTs,
      ts: args.threadTs,
    } as Parameters<WebClient['conversations']['replies']>[0])

    return Boolean(
      replies.messages?.some((message) => {
        if (message.user !== args.userId || typeof message.ts !== 'string') {
          return false
        }
        return Number(message.ts) > Number(args.sourceMessageTs)
      }),
    )
  } catch (err) {
    args.logger.warn('检查 thread 新消息失败，继续发送 usage', err)
    return false
  }
}
