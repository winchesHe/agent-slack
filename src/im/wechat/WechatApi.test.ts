import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { WechatApi } from './WechatApi.ts'
import { ERRCODE_SESSION_EXPIRED } from './protocol.ts'

describe('WechatApi.getUpdates', () => {
  let fetchMock: ReturnType<typeof vi.fn>
  let api: WechatApi

  beforeEach(() => {
    fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    api = new WechatApi({
      baseUrl: 'https://ilink.example/',
      cdnBaseUrl: 'https://cdn.example',
      token: 'tok-abc',
    })
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('baseUrl 自动补斜杠', () => {
    const a2 = new WechatApi({ baseUrl: 'https://ilink.example', cdnBaseUrl: 'x' })
    expect(a2.baseUrl).toBe('https://ilink.example/')
  })

  it('POST /ilink/bot/getupdates；body 含 get_updates_buf 与 base_info', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ ret: 0, msgs: [], get_updates_buf: 'buf2' }),
    })
    const resp = await api.getUpdates('buf1')

    expect(fetchMock).toHaveBeenCalledOnce()
    const [url, init] = fetchMock.mock.calls[0]!
    expect(url).toBe('https://ilink.example/ilink/bot/getupdates')
    expect(init.method).toBe('POST')
    const body = JSON.parse(init.body)
    expect(body.get_updates_buf).toBe('buf1')
    expect(body.base_info).toEqual({ channel_version: '2.0.0' })
    expect(init.headers['Authorization']).toBe('Bearer tok-abc')
    expect(init.headers['AuthorizationType']).toBe('ilink_bot_token')
    expect(init.headers['iLink-App-Id']).toBe('bot')
    expect(init.headers['iLink-App-ClientVersion']).toBe('131072')
    expect(init.headers['X-WECHAT-UIN']).toMatch(/^[A-Za-z0-9+/=]+$/)
    expect(resp.get_updates_buf).toBe('buf2')
  })

  it('long-poll abort（caller signal 触发）返回空响应 { ret:0, msgs:[] }', async () => {
    fetchMock.mockImplementation((_url, init: RequestInit) => {
      return new Promise((_resolve, reject) => {
        ;(init.signal as AbortSignal).addEventListener('abort', () => {
          const err = new Error('aborted')
          err.name = 'AbortError'
          reject(err)
        })
      })
    })
    const ctl = new AbortController()
    setTimeout(() => ctl.abort(), 0)
    const resp = await api.getUpdates('', ctl.signal)
    expect(resp).toEqual({ ret: 0, msgs: [] })
  })

  it('errcode -14 透传给调用方', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ ret: 0, errcode: -14, errmsg: 'session expired' }),
    })
    const resp = await api.getUpdates('')
    expect(resp.errcode).toBe(ERRCODE_SESSION_EXPIRED)
    expect(resp.errmsg).toBe('session expired')
  })

  it('HTTP 非 2xx 抛错', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 500 })
    await expect(api.getUpdates('')).rejects.toThrow(/HTTP 500/)
  })

  it('randomUin round-trip 是数字字符串的 base64', async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ ret: 0 }) })
    await api.getUpdates('')
    const init = fetchMock.mock.calls[0]![1]
    const uinB64 = init.headers['X-WECHAT-UIN']
    const decoded = Buffer.from(uinB64, 'base64').toString('utf8')
    expect(decoded).toMatch(/^\d+$/)
  })
})

describe('WechatApi.sendText', () => {
  let fetchMock: ReturnType<typeof vi.fn>
  let api: WechatApi

  beforeEach(() => {
    fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) })
    vi.stubGlobal('fetch', fetchMock)
    api = new WechatApi({ baseUrl: 'https://ilink.example/', cdnBaseUrl: 'x', token: 'tok' })
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('POST /ilink/bot/sendmessage；body 结构对齐 CowAgent', async () => {
    await api.sendText('uABC', 'hello', 'ctx-123')
    const [url, init] = fetchMock.mock.calls[0]!
    expect(url).toBe('https://ilink.example/ilink/bot/sendmessage')
    const body = JSON.parse(init.body)
    expect(body.msg.from_user_id).toBe('')
    expect(body.msg.to_user_id).toBe('uABC')
    expect(body.msg.message_type).toBe(2)
    expect(body.msg.message_state).toBe(2)
    expect(body.msg.context_token).toBe('ctx-123')
    expect(body.msg.client_id).toMatch(/^[a-f0-9]{16}$/)
    expect(body.msg.item_list).toEqual([{ type: 1, text_item: { text: 'hello' } }])
  })
})

describe('WechatApi.fetchQrCode / pollQrStatus', () => {
  let fetchMock: ReturnType<typeof vi.fn>
  let api: WechatApi

  beforeEach(() => {
    fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    api = new WechatApi({ baseUrl: 'https://ilink.example/', cdnBaseUrl: 'x' })
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('fetchQrCode：GET /ilink/bot/get_bot_qrcode?bot_type=3', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ qrcode: 'qr-abc', qrcode_img_content: 'https://qr.example/...' }),
    })
    const resp = await api.fetchQrCode()
    const [url, init] = fetchMock.mock.calls[0]!
    expect(url).toBe('https://ilink.example/ilink/bot/get_bot_qrcode?bot_type=3')
    expect(init.method).toBe('GET')
    expect(resp.qrcode).toBe('qr-abc')
  })

  it('pollQrStatus：GET /ilink/bot/get_qrcode_status?qrcode=...，URL 编码', async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ status: 'wait' }) })
    await api.pollQrStatus('qr/abc?special')
    const [url, init] = fetchMock.mock.calls[0]!
    expect(url).toContain(encodeURIComponent('qr/abc?special'))
    expect(init.headers['iLink-App-Id']).toBe('bot')
  })

  it('pollQrStatus AbortError 返回 { status: wait }', async () => {
    const abortErr = new Error('aborted')
    abortErr.name = 'AbortError'
    fetchMock.mockRejectedValueOnce(abortErr)
    const resp = await api.pollQrStatus('qr')
    expect(resp).toEqual({ status: 'wait' })
  })
})
