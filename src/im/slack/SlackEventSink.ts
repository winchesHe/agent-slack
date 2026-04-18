import type { WebClient } from '@slack/web-api'
import type { EventSink } from '@/im/types.ts'
import type { AgentExecutionEvent } from '@/core/events.ts'
import type { Logger } from '@/logger/logger.ts'

export interface SlackEventSinkDeps {
  web: WebClient
  channelId: string
  threadTs: string
  placeholderTs: string
  logger: Logger
}

export function createSlackEventSink(deps: SlackEventSinkDeps): EventSink {
  const log = deps.logger.withTag('slack:render')
  let textBuf = ''
  let lastFlush = 0

  const safe = async (fn: () => Promise<unknown>): Promise<void> => {
    try {
      await fn()
    } catch (err) {
      log.warn('slack api failed (swallowed)', err)
    }
  }

  const flushIfNeeded = async (force = false): Promise<void> => {
    const now = Date.now()
    if (!force && now - lastFlush < 1500) return
    lastFlush = now
    await safe(() =>
      deps.web.chat.update({
        channel: deps.channelId,
        ts: deps.placeholderTs,
        text: textBuf || '…',
      }),
    )
  }

  return {
    emit(event: AgentExecutionEvent): void {
      if (event.type === 'text_delta') {
        textBuf += event.text
        void flushIfNeeded()
      } else if (event.type === 'tool_call_start') {
        void safe(() =>
          deps.web.chat.update({
            channel: deps.channelId,
            ts: deps.placeholderTs,
            text: `⚙️ 使用 ${event.toolName}…`,
          }),
        )
      }
    },
    async done() {
      await flushIfNeeded(true)
      await safe(() =>
        deps.web.reactions.add({
          channel: deps.channelId,
          timestamp: deps.placeholderTs,
          name: 'white_check_mark',
        }),
      )
    },
    async fail(err: Error) {
      await safe(() =>
        deps.web.chat.update({
          channel: deps.channelId,
          ts: deps.placeholderTs,
          text: `⚠️ 错误: ${err.message}`,
        }),
      )
      await safe(() =>
        deps.web.reactions.add({
          channel: deps.channelId,
          timestamp: deps.placeholderTs,
          name: 'x',
        }),
      )
    },
  }
}
