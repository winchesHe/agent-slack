// Telegram Bot API 裸 fetch 封装。outbound-only 场景，仅 sendMessage + getMe + _post。
//
// 服务端约定：所有响应都是 `{ ok: boolean, result?: T, description?: string, error_code?: number, parameters?: { retry_after?: number } }`。
// 任何 ok=false 都视为失败抛错（包含 HTTP 4xx/5xx 已被 fetch 捕获后服务端仍可能返回 200+ok=false 的边界）。
//
// 不实现 setToken / loadCredentialsOnly：bot token 长期有效，构造时一次性注入即可，无 wechat 那种扫码后切换需求。

import type { Logger } from '@/logger/logger.ts'

export interface TelegramApiOpts {
  token: string
  /** 默认 https://api.telegram.org */
  baseUrl?: string
  logger: Logger
}

export interface TelegramSendMessageOpts {
  /** 'HTML' | 'MarkdownV2' | undefined。outbound 默认 'HTML'，错误降级时 caller 重发 undefined */
  parse_mode?: 'HTML' | 'MarkdownV2'
  /** 默认 true：禁用链接卡片预览，避免长报告被一堆缩略图淹没 */
  disable_web_page_preview?: boolean
}

export interface TelegramGetMeResp {
  id: number
  is_bot: boolean
  username?: string
  first_name?: string
}

const DEFAULT_BASE_URL = 'https://api.telegram.org'
const DEFAULT_TIMEOUT_MS = 30_000

export class TelegramApi {
  private readonly token: string
  private readonly baseUrl: string
  private readonly log: Logger

  constructor(opts: TelegramApiOpts) {
    this.token = opts.token
    this.baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, '')
    this.log = opts.logger.withTag('telegram:api')
  }

  /** 启动期探活；失败 caller 应仅 warn 不阻塞 daemon */
  async getMe(): Promise<TelegramGetMeResp> {
    return await this._post<TelegramGetMeResp>('getMe', {})
  }

  /** outbound 主入口；返回值：服务端 message.message_id（caller 可保存以便后续 editMessageText） */
  async sendMessage(
    chatId: string,
    text: string,
    opts?: TelegramSendMessageOpts,
  ): Promise<{ message_id: number }> {
    const body: Record<string, unknown> = {
      chat_id: chatId,
      text,
      disable_web_page_preview: opts?.disable_web_page_preview ?? true,
    }
    if (opts?.parse_mode) body.parse_mode = opts.parse_mode
    return await this._post<{ message_id: number }>('sendMessage', body)
  }

  /**
   * 编辑已发出的消息（progress 容器实时更新用）。
   * Telegram 限流：单消息编辑 1 次/秒。caller 须自己节流。
   * 失败原因（常见）：
   *   - 'message is not modified'：text 无变化，无需重发（caller 可忽略此错误）
   *   - 'message to edit not found'：消息被删了
   */
  async editMessageText(
    chatId: string,
    messageId: number,
    text: string,
    opts?: TelegramSendMessageOpts,
  ): Promise<void> {
    const body: Record<string, unknown> = {
      chat_id: chatId,
      message_id: messageId,
      text,
      disable_web_page_preview: opts?.disable_web_page_preview ?? true,
    }
    if (opts?.parse_mode) body.parse_mode = opts.parse_mode
    await this._post('editMessageText', body)
  }

  /**
   * 删除消息（progress 容器跑完后清理）。
   * Telegram 允许删除 bot 自己发出的消息（48h 内 / private chat 任何时候）。
   * 失败常见 'message to delete not found'：caller 可忽略。
   */
  async deleteMessage(chatId: string, messageId: number): Promise<void> {
    await this._post('deleteMessage', { chat_id: chatId, message_id: messageId })
  }

  private async _post<T = unknown>(method: string, body: Record<string, unknown>): Promise<T> {
    const url = `${this.baseUrl}/bot${this.token}/${method}`
    const ctl = new AbortController()
    const timer = setTimeout(() => ctl.abort(), DEFAULT_TIMEOUT_MS)
    try {
      const resp = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: ctl.signal,
      })
      // 即使 HTTP 200，body 里 ok=false 仍是失败；HTTP 4xx/5xx body 也是 ok=false
      const json = (await resp.json().catch(() => null)) as
        | {
            ok: boolean
            result?: T
            description?: string
            error_code?: number
            parameters?: { retry_after?: number }
          }
        | null
      if (!json) {
        throw new Error(`telegram ${method} 响应解析失败 HTTP ${resp.status}`)
      }
      if (!json.ok) {
        const retryAfter = json.parameters?.retry_after
        const retryHint = retryAfter !== undefined ? ` retry_after=${retryAfter}s` : ''
        throw new Error(
          `telegram ${method} 失败 error_code=${json.error_code ?? '?'} description="${json.description ?? ''}"${retryHint}`,
        )
      }
      return json.result as T
    } finally {
      clearTimeout(timer)
    }
  }
}
