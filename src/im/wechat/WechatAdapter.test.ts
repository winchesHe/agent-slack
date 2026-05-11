import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createCredentialsStore } from './CredentialsStore.ts'
import {
  qrLogin,
  createWechatAdapter,
  processMessage as _processMessage,
} from './WechatAdapter.ts'
import type { Logger } from '@/logger/logger.ts'

const stubLogger = (): Logger => {
  const make = (): Logger => ({
    trace: () => {},
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
    withTag: () => make(),
  })
  return make()
}

describe('qrLogin', () => {
  it('confirmed 状态返回完整凭证', async () => {
    const api = {
      baseUrl: 'https://ilink.example/',
      cdnBaseUrl: '',
      fetchQrCode: vi.fn().mockResolvedValue({ qrcode: 'qr1', qrcode_img_content: 'https://qr/1' }),
      pollQrStatus: vi.fn().mockResolvedValue({
        status: 'confirmed',
        bot_token: 'tok',
        ilink_bot_id: 'b1',
        ilink_user_id: 'u1',
        baseurl: 'https://ilink.cn/',
      }),
      setToken: vi.fn(),
    } as never
    const creds = await qrLogin(
      {
        api,
        credentialsStore: createCredentialsStore(),
        credentialsFile: '/tmp/x',
        logger: stubLogger(),
      } as never,
      () => false,
    )
    expect(creds).toEqual({
      token: 'tok',
      baseUrl: 'https://ilink.cn/',
      botId: 'b1',
      userId: 'u1',
    })
  })

  it('expired 自动刷新；超过 10 次放弃', async () => {
    const api = {
      baseUrl: '',
      cdnBaseUrl: '',
      fetchQrCode: vi.fn().mockResolvedValue({ qrcode: 'qr', qrcode_img_content: '' }),
      pollQrStatus: vi.fn().mockResolvedValue({ status: 'expired' }),
      setToken: vi.fn(),
    }
    const creds = await qrLogin(
      {
        api,
        credentialsStore: createCredentialsStore(),
        credentialsFile: '/tmp/x',
        logger: stubLogger(),
      } as never,
      () => false,
    )
    expect(creds).toBeUndefined()
    // 初始 fetchQrCode 1 次；之后每次 expired 增 refreshCount，刷新调用 fetchQrCode；
    // 当 refreshCount 自增到 10 时直接 return undefined（不再 fetch）。
    // 即刷新调用 = 9 次（refreshCount 1..9）→ fetchQrCode 总调用 = 1 + 9 = 10
    expect(api.fetchQrCode.mock.calls.length).toBe(10)
  }, 30000)

  it('isStopped() 返回 true 时立即退出', async () => {
    let stopped = false
    const api = {
      baseUrl: '',
      cdnBaseUrl: '',
      fetchQrCode: vi.fn().mockResolvedValue({ qrcode: 'qr', qrcode_img_content: '' }),
      pollQrStatus: vi.fn().mockImplementation(async () => {
        stopped = true
        return { status: 'wait' }
      }),
      setToken: vi.fn(),
    } as never
    const creds = await qrLogin(
      {
        api,
        credentialsStore: createCredentialsStore(),
        credentialsFile: '/tmp/x',
        logger: stubLogger(),
      } as never,
      () => stopped,
    )
    expect(creds).toBeUndefined()
  })

  it('confirmed 但缺 token / bot_id → 返回 undefined', async () => {
    const api = {
      baseUrl: '',
      cdnBaseUrl: '',
      fetchQrCode: vi.fn().mockResolvedValue({ qrcode: 'qr', qrcode_img_content: '' }),
      pollQrStatus: vi.fn().mockResolvedValue({ status: 'confirmed' }),
      setToken: vi.fn(),
    } as never
    const creds = await qrLogin(
      {
        api,
        credentialsStore: createCredentialsStore(),
        credentialsFile: '/tmp/x',
        logger: stubLogger(),
      } as never,
      () => false,
    )
    expect(creds).toBeUndefined()
  })
})

