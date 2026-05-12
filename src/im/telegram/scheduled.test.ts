import { describe, it, expect, vi } from 'vitest'
import { runScheduledTelegramSession } from './scheduled.ts'
import type { TelegramApi } from './TelegramApi.ts'
import type { TelegramRenderer } from './TelegramRenderer.ts'
import type { ConversationOrchestrator } from '@/orchestrator/ConversationOrchestrator.ts'
import type { InboundMessage } from '@/im/types.ts'

const fakeLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  withTag: () => fakeLogger,
} as never

const stubRenderer: TelegramRenderer = {
  onEvent: () => {},
  flush: () => [],
  currentProgressHtml: () => '⏳ test',
  STARTING_MESSAGE: '⏳ test',
}
const stubApi = {
  sendMessage: async () => {},
  getMe: async () => ({ id: 1, is_bot: true }),
} as unknown as TelegramApi

describe('runScheduledTelegramSession', () => {
  it('构造正确的 InboundMessage（imProvider/channelId/threadTs/userId/userName/text）', async () => {
    const captured: { inbound?: InboundMessage } = {}
    const orchestrator = {
      handle: vi.fn(async (input: InboundMessage) => {
        captured.inbound = input
      }),
    } as unknown as ConversationOrchestrator

    await runScheduledTelegramSession({
      taskId: 'demo',
      to: '12345',
      prompt: 'hi',
      api: stubApi,
      deps: {
        orchestrator,
        rendererFactory: () => stubRenderer,
        logger: fakeLogger,
        nowMs: () => 1700000000000,
      },
    })

    expect(captured.inbound).toMatchObject({
      imProvider: 'telegram',
      channelId: '12345',
      channelName: '12345',
      threadTs: '12345',
      userId: 'scheduler',
      userName: 'scheduler',
      text: 'hi',
      messageTs: 'scheduled-demo-1700000000000',
    })
    expect(captured.inbound?.confirmSender).toBeUndefined()
  })

  it('orchestrator.handle 被调一次', async () => {
    const handle = vi.fn(async () => {})
    const orchestrator = { handle } as unknown as ConversationOrchestrator
    await runScheduledTelegramSession({
      taskId: 't',
      to: '1',
      prompt: 'p',
      api: stubApi,
      deps: { orchestrator, rendererFactory: () => stubRenderer, logger: fakeLogger },
    })
    expect(handle).toHaveBeenCalledTimes(1)
  })
})
