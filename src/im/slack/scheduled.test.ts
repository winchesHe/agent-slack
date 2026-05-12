import { describe, expect, it, vi } from 'vitest'
import type { WebClient } from '@slack/web-api'
import { runScheduledSlackSession } from './scheduled.ts'

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

function stubRenderer() {
  return { kind: 'slack-renderer' } as never
}

function stubWebClient(rootTs = '1717000000.000001'): WebClient {
  const postMessage = vi.fn(async () => ({ ok: true, ts: rootTs, channel: 'C123' }) as never)
  return { chat: { postMessage } } as never as WebClient
}

describe('runScheduledSlackSession', () => {
  it('先 postMessage 起根帖，再用 root ts 作为 threadTs/messageTs 调 orchestrator.handle', async () => {
    const web = stubWebClient('1717000000.000001')
    const orchestrator = { handle: vi.fn(async (_inbound: unknown, _sink: unknown) => undefined) }
    await runScheduledSlackSession({
      taskId: 'daily-standup',
      channelId: 'C0123456789',
      prompt: '请总结昨日变更',
      web,
      deps: {
        orchestrator: orchestrator as never,
        renderer: stubRenderer(),
        logger: stubLogger(),
      },
    })

    expect(web.chat.postMessage).toHaveBeenCalledTimes(1)
    expect(web.chat.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: 'C0123456789',
        text: expect.stringContaining('战略级抓手 · aihot-咨询'),
      }),
    )

    expect(orchestrator.handle).toHaveBeenCalledTimes(1)
    const call = orchestrator.handle.mock.calls[0]!
    const inbound = call[0] as Record<string, unknown>
    const sink = call[1]
    expect(inbound).toMatchObject({
      imProvider: 'slack',
      channelId: 'C0123456789',
      threadTs: '1717000000.000001',
      messageTs: '1717000000.000001',
      userId: 'scheduler',
      userName: 'scheduler',
      text: '请总结昨日变更',
    })
    expect(inbound.confirmSender).toBeUndefined()
    expect(sink).toBeDefined()
  })

  it('channelName 默认回落到 channelId（spec §5.2 不主动 resolve）', async () => {
    const web = stubWebClient()
    const orchestrator = { handle: vi.fn(async (_inbound: unknown, _sink: unknown) => undefined) }
    await runScheduledSlackSession({
      taskId: 't',
      channelId: 'C0000000001',
      prompt: 'hi',
      web,
      deps: { orchestrator: orchestrator as never, renderer: stubRenderer(), logger: stubLogger() },
    })
    const call2 = orchestrator.handle.mock.calls[0]!
    expect((call2[0] as Record<string, unknown>).channelName).toBe('C0000000001')
  })

  it('postMessage 失败（ok=false） → 抛 root-post-failed', async () => {
    const postMessage = vi.fn(async () => ({ ok: false }) as never)
    const web = { chat: { postMessage } } as never as WebClient
    const orchestrator = { handle: vi.fn(async (_inbound: unknown, _sink: unknown) => undefined) }
    await expect(
      runScheduledSlackSession({
        taskId: 't',
        channelId: 'C1',
        prompt: 'p',
        web,
        deps: {
          orchestrator: orchestrator as never,
          renderer: stubRenderer(),
          logger: stubLogger(),
        },
      }),
    ).rejects.toThrow(/root-post-failed/)
    expect(orchestrator.handle).not.toHaveBeenCalled()
  })

  it('postMessage throws → 透传错误（runner 负责 catch）', async () => {
    const postMessage = vi.fn(async () => {
      throw new Error('network down')
    })
    const web = { chat: { postMessage } } as never as WebClient
    const orchestrator = { handle: vi.fn(async (_inbound: unknown, _sink: unknown) => undefined) }
    await expect(
      runScheduledSlackSession({
        taskId: 't',
        channelId: 'C1',
        prompt: 'p',
        web,
        deps: {
          orchestrator: orchestrator as never,
          renderer: stubRenderer(),
          logger: stubLogger(),
        },
      }),
    ).rejects.toThrow(/network down/)
    expect(orchestrator.handle).not.toHaveBeenCalled()
  })

  it('orchestrator.handle 抛错 → 直接传播', async () => {
    const web = stubWebClient()
    const orchestrator = {
      handle: vi.fn(async () => {
        throw new Error('agent failed')
      }),
    }
    await expect(
      runScheduledSlackSession({
        taskId: 't',
        channelId: 'C1',
        prompt: 'p',
        web,
        deps: {
          orchestrator: orchestrator as never,
          renderer: stubRenderer(),
          logger: stubLogger(),
        },
      }),
    ).rejects.toThrow(/agent failed/)
  })
})