describe('createWechatAdapter.start', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'wechat-adapter-'))
  })

  it('凭证存在 → 跳过扫码，直接 setToken', async () => {
    const credsFile = path.join(dir, 'credentials.json')
    const store = createCredentialsStore()
    await store.save(credsFile, {
      token: 'tok-saved',
      baseUrl: 'https://x.example/',
      botId: '',
      userId: '',
    })

    const api = {
      baseUrl: '',
      cdnBaseUrl: '',
      setToken: vi.fn(),
      fetchQrCode: vi.fn(),
      getUpdates: vi.fn().mockResolvedValue({ ret: 0, msgs: [] }),
    }
    const { adapter } = createWechatAdapter({
      api: api as never,
      credentialsStore: store,
      credentialsFile: credsFile,
      orchestrator: {} as never,
      sessionStore: {} as never,
      runQueue: {} as never,
      abortRegistry: {} as never,
      rendererFactory: () => ({}) as never,
      logger: stubLogger(),
    })
    await adapter.start()
    expect(api.setToken).toHaveBeenCalledWith('tok-saved')
    expect(api.fetchQrCode).not.toHaveBeenCalled()
    await adapter.stop()
  })

  it('凭证不存在 + expired 模式 → 抛错', async () => {
    const credsFile = path.join(dir, 'credentials.json')
    const api = {
      baseUrl: '',
      cdnBaseUrl: '',
      fetchQrCode: vi.fn().mockResolvedValue({ qrcode: 'qr', qrcode_img_content: '' }),
      pollQrStatus: vi.fn().mockResolvedValue({ status: 'expired' }),
      setToken: vi.fn(),
    } as never
    const { adapter } = createWechatAdapter({
      api,
      credentialsStore: createCredentialsStore(),
      credentialsFile: credsFile,
      orchestrator: {} as never,
      sessionStore: {} as never,
      runQueue: {} as never,
      abortRegistry: {} as never,
      rendererFactory: () => ({}) as never,
      logger: stubLogger(),
    })
    await expect(adapter.start()).rejects.toThrow(/扫码登录/)
  }, 30000)
})

