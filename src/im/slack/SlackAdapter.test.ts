import { describe, expect, it } from 'vitest'
import { createSlackAdapter } from './SlackAdapter.ts'
import type { ConversationOrchestrator } from '@/orchestrator/ConversationOrchestrator.ts'
import type { Logger } from '@/logger/logger.ts'

function stubLogger(): Logger {
  const l: Logger = {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
    withTag: () => stubLogger(),
  }
  return l
}

describe('SlackAdapter', () => {
  it('构造不抛（真 mention 链路由 mvp.test.ts 覆盖）', () => {
    const orchestrator: ConversationOrchestrator = {
      handle: async () => {},
    }
    const adapter = createSlackAdapter({
      orchestrator,
      logger: stubLogger(),
      botToken: 'xoxb-test-token',
      appToken: 'xapp-test-token',
      signingSecret: 'secret-test-value',
    })
    expect(adapter.id).toBe('slack')
    expect(typeof adapter.start).toBe('function')
    expect(typeof adapter.stop).toBe('function')
  })
})
