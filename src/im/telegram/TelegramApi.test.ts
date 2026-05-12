import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { TelegramApi } from './TelegramApi.ts'

// 简易 logger（mock）
const fakeLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  withTag: () => fakeLogger,
} as never

function mockFetch(impl: (url: string, init: RequestInit) => Response | Promise<Response>) {
  // @ts-expect-error 测试覆盖全局 fetch
  globalThis.fetch = vi.fn(impl)
}

describe('TelegramApi', () => {
  let api: TelegramApi

  beforeEach(() => {
    api = new TelegramApi({ token: 'TKN', logger: fakeLogger })
  })

  afterEach(() => {
    // @ts-expect-error 还原
    delete globalThis.fetch
  })

  describe('getMe', () => {
    it('成功返回 result', async () => {
      mockFetch(() =>
        Response.json({
          ok: true,
          result: { id: 1, is_bot: true, username: 'foo', first_name: 'Foo' },
        }),
      )
      const me = await api.getMe()
      expect(me.username).toBe('foo')
    })

    it('ok=false 抛错', async () => {
      mockFetch(() =>
        Response.json({ ok: false, error_code: 401, description: 'Unauthorized' }),
      )
      await expect(api.getMe()).rejects.toThrow(/error_code=401/)
    })
  })

  describe('sendMessage', () => {
    it('正常路径 200 + ok=true，返回 message_id', async () => {
      const callBody = vi.fn()
      mockFetch((_url, init) => {
        callBody(JSON.parse(init.body as string))
        return Response.json({ ok: true, result: { message_id: 42 } })
      })
      const result = await api.sendMessage('123', 'hi', { parse_mode: 'HTML' })
      expect(callBody).toHaveBeenCalledWith({
        chat_id: '123',
        text: 'hi',
        disable_web_page_preview: true,
        parse_mode: 'HTML',
      })
      expect(result.message_id).toBe(42)
    })

    it('429 retry_after 富化 error message', async () => {
      mockFetch(() =>
        Response.json({
          ok: false,
          error_code: 429,
          description: 'Too Many Requests: retry after 5',
          parameters: { retry_after: 5 },
        }),
      )
      await expect(api.sendMessage('123', 'hi')).rejects.toThrow(/retry_after=5s/)
    })

    it('400 bad request 抛错带 description', async () => {
      mockFetch(() =>
        Response.json({
          ok: false,
          error_code: 400,
          description: "Bad Request: can't parse entities",
        }),
      )
      await expect(api.sendMessage('123', 'hi', { parse_mode: 'HTML' })).rejects.toThrow(
        /can't parse entities/,
      )
    })

    it('disable_web_page_preview 默认 true', async () => {
      const callBody = vi.fn()
      mockFetch((_url, init) => {
        callBody(JSON.parse(init.body as string))
        return Response.json({ ok: true, result: {} })
      })
      await api.sendMessage('123', 'hi')
      expect(callBody).toHaveBeenCalledWith(
        expect.objectContaining({ disable_web_page_preview: true }),
      )
    })

    it('parse_mode 不传时 body 不带该字段', async () => {
      const callBody = vi.fn()
      mockFetch((_url, init) => {
        callBody(JSON.parse(init.body as string))
        return Response.json({ ok: true, result: { message_id: 1 } })
      })
      await api.sendMessage('123', 'hi')
      expect(callBody.mock.calls[0]?.[0]).not.toHaveProperty('parse_mode')
    })
  })

  describe('editMessageText', () => {
    it('正常路径 200 + ok=true', async () => {
      const callBody = vi.fn()
      mockFetch((_url, init) => {
        callBody(JSON.parse(init.body as string))
        return Response.json({ ok: true, result: { message_id: 42 } })
      })
      await api.editMessageText('123', 42, 'updated', { parse_mode: 'HTML' })
      expect(callBody).toHaveBeenCalledWith({
        chat_id: '123',
        message_id: 42,
        text: 'updated',
        disable_web_page_preview: true,
        parse_mode: 'HTML',
      })
    })

    it('"message is not modified" 抛错（caller 自行决定是否 swallow）', async () => {
      mockFetch(() =>
        Response.json({
          ok: false,
          error_code: 400,
          description: 'Bad Request: message is not modified',
        }),
      )
      await expect(api.editMessageText('123', 42, 'same')).rejects.toThrow(
        /message is not modified/,
      )
    })
  })
})
