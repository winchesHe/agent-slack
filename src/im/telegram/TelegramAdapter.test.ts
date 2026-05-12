import { describe, it, expect, vi } from 'vitest'
import { createTelegramAdapter } from './TelegramAdapter.ts'
import type { TelegramApi } from './TelegramApi.ts'
import type { TelegramRenderer } from './TelegramRenderer.ts'
import type { ConversationOrchestrator } from '@/orchestrator/ConversationOrchestrator.ts'

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

const stubOrchestrator = {
  handle: vi.fn(async () => {}),
} as unknown as ConversationOrchestrator

describe('createTelegramAdapter', () => {
  it('start 调 getMe + 输出 botUsername', async () => {
    const getMe = vi.fn(async () => ({
      id: 1,
      is_bot: true,
      username: 'foo',
      first_name: 'Foo',
    }))
    const api = { getMe, sendMessage: vi.fn() } as unknown as TelegramApi
    const { adapter } = createTelegramAdapter({
      api,
      orchestrator: stubOrchestrator,
      rendererFactory: () => stubRenderer,
      logger: fakeLogger,
    })
    await adapter.start()
    expect(getMe).toHaveBeenCalledTimes(1)
  })

  it('start getMe 失败仅 warn 不 throw', async () => {
    const getMe = vi.fn(async () => {
      throw new Error('Unauthorized')
    })
    const api = { getMe, sendMessage: vi.fn() } as unknown as TelegramApi
    const { adapter } = createTelegramAdapter({
      api,
      orchestrator: stubOrchestrator,
      rendererFactory: () => stubRenderer,
      logger: fakeLogger,
    })
    await expect(adapter.start()).resolves.not.toThrow()
  })

  it('start 幂等：多次调用只 getMe 一次', async () => {
    const getMe = vi.fn(async () => ({ id: 1, is_bot: true }))
    const api = { getMe, sendMessage: vi.fn() } as unknown as TelegramApi
    const { adapter } = createTelegramAdapter({
      api,
      orchestrator: stubOrchestrator,
      rendererFactory: () => stubRenderer,
      logger: fakeLogger,
    })
    await adapter.start()
    await adapter.start()
    expect(getMe).toHaveBeenCalledTimes(1)
  })

  it('id = telegram', () => {
    const api = { getMe: vi.fn(), sendMessage: vi.fn() } as unknown as TelegramApi
    const { adapter } = createTelegramAdapter({
      api,
      orchestrator: stubOrchestrator,
      rendererFactory: () => stubRenderer,
      logger: fakeLogger,
    })
    expect(adapter.id).toBe('telegram')
  })

  it('scheduledHook.run 调 orchestrator.handle', async () => {
    const handle = vi.fn(async () => {})
    const orchestrator = { handle } as unknown as ConversationOrchestrator
    const api = {
      getMe: vi.fn(),
      sendMessage: vi.fn(async () => {}),
    } as unknown as TelegramApi
    const { scheduledHook } = createTelegramAdapter({
      api,
      orchestrator,
      rendererFactory: () => stubRenderer,
      logger: fakeLogger,
    })
    await scheduledHook.run({ taskId: 't', to: '1', prompt: 'p' })
    expect(handle).toHaveBeenCalledTimes(1)
  })
})
