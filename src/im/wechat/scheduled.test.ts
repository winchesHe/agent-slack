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