describe('processMessage', () => {
  const stubOrchestrator = () => ({ handle: vi.fn().mockResolvedValue(undefined) })
  const stubApi = () => ({
    baseUrl: '',
    cdnBaseUrl: '',
    setToken: vi.fn(),
    sendText: vi.fn().mockResolvedValue(undefined),
    fetchQrCode: vi.fn(),
    pollQrStatus: vi.fn(),
    getUpdates: vi.fn(),
    getConfig: vi.fn(),
  })

  const baseDeps = (
    api = stubApi(),
    orch = stubOrchestrator(),
    rendererFactory = () => ({ onEvent: () => {}, flush: () => [], STARTING_MESSAGE: '...' }),
  ): never =>
    ({
      api,
      credentialsStore: createCredentialsStore(),
      credentialsFile: '/tmp/x',
      orchestrator: orch,
      sessionStore: {},
      runQueue: {},
      abortRegistry: {},
      rendererFactory,
      logger: stubLogger(),
    }) as never

  it('文本消息 → 调 orchestrator.handle，sendText 不被调（除非 sink finalize）', async () => {
    const api = stubApi()
    const orch = stubOrchestrator()
    const deps = baseDeps(api, orch)
    await _processMessage(
      deps,
      {
        message_type: 1,
        message_id: 'm1',
        from_user_id: 'uA',
        to_user_id: 'bot',
        context_token: 'ctx',
        item_list: [{ type: 1, text_item: { text: 'hi' } }],
      } as never,
      new Map(),
      new Map(),
    )
    await new Promise((r) => setTimeout(r, 10))
    expect(orch.handle).toHaveBeenCalledOnce()
    const inbound = orch.handle.mock.calls[0]![0]
    expect(inbound.imProvider).toBe('wechat')
    expect(inbound.text).toBe('hi')
    expect(inbound.confirmSender).toBeUndefined()
  })

  it('media 消息 → 不调 orchestrator，立即 sendText 提示', async () => {
    const api = stubApi()
    const orch = stubOrchestrator()
    const deps = baseDeps(api, orch)
    await _processMessage(
      deps,
      {
        message_type: 1,
        message_id: 'm2',
        from_user_id: 'uA',
        to_user_id: 'bot',
        context_token: 'ctx',
        item_list: [{ type: 2, image_item: {} }],
      } as never,
      new Map(),
      new Map(),
    )
    expect(api.sendText).toHaveBeenCalledOnce()
    expect(api.sendText.mock.calls[0]![1]).toMatch(/暂不支持/)
    expect(orch.handle).not.toHaveBeenCalled()
  })

  it('文本+媒体混合 → 提示 + 文本进 orchestrator', async () => {
    const api = stubApi()
    const orch = stubOrchestrator()
    const deps = baseDeps(api, orch)
    await _processMessage(
      deps,
      {
        message_type: 1,
        message_id: 'm3',
        from_user_id: 'uA',
        to_user_id: 'bot',
        context_token: 'ctx',
        item_list: [
          { type: 1, text_item: { text: 'check this' } },
          { type: 2, image_item: {} },
        ],
      } as never,
      new Map(),
      new Map(),
    )
    await new Promise((r) => setTimeout(r, 10))
    expect(api.sendText).toHaveBeenCalledOnce()
    expect(orch.handle).toHaveBeenCalledOnce()
  })

  it('重复 msgId 被去重', async () => {
    const api = stubApi()
    const orch = stubOrchestrator()
    const deps = baseDeps(api, orch)
    const dedup = new Map<string, number>()
    const ctxs = new Map<string, string>()
    await _processMessage(
      deps,
      {
        message_type: 1,
        message_id: 'm4',
        from_user_id: 'uA',
        to_user_id: 'b',
        context_token: 'ctx',
        item_list: [{ type: 1, text_item: { text: 'hi' } }],
      } as never,
      dedup,
      ctxs,
    )
    await _processMessage(
      deps,
      {
        message_type: 1,
        message_id: 'm4',
        from_user_id: 'uA',
        to_user_id: 'b',
        context_token: 'ctx',
        item_list: [{ type: 1, text_item: { text: 'hi' } }],
      } as never,
      dedup,
      ctxs,
    )
    await new Promise((r) => setTimeout(r, 10))
    expect(orch.handle.mock.calls.length).toBe(1)
  })

  it('注入 contextTokenStore：入站时 store.save 被调用（spec §6.4 长期方案）', async () => {
    const api = stubApi()
    const orch = stubOrchestrator()
    const save = vi.fn(async () => undefined)
    const store = { get: vi.fn(() => undefined), save }
    const deps = {
      ...(baseDeps(api, orch) as unknown as Record<string, unknown>),
      contextTokenStore: store,
    } as never
    await _processMessage(
      deps,
      {
        message_type: 1,
        message_id: 'm-store',
        from_user_id: 'uA',
        to_user_id: 'b',
        context_token: 'persist-this',
        item_list: [{ type: 1, text_item: { text: 'hi' } }],
      } as never,
      new Map(),
      new Map(),
    )
    await new Promise((r) => setTimeout(r, 10))
    expect(save).toHaveBeenCalledWith('uA', 'persist-this')
  })

  it('未注入 contextTokenStore：行为退化为纯内存（不抛、不阻塞）', async () => {
    const api = stubApi()
    const orch = stubOrchestrator()
    const deps = baseDeps(api, orch)
    await _processMessage(
      deps,
      {
        message_type: 1,
        message_id: 'm-no-store',
        from_user_id: 'uA',
        to_user_id: 'b',
        context_token: 'ctx',
        item_list: [{ type: 1, text_item: { text: 'hi' } }],
      } as never,
      new Map(),
      new Map(),
    )
    await new Promise((r) => setTimeout(r, 10))
    expect(orch.handle).toHaveBeenCalledOnce()
  })

  it('contextToken 在解析前更新（媒体消息也能拿到 token 发提示）', async () => {
    const api = stubApi()
    const deps = baseDeps(api)
    const ctxs = new Map<string, string>()
    await _processMessage(
      deps,
      {
        message_type: 1,
        message_id: 'm5',
        from_user_id: 'uB',
        to_user_id: 'b',
        context_token: 'fresh-token',
        item_list: [{ type: 2 }],
      } as never,
      new Map(),
      ctxs,
    )
    expect(ctxs.get('uB')).toBe('fresh-token')
    expect(api.sendText.mock.calls[0]![2]).toBe('fresh-token')
  })

  it('每条入站消息独立调用 rendererFactory（renderer 不被多消息共享）', async () => {
    const api = stubApi()
    const orch = stubOrchestrator()
    const rendererFactory = vi.fn(() => ({
      onEvent: () => {},
      flush: () => [],
      STARTING_MESSAGE: '...',
    }))
    const deps = baseDeps(api, orch, rendererFactory)
    await _processMessage(
      deps,
      {
        message_type: 1,
        message_id: 'm-iso-1',
        from_user_id: 'uA',
        to_user_id: 'b',
        context_token: 'ctx',
        item_list: [{ type: 1, text_item: { text: 'first' } }],
      } as never,
      new Map(),
      new Map(),
    )
    await _processMessage(
      deps,
      {
        message_type: 1,
        message_id: 'm-iso-2',
        from_user_id: 'uA',
        to_user_id: 'b',
        context_token: 'ctx',
        item_list: [{ type: 1, text_item: { text: 'second' } }],
      } as never,
      new Map(),
      new Map(),
    )
    await new Promise((r) => setTimeout(r, 10))
    expect(rendererFactory).toHaveBeenCalledTimes(2)
  })

  it('message_type !== 1（非用户消息）跳过', async () => {
    const api = stubApi()
    const orch = stubOrchestrator()
    const deps = baseDeps(api, orch)
    await _processMessage(
      deps,
      {
        message_type: 2,
        message_id: 'mX',
        from_user_id: 'b',
        to_user_id: 'uA',
        context_token: '',
        item_list: [],
      } as never,
      new Map(),
      new Map(),
    )
    expect(orch.handle).not.toHaveBeenCalled()
    expect(api.sendText).not.toHaveBeenCalled()
  })
})
