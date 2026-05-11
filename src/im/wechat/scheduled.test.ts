import { describe, expect, it, vi } from 'vitest'
import { MissingContextTokenError, runScheduledWechatSession } from './scheduled.ts'
import type { ContextTokenStore } from './ContextTokenStore.ts'

function stubLogger() {
  const noop = () => {}
  return {
    debug: noop,
    info: noop,
    warn: noop,
    error: noop,
    withTag: () => stubLogger(),
  } as never
}

function stubApi() {
  return { sendText: vi.fn(async () => undefined), setToken: vi.fn() } as never
}

function stubRendererFactory() {
  return () => ({ kind: 'wechat-renderer' }) as never
}

function makeStore(map: Record<string, string> = {}): ContextTokenStore {
  return {
    get: vi.fn((id: string) => map[id]),
    save: vi.fn(async () => undefined),
  }
}

const PEER = 'oABC123@im.wechat'

describe('runScheduledWechatSession', () => {
  it('构造 inbound：channelId/threadTs/userId 全 = to；userName=scheduler；contextToken 来自 store', async () => {
    const orchestrator = { handle: vi.fn(async (_inbound: unknown, _sink: unknown) => undefined) }
    const store = makeStore({ [PEER]: 'real-token' })
    await runScheduledWechatSession({
      taskId: 'weekly-report',
      to: PEER,
      prompt: '本周小结',
      api: stubApi(),
      deps: {
        orchestrator: orchestrator as never,
        rendererFactory: stubRendererFactory(),
        logger: stubLogger(),
        contextTokenStore: store,
        nowMs: () => 1717_000_000_000,
      },
    })

    expect(orchestrator.handle).toHaveBeenCalledTimes(1)
    const call = orchestrator.handle.mock.calls[0]!
    const inbound = call[0] as Record<string, unknown>
    expect(inbound).toMatchObject({
      imProvider: 'wechat',
      channelId: PEER,
      channelName: PEER,
      threadTs: PEER,
      userId: 'scheduler',
      userName: 'scheduler',
      text: '本周小结',
    })
    expect(inbound.confirmSender).toBeUndefined()
    expect(typeof inbound.messageTs).toBe('string')
    expect(store.get).toHaveBeenCalledWith(PEER)
  })

  it('messageTs 是确定性的：相同 nowMs 产出相同值', async () => {
    const orchestrator = { handle: vi.fn(async (_inbound: unknown, _sink: unknown) => undefined) }
    const store = makeStore({ [PEER]: 'tok' })
    await runScheduledWechatSession({
      taskId: 't',
      to: PEER,
      prompt: 'p',
      api: stubApi(),
      deps: {
        orchestrator: orchestrator as never,
        rendererFactory: stubRendererFactory(),
        logger: stubLogger(),
        contextTokenStore: store,
        nowMs: () => 42,
      },
    })
    await runScheduledWechatSession({
      taskId: 't',
      to: PEER,
      prompt: 'p',
      api: stubApi(),
      deps: {
        orchestrator: orchestrator as never,
        rendererFactory: stubRendererFactory(),
        logger: stubLogger(),
        contextTokenStore: store,
        nowMs: () => 42,
      },
    })
    const msg1 = (orchestrator.handle.mock.calls[0]![0] as Record<string, unknown>).messageTs
    const msg2 = (orchestrator.handle.mock.calls[1]![0] as Record<string, unknown>).messageTs
    expect(msg1).toBe(msg2)
  })

  it('store 未命中 to → 抛 MissingContextTokenError（orchestrator 不被调用）', async () => {
    const orchestrator = { handle: vi.fn(async (_inbound: unknown, _sink: unknown) => undefined) }
    const store = makeStore({}) // 空 store
    await expect(
      runScheduledWechatSession({
        taskId: 't',
        to: 'unknown-peer@im.wechat',
        prompt: 'p',
        api: stubApi(),
        deps: {
          orchestrator: orchestrator as never,
          rendererFactory: stubRendererFactory(),
          logger: stubLogger(),
          contextTokenStore: store,
        },
      }),
    ).rejects.toBeInstanceOf(MissingContextTokenError)
    expect(orchestrator.handle).not.toHaveBeenCalled()
  })

  it('MissingContextTokenError 文案含 peerUserId 与"入站消息"指引（让用户能自助修复）', () => {
    const err = new MissingContextTokenError('oXYZ@im.wechat')
    expect(err.name).toBe('MissingContextTokenError')
    expect(err.message).toContain('oXYZ@im.wechat')
    expect(err.message).toContain('入站消息')
  })

  it('orchestrator.handle 抛错 → 直接传播（runner 负责 catch）', async () => {
    const store = makeStore({ [PEER]: 'tok' })
    const orchestrator = {
      handle: vi.fn(async () => {
        throw new Error('agent failed')
      }),
    }
    await expect(
      runScheduledWechatSession({
        taskId: 't',
        to: PEER,
        prompt: 'p',
        api: stubApi(),
        deps: {
          orchestrator: orchestrator as never,
          rendererFactory: stubRendererFactory(),
          logger: stubLogger(),
          contextTokenStore: store,
        },
      }),
    ).rejects.toThrow(/agent failed/)
  })
})
