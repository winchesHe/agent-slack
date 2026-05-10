import { randomUUID } from 'node:crypto'
import {
  ERRCODE_SESSION_EXPIRED,
  WeixinItemType,
  WeixinMessageState,
  WeixinMessageType,
} from './protocol.ts'
import type { FetchQrCodeResp, GetUpdatesResp, QrStatusResp } from './protocol.ts'

export interface WechatCredentials {
  /** sendmessage / getupdates 鉴权 Bearer */
  token: string
  /** ilink 主域，扫码后由服务端返回（可能与配置默认值不同） */
  baseUrl: string
  /** 仅用于日志/可观察性，HTTP 调用不带 */
  botId: string
  /** 仅用于日志/可观察性，HTTP 调用不带 */
  userId: string
}

export interface WechatApiOpts {
  baseUrl: string
  cdnBaseUrl: string
  token?: string
}

const CHANNEL_VERSION = '2.0.0'
const CLIENT_VERSION = '131072' // 2.0.0 编码 = 0x00020000
const BOT_TYPE = '3'
const DEFAULT_LONG_POLL_TIMEOUT_MS = 35_000
const LONG_POLL_BUFFER_MS = 5_000
const DEFAULT_API_TIMEOUT_MS = 15_000

export class WechatApi {
  baseUrl: string
  cdnBaseUrl: string
  private token: string

  constructor(opts: WechatApiOpts) {
    this.baseUrl = opts.baseUrl.endsWith('/') ? opts.baseUrl : opts.baseUrl + '/'
    this.cdnBaseUrl = opts.cdnBaseUrl
    this.token = opts.token ?? ''
  }

  setToken(token: string): void {
    this.token = token
  }

  async getUpdates(buf: string, signal?: AbortSignal): Promise<GetUpdatesResp> {
    try {
      return await this._post<GetUpdatesResp>(
        'ilink/bot/getupdates',
        { get_updates_buf: buf },
        {
          timeoutMs: DEFAULT_LONG_POLL_TIMEOUT_MS + LONG_POLL_BUFFER_MS,
          ...(signal ? { signal } : {}),
        },
      )
    } catch (err) {
      // long-poll abort（含 timer abort 与 caller abort）视为空响应；上层靠 stop flag 退出 loop
      if (err instanceof Error && err.name === 'AbortError') {
        return { ret: 0, msgs: [] }
      }
      throw err
    }
  }

  async sendText(to: string, text: string, contextToken: string): Promise<void> {
    await this._post('ilink/bot/sendmessage', {
      msg: {
        from_user_id: '',
        to_user_id: to,
        client_id: randomUUID().replace(/-/g, '').slice(0, 16),
        message_type: WeixinMessageType.BOT,
        message_state: WeixinMessageState.FINISH,
        item_list: [{ type: WeixinItemType.TEXT, text_item: { text } }],
        context_token: contextToken,
      },
    })
  }

  async getConfig(userId: string, contextToken: string = ''): Promise<unknown> {
    return await this._post<unknown>(
      'ilink/bot/getconfig',
      { ilink_user_id: userId, context_token: contextToken },
      { timeoutMs: 10_000 },
    )
  }

  async fetchQrCode(): Promise<FetchQrCodeResp> {
    const url = `${this.baseUrl}ilink/bot/get_bot_qrcode?bot_type=${BOT_TYPE}`
    return await this._get<FetchQrCodeResp>(url, { timeoutMs: 15_000 })
  }

  async pollQrStatus(qrcode: string): Promise<QrStatusResp> {
    const url = `${this.baseUrl}ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcode)}`
    try {
      return await this._get<QrStatusResp>(url, { timeoutMs: 35_000, withHeaders: true })
    } catch (err) {
      // CowAgent 同设计：所有 timeout/abort 视为 wait 让上层继续轮询
      if (err instanceof Error && err.name === 'AbortError') {
        return { status: 'wait' }
      }
      throw err
    }
  }

  private async _post<T>(
    endpoint: string,
    body: Record<string, unknown>,
    opts?: { timeoutMs?: number; signal?: AbortSignal },
  ): Promise<T> {
    const url = this.baseUrl + endpoint
    const timeoutMs = opts?.timeoutMs ?? DEFAULT_API_TIMEOUT_MS
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      AuthorizationType: 'ilink_bot_token',
      'X-WECHAT-UIN': randomUin(),
      'iLink-App-Id': 'bot',
      'iLink-App-ClientVersion': CLIENT_VERSION,
    }
    if (this.token) headers['Authorization'] = `Bearer ${this.token}`

    // 注入 base_info.channel_version
    const wrappedBody = {
      ...body,
      base_info: { channel_version: CHANNEL_VERSION, ...((body['base_info'] as object) ?? {}) },
    }

    // 组合 timeout signal 与外部传入的 abort signal
    const ctl = new AbortController()
    const timer = setTimeout(() => ctl.abort(), timeoutMs)
    if (opts?.signal) {
      if (opts.signal.aborted) ctl.abort()
      else opts.signal.addEventListener('abort', () => ctl.abort(), { once: true })
    }

    try {
      const resp = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(wrappedBody),
        signal: ctl.signal,
      })
      if (!resp.ok) throw new Error(`HTTP ${resp.status} ${endpoint}`)
      return (await resp.json()) as T
    } finally {
      clearTimeout(timer)
    }
  }

  private async _get<T>(
    fullUrl: string,
    opts?: { timeoutMs?: number; withHeaders?: boolean },
  ): Promise<T> {
    const timeoutMs = opts?.timeoutMs ?? DEFAULT_API_TIMEOUT_MS
    const ctl = new AbortController()
    const timer = setTimeout(() => ctl.abort(), timeoutMs)
    const headers: Record<string, string> = opts?.withHeaders
      ? { 'iLink-App-Id': 'bot', 'iLink-App-ClientVersion': CLIENT_VERSION }
      : {}
    try {
      const resp = await fetch(fullUrl, { method: 'GET', headers, signal: ctl.signal })
      if (!resp.ok) throw new Error(`HTTP ${resp.status} ${fullUrl}`)
      return (await resp.json()) as T
    } finally {
      clearTimeout(timer)
    }
  }
}

function randomUin(): string {
  const val = Math.floor(Math.random() * 0xffffffff)
  return Buffer.from(String(val), 'utf8').toString('base64')
}

export { ERRCODE_SESSION_EXPIRED }
