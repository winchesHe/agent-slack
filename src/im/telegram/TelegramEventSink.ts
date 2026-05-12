// Telegram EventSink：实现"progress 容器 + 节流编辑 + final 分段发送"模式。
//
// 流程（mimic Slack 的 progress block 体验）：
//   1. 首次 onEvent → sendMessage 发 progress 容器消息，保存 message_id
//   2. 后续 onEvent → renderer 累积状态，节流（≥1100ms）调 editMessageText 更新同一条消息
//   3. finalize → 取消 pending edit + 末次 edit 把最终 progress 状态固化
//   4. finalize → 把 renderer.flush() 的 final result 用 sendMessage 分段连发（800ms 段间 sleep）
//
// 关键差异 vs WechatEventSink：
//   - 起始消息升级为可编辑的 progress 容器（实时显示工具历史 / reasoning / status）
//   - parse_mode='HTML'，HTML parse 错误自动降级 plain text 重发该 chunk
//   - editMessageText 节流 1100ms（telegram per-message edit ~1 req/sec，留 100ms buffer）
//   - "message is not modified" 错误 swallow（内容没变化是正常的，不算失败）

import type { AgentExecutionEvent } from '@/core/events.ts'
import type { EventSink } from '@/im/types.ts'
import type { Logger } from '@/logger/logger.ts'
import type { TelegramApi } from './TelegramApi.ts'
import type { TelegramRenderer } from './TelegramRenderer.ts'

export interface TelegramEventSinkDeps {
  api: TelegramApi
  renderer: TelegramRenderer
  /** 数字 chat_id 字符串形式（私聊正、group/channel 负）*/
  chatId: string
  logger: Logger
}

const SEGMENT_INTER_DELAY_MS = 800
const PROGRESS_EDIT_THROTTLE_MS = 1100

export function createTelegramEventSink(deps: TelegramEventSinkDeps): EventSink {
  const log = deps.logger.withTag('telegram:sink')
  let terminalPhase: 'completed' | 'stopped' | 'failed' | undefined

  // progress 容器消息状态
  let progressMessageId: number | undefined
  let progressInitInflight: Promise<void> | undefined  // 防止首次创建被并发触发
  let lastEditAt = 0
  let pendingEditTimer: ReturnType<typeof setTimeout> | undefined
  let lastEditedHtml = ''

  // 真正执行编辑（不 throttle，由 caller 决定时机）
  async function doEdit(): Promise<void> {
    if (progressMessageId === undefined) return
    const html = deps.renderer.currentProgressHtml()
    if (html === lastEditedHtml) return  // 内容无变化，避免 'not modified' 噪声
    try {
      await deps.api.editMessageText(deps.chatId, progressMessageId, html, {
        parse_mode: 'HTML',
      })
      lastEditedHtml = html
      lastEditAt = Date.now()
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (/message is not modified/i.test(msg)) {
        // server 端判断未变化，等同成功
        lastEditedHtml = html
        lastEditAt = Date.now()
        return
      }
      // HTML parse 错？降级 plain text 重试一次
      if (/parse entities|parse_mode|HTML/i.test(msg)) {
        try {
          await deps.api.editMessageText(deps.chatId, progressMessageId, html)
          lastEditedHtml = html
          lastEditAt = Date.now()
          return
        } catch (err2) {
          log.warn('progress 编辑降级 plain text 仍失败（不阻塞）', { err: err2 })
          return
        }
      }
      log.warn('progress 编辑失败（不阻塞）', { err })
    }
  }

  function scheduleEdit(): void {
    if (pendingEditTimer) return  // 已有 timer，下次 fire 时拿最新内容
    const sinceLast = Date.now() - lastEditAt
    if (sinceLast >= PROGRESS_EDIT_THROTTLE_MS) {
      // 立刻 fire（不 await，避免阻塞 onEvent）
      void doEdit()
    } else {
      pendingEditTimer = setTimeout(() => {
        pendingEditTimer = undefined
        void doEdit()
      }, PROGRESS_EDIT_THROTTLE_MS - sinceLast)
    }
  }

  async function ensureProgressMessage(): Promise<void> {
    if (progressMessageId !== undefined) return
    if (progressInitInflight) return progressInitInflight
    progressInitInflight = (async () => {
      const html = deps.renderer.currentProgressHtml()
      try {
        const res = await deps.api.sendMessage(deps.chatId, html, { parse_mode: 'HTML' })
        progressMessageId = res.message_id
        lastEditedHtml = html
        lastEditAt = Date.now()
      } catch (err) {
        log.warn('progress 容器消息发送失败（后续 final result 仍会尝试发送）', { err })
      } finally {
        progressInitInflight = undefined
      }
    })()
    return progressInitInflight
  }

  return {
    get terminalPhase() {
      return terminalPhase
    },

    async onEvent(event: AgentExecutionEvent) {
      try {
        // 喂给 renderer 累积状态（progress + final 都用这份状态）
        deps.renderer.onEvent(event)

        if (event.type === 'lifecycle') {
          if (
            event.phase === 'completed' ||
            event.phase === 'stopped' ||
            event.phase === 'failed'
          ) {
            terminalPhase = event.phase
          }
        }

        // progress 容器：首次直接 await 创建（同步保证后续 edit 有 message_id）；后续 throttled edit
        if (progressMessageId === undefined) {
          await ensureProgressMessage()
        } else {
          scheduleEdit()
        }
      } catch (err) {
        log.error('onEvent 内部异常（不冒泡）', err)
      }
    },

    async finalize() {
      // 取消 pending throttle，确保不在 finalize 之后还跑
      if (pendingEditTimer) {
        clearTimeout(pendingEditTimer)
        pendingEditTimer = undefined
      }

      // progress 容器跑完即删（避免遗留 "⏳ 回复中..." 这种过时状态）。
      // 删除失败（API 错 / 已过 48h）→ 降级为 editMessageText 把状态改为 "✅ 完成"
      if (progressMessageId !== undefined) {
        try {
          await deps.api.deleteMessage(deps.chatId, progressMessageId)
        } catch (err) {
          log.warn('progress 容器删除失败，降级编辑为已完成态', { err })
          try {
            await deps.api.editMessageText(deps.chatId, progressMessageId, '✅ 完成', {
              parse_mode: 'HTML',
            })
          } catch (err2) {
            log.warn('progress 容器编辑也失败（不阻塞 final）', { err: err2 })
          }
        }
        progressMessageId = undefined
      }

      // 发 final result chunks
      const segments = deps.renderer.flush()
      for (const [i, seg] of segments.entries()) {
        try {
          await deps.api.sendMessage(deps.chatId, seg, { parse_mode: 'HTML' })
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          if (/parse entities|parse_mode|HTML/i.test(msg)) {
            log.warn('HTML parse 失败，降级 plain text 重发', { i, err })
            try {
              await deps.api.sendMessage(deps.chatId, seg)
              if (i < segments.length - 1) await sleep(SEGMENT_INTER_DELAY_MS)
              continue
            } catch (err2) {
              log.error('plain text 重发也失败，本轮终止', { i, err2 })
              throw err2
            }
          }
          log.error('段发送失败', { i, err })
          throw err
        }
        if (i < segments.length - 1) await sleep(SEGMENT_INTER_DELAY_MS)
      }
    },
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms))
}
