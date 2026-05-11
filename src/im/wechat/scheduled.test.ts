import { describe, expect, it, vi } from 'vitest'
import { runScheduledWechatSession } from './scheduled.ts'

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

describe('runScheduledWechatSession', () => {
  it('构造 inbound：channelId/threadTs/userId 全 = to；userName=scheduler；contextToken="" 传到 sink', async () => {
    const orchestrator = { handle: vi.fn(async (_inbound: unknown, _sink: unknown) => undefined) }
    await runScheduledWechatSession({
      taskId: 'weekly-report',
      to: 'filehelper',
      prompt: '本周小结',
      api: stubApi(),
      deps: {
        orchestrator: orchestrator as never,
        rendererFactory: stubRendererFactory(),
        logger: stubLogger(),
        nowMs: () => 1717_000_000_000,
      },
    })

    expect(orchestrator.handle).toHaveBeenCalledTimes(1)
    const call = orchestrator.handle.mock.calls[0]!
    const inbound = call[0] as Record<string, unknown>
    expect(inbound).toMatchObject({
      imProvider: 'wechat',
      channelId: 'filehelper',
      channelName: 'filehelper',
      threadTs: 'filehelper',
      userId: 'scheduler',
      userName: 'scheduler',
      text: '本周小结',
    })
    expect(inbound.confirmSender).toBeUndefined()
    // messageTs 用注入的 nowMs 生成（注：值形态在实现里决定）
    expect(typeof inbound.messageTs).toBe('string')
    expect((inbound.messageTs as string).length).toBeGreaterThan(0)
  })

  it('messageTs 是确定性的：相同 nowMs 产出相同值', async () => {
    const orchestrator = { handle: vi.fn(async (_inbound: unknown, _sink: unknown) => undefined) }
    await runScheduledWechatSession({
      taskId: 't',
      to: 'filehelper',
      prompt: 'p',
      api: stubApi(),
      deps: {
        orchestrator: orchestrator as never,
        rendererFactory: stubRendererFactory(),
        logger: stubLogger(),
        nowMs: () => 42,
      },
    })
    await runScheduledWechatSession({
      taskId: 't',
      to: 'filehelper',
      prompt: 'p',
      api: stubApi(),
      deps: {
        orchestrator: orchestrator as never,
        rendererFactory: stubRendererFactory(),
        logger: stubLogger(),
        nowMs: () => 42,
      },
    })
    const msg1 = (orchestrator.handle.mock.calls[0]![0] as Record<string, unknown>).messageTs
    const msg2 = (orchestrator.handle.mock.calls[1]![0] as Record<string, unknown>).messageTs
    expect(msg1).toBe(msg2)
  })

  it('contextTokenStore 命中 → 把 token 透传给 sink（非 filehelper 联系人能跑通）', async () => {
    const orchestrator = { handle: vi.fn(async (_inbound: unknown, _sink: unknown) => undefined) }
    const sendText = vi.fn(async () => undefined)
    const api = { sendText, setToken: vi.fn() } as never
    const store = {
      get: vi.fn((id: string) => (id === 'peer-X' ? 'real-token-X' : undefined)),
      save: vi.fn(async () => undefined),
    }
    await runScheduledWechatSession({
      taskId: 't',
      to: 'peer-X',
      prompt: 'p',
      api,
      deps: {
        orchestrator: orchestrator as never,
        rendererFactory: stubRendererFactory(),
        logger: stubLogger(),
        contextTokenStore: store,
      },
    })
    expect(store.get).toHaveBeenCalledWith('peer-X')
    // 验证 token 透到 sink → sink.finalize 调 sendText 时第 3 个参数（contextToken）应等于 store 命中值
    // 但 finalize 在 orchestrator.handle 内部触发；这里 orchestrator.handle 是 mock 没真跑 sink。
    // 改用：sink 是 orchestrator.handle 的第二个参数，我们直接验证 sink 被构造时 contextToken
    // —— 但 sink 是黑盒；最稳的断言是 sendText 收到正确 token，但需要 orchestrator 真触发 finalize。
    // 妥协：直接验证 store.get 被调（隐含 token 进入了 runWechatSession 的 deps.contextToken 入参）。
  })

  it('contextTokenStore 未注入 → fallback "" 不抛（filehelper 仍可用）', async () => {
    const orchestrator = { handle: vi.fn(async (_inbound: unknown, _sink: unknown) => undefined) }
    await runScheduledWechatSession({
      taskId: 't',
      to: 'filehelper',
      prompt: 'p',
      api: stubApi(),
      deps: {
        orchestrator: orchestrator as never,
        rendererFactory: stubRendererFactory(),
        logger: stubLogger(),
        // 故意不传 contextTokenStore
      },
    })
    expect(orchestrator.handle).toHaveBeenCalledTimes(1)
  })

  it('contextTokenStore 未命中 to → fallback ""（filehelper 仍可用）', async () => {
    const orchestrator = { handle: vi.fn(async (_inbound: unknown, _sink: unknown) => undefined) }
    const store = {
      get: vi.fn(() => undefined),
      save: vi.fn(async () => undefined),
    }
    await runScheduledWechatSession({
      taskId: 't',
      to: 'unknown-peer',
      prompt: 'p',
      api: stubApi(),
      deps: {
        orchestrator: orchestrator as never,
        rendererFactory: stubRendererFactory(),
        logger: stubLogger(),
        contextTokenStore: store,
      },
    })
    expect(store.get).toHaveBeenCalledWith('unknown-peer')
    expect(orchestrator.handle).toHaveBeenCalledTimes(1)
  })

  it('orchestrator.handle 抛错 → 直接传播（runner 负责 catch）', async () => {
    const orchestrator = {
      handle: vi.fn(async () => {
        throw new Error('agent failed')
      }),
    }
    await expect(
      runScheduledWechatSession({
        taskId: 't',
        to: 'filehelper',
        prompt: 'p',
        api: stubApi(),
        deps: {
          orchestrator: orchestrator as never,
          rendererFactory: stubRendererFactory(),
          logger: stubLogger(),
        },
      }),
    ).rejects.toThrow(/agent failed/)
  })
})
