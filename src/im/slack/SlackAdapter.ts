import { App } from '@slack/bolt'
import type { WebClient } from '@slack/web-api'
import type { IMAdapter } from '@/im/IMAdapter.ts'
import type { ConversationOrchestrator } from '@/orchestrator/ConversationOrchestrator.ts'
import type { Logger } from '@/logger/logger.ts'
import type { AbortRegistry } from '@/orchestrator/AbortRegistry.ts'
import type { SessionRunQueue } from '@/orchestrator/SessionRunQueue.ts'
import type { SlackRenderer } from './SlackRenderer.ts'
import { createSlackEventSink } from './SlackEventSink.ts'

export interface SlackAdapterDeps {
  orchestrator: ConversationOrchestrator
  abortRegistry: AbortRegistry<string>
  runQueue: SessionRunQueue
  renderer: SlackRenderer
  logger: Logger
  botToken: string
  appToken: string
  signingSecret: string
  workspaceLabel?: string
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
