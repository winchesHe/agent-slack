import { App } from '@slack/bolt'
import type { WebClient } from '@slack/web-api'
import type { IMAdapter } from '@/im/IMAdapter.ts'
import type { ConversationOrchestrator } from '@/orchestrator/ConversationOrchestrator.ts'
import type { Logger } from '@/logger/logger.ts'
import { createSlackEventSink } from './SlackEventSink.ts'

export interface SlackAdapterDeps {
  orchestrator: ConversationOrchestrator
  logger: Logger
  botToken: string
  appToken: string
  signingSecret: string
}

export function createSlackAdapter(deps: SlackAdapterDeps): IMAdapter {
  const log = deps.logger.withTag('slack')
  const channelNameCache = new Map<string, string>()

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

      await swallow(
        client.reactions.add({ channel: channelId, timestamp: messageTs, name: 'eyes' }),
        log,
      )
      const placeholder = await client.chat.postMessage({
        channel: channelId,
        thread_ts: threadTs,
        text: '⏳ thinking…',
      })
      if (!placeholder.ts) throw new Error('placeholder ts missing')

      const sink = createSlackEventSink({
        web: client as unknown as WebClient,
        channelId,
        threadTs,
        placeholderTs: placeholder.ts,
        logger: deps.logger,
      })

      const cleanText = (event.text ?? '').replace(/<@[^>]+>/g, '').trim()

      await deps.orchestrator.handle(
        {
          imProvider: 'slack',
          channelId,
          channelName,
          threadTs,
          userId: event.user ?? 'unknown',
          text: cleanText,
          messageTs,
        },
        sink,
      )
    } catch (err) {
      log.error('app_mention handler failed', err)
    }
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

async function swallow(p: Promise<unknown>, log: Logger): Promise<void> {
  try {
    await p
  } catch (err) {
    log.warn('slack api failed (swallowed)', err)
  }
}
