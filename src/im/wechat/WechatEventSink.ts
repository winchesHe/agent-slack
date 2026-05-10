import type { AgentExecutionEvent } from '@/core/events.ts'
import type { EventSink } from '@/im/types.ts'
import type { Logger } from '@/logger/logger.ts'
import type { WechatApi } from './WechatApi.ts'
import type { WechatRenderer } from './WechatRenderer.ts'

export interface WechatEventSinkDeps {
  api: WechatApi
  renderer: WechatRenderer
  toUserId: string
  contextToken: string
  logger: Logger
}

const SEGMENT_INTER_DELAY_MS = 500

export function createWechatEventSink(deps: WechatEventSinkDeps): EventSink {
  const log = deps.logger.withTag('wechat:sink')
  let startingMessageSent = false
  let terminalPhase: 'completed' | 'stopped' | 'failed' | undefined

  return {
    get terminalPhase() {
      return terminalPhase
    },

    async onEvent(event: AgentExecutionEvent) {
      try {
        // 首个事件触发"开始处理..."一次
        if (!startingMessageSent) {
          startingMessageSent = true
          // 不 await：起始消息失败不应阻塞 orchestrator
          deps.api
            .sendText(deps.toUserId, deps.renderer.STARTING_MESSAGE, deps.contextToken)
            .catch((err) => log.warn('起始消息发送失败', { err }))
        }

        if (event.type === 'lifecycle') {
          if (
            event.phase === 'completed' ||
            event.phase === 'stopped' ||
            event.phase === 'failed'
          ) {
            terminalPhase = event.phase
          }
        }

        deps.renderer.onEvent(event)
      } catch (err) {
        log.error('onEvent 内部异常（不冒泡）', err)
      }
    },

    async finalize() {
      const segments = deps.renderer.flush()
      for (const [i, seg] of segments.entries()) {
        try {
          await deps.api.sendText(deps.toUserId, seg, deps.contextToken)
        } catch (err) {
          log.error('段发送失败', { i, err })
          // 不重试，避免 spam 触发风控
          // 尝试发一条简短的失败提示（也可能失败，再 catch）
          try {
            await deps.api.sendText(deps.toUserId, '[消息发送失败]', deps.contextToken)
          } catch {
            /* 二次失败放弃 */
          }
        }
        if (i < segments.length - 1) await sleep(SEGMENT_INTER_DELAY_MS)
      }
    },
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms))
}
