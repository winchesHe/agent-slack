import { describe, expect, it, vi } from 'vitest'
import { createSlackAdapter } from './SlackAdapter.ts'
import type { ConversationOrchestrator } from '@/orchestrator/ConversationOrchestrator.ts'
import type { SlackRenderer } from './SlackRenderer.ts'
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

function stubRenderer(): SlackRenderer {
  // 全部方法默认 no-op；Task 6.2 集成测试再验证调用序列
  const noop = async () => {}
  return {
    addAck: noop,
    addDone: noop,
    addError: noop,
    addStopped: noop,
    setStatus: noop,
    clearStatus: noop,
    upsertProgressMessage: async () => undefined,
    finalizeProgressMessageDone: noop,
    finalizeProgressMessageStopped: noop,
    finalizeProgressMessageError: noop,
    deleteProgressMessage: noop,
    postThreadReply: noop,
    postSessionUsage: noop,
  }
}

describe('SlackAdapter', () => {
  const orchestrator: ConversationOrchestrator = {
    handle: vi.fn(async () => {}),
  }

  it('构造不抛 + 暴露 id/start/stop 接口（真 mention 链路由集成测试覆盖）', () => {
    const adapter = createSlackAdapter({
      orchestrator,
      renderer: stubRenderer(),
      logger: stubLogger(),
      botToken: 'xoxb-test-token',
      appToken: 'xapp-test-token',
      signingSecret: 'secret-test-value',
    })
    expect(adapter.id).toBe('slack')
    expect(typeof adapter.start).toBe('function')
    expect(typeof adapter.stop).toBe('function')
  })

  it('缺 renderer 参数 → TypeScript 编译报错（type-level）', () => {
    // 这是 type-level 约束：如果有人忘了传 renderer，`pnpm tsc` 就会报错。
    // @ts-expect-error renderer 必填
    createSlackAdapter({
      orchestrator,
      logger: stubLogger(),
      botToken: 'xoxb', appToken: 'xapp', signingSecret: 'ss',
    })
  })

  it('可选 workspaceLabel 不影响构造', () => {
    const adapter = createSlackAdapter({
      orchestrator,
      renderer: stubRenderer(),
      logger: stubLogger(),
      botToken: 'xoxb', appToken: 'xapp', signingSecret: 'ss',
      workspaceLabel: 'my-workspace',
    })
    expect(adapter.id).toBe('slack')
  })
})
