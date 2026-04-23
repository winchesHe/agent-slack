import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createSlackAdapter } from './SlackAdapter.ts'
import type { ConversationOrchestrator } from '@/orchestrator/ConversationOrchestrator.ts'
import type { SlackRenderer } from './SlackRenderer.ts'
import type { Logger } from '@/logger/logger.ts'
import { AbortRegistry } from '@/orchestrator/AbortRegistry.ts'
import { SessionRunQueue } from '@/orchestrator/SessionRunQueue.ts'

type SlackEventHandler = (args: {
  event: Record<string, unknown>
  client: MockSlackClient
}) => Promise<void>

interface MockSlackClient {
  conversations: {
    info: ReturnType<typeof vi.fn>
  }
  users: {
    info: ReturnType<typeof vi.fn>
  }
  reactions: {
    add: ReturnType<typeof vi.fn>
  }
}

const boltMock = vi.hoisted(() => {
  const handlers = new Map<string, SlackEventHandler>()
  const actionHandlers: Array<{
    pattern: string | RegExp
    handler: (args: Record<string, unknown>) => Promise<void>
  }> = []
  const app = {
    event: vi.fn((name: string, handler: SlackEventHandler) => {
      handlers.set(name, handler)
    }),
    action: vi.fn(
      (
        pattern: string | RegExp,
        handler: (args: Record<string, unknown>) => Promise<void>,
      ) => {
        actionHandlers.push({ pattern, handler })
      },
    ),
    start: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
  }

  return {
    App: vi.fn(() => app),
    app,
    handlers,
    actionHandlers,
  }
})

vi.mock('@slack/bolt', () => ({
  App: boltMock.App,
}))

function stubLogger(overrides: Partial<Logger> = {}): Logger {
  const l: Logger = {
    trace: () => {},
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
    withTag: () => stubLogger(overrides),
    ...overrides,
  }
  return l
}

function stubRenderer(): SlackRenderer {
  const noop = async () => {}
  return {
    addAck: noop,
    removeAck: noop,
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

function createClient(): MockSlackClient {
  return {
    conversations: {
      info: vi.fn(async () => ({ channel: { name: 'general' } })),
    },
    users: {
      info: vi.fn(async () => ({ user: { real_name: 'Alice', name: 'alice' } })),
    },
    reactions: {
      add: vi.fn(async () => ({ ok: true })),
    },
  }
}

function createDeps(
  overrides: {
    orchestrator?: ConversationOrchestrator
    abortRegistry?: AbortRegistry<string>
    runQueue?: SessionRunQueue
    logger?: Logger
  } = {},
) {
  const orchestrator: ConversationOrchestrator =
    overrides.orchestrator ??
    ({
      handle: vi.fn(async () => {}),
    } satisfies ConversationOrchestrator)

  return {
    orchestrator,
    abortRegistry: overrides.abortRegistry ?? new AbortRegistry<string>(),
    runQueue: overrides.runQueue ?? new SessionRunQueue(),
    renderer: stubRenderer(),
    slackConfirm: {
      send: vi.fn(async () => {}),
      getCallback: vi.fn(() => undefined),
    },
    logger: overrides.logger ?? stubLogger(),
    botToken: 'xoxb-test-token',
    appToken: 'xapp-test-token',
    signingSecret: 'secret-test-value',
  }
}

function getRegisteredHandler(name: string): SlackEventHandler {
  const handler = boltMock.handlers.get(name)
  if (!handler) {
    throw new Error(`未注册 handler: ${name}`)
  }
  return handler
}

describe('SlackAdapter', () => {
  beforeEach(() => {
    boltMock.handlers.clear()
    boltMock.actionHandlers.length = 0
    vi.clearAllMocks()
  })

  it('构造不抛 + 暴露 id/start/stop 接口', () => {
    const adapter = createSlackAdapter(createDeps())
    expect(adapter.id).toBe('slack')
    expect(typeof adapter.start).toBe('function')
    expect(typeof adapter.stop).toBe('function')
  })

  it('reaction_added 为 stop_sign 且 item.type=message 时调用 abortRegistry.abort', async () => {
    const abortRegistry = new AbortRegistry<string>()
    const abortSpy = vi.spyOn(abortRegistry, 'abort')

    createSlackAdapter(createDeps({ abortRegistry }))
    const handler = getRegisteredHandler('reaction_added')

    await handler({
      event: {
        reaction: 'stop_sign',
        item: { type: 'message', ts: 'm-stop' },
      },
      client: createClient(),
    })

    expect(abortSpy).toHaveBeenCalledTimes(1)
    expect(abortSpy).toHaveBeenCalledWith('m-stop', 'user_stop_reaction')
  })

  it('reaction_added 为其他 reaction 时不调用 abortRegistry.abort', async () => {
    const abortRegistry = new AbortRegistry<string>()
    const abortSpy = vi.spyOn(abortRegistry, 'abort')

    createSlackAdapter(createDeps({ abortRegistry }))
    const handler = getRegisteredHandler('reaction_added')

    await handler({
      event: {
        reaction: 'thumbsup',
        item: { type: 'message', ts: 'm-ignore' },
      },
      client: createClient(),
    })

    expect(abortSpy).not.toHaveBeenCalled()
  })

  it('reaction_added 为 stop_sign 但 item 不是 message 时不调用 abortRegistry.abort', async () => {
    const abortRegistry = new AbortRegistry<string>()
    const abortSpy = vi.spyOn(abortRegistry, 'abort')

    createSlackAdapter(createDeps({ abortRegistry }))
    const handler = getRegisteredHandler('reaction_added')

    await handler({
      event: {
        reaction: 'stop_sign',
        item: { type: 'file', ts: 'f-ignore' },
      },
      client: createClient(),
    })

    expect(abortSpy).not.toHaveBeenCalled()
  })

  it('app_mention 且同 session 已有任务时，对原消息加 hourglass_flowing_sand reaction', async () => {
    const client = createClient()
    const runQueue = new SessionRunQueue()
    vi.spyOn(runQueue, 'queueDepth').mockReturnValue(1)
    const orchestrator: ConversationOrchestrator = {
      handle: vi.fn(async () => {}),
    }

    createSlackAdapter(createDeps({ runQueue, orchestrator }))
    const handler = getRegisteredHandler('app_mention')

    await handler({
      event: {
        channel: 'C1',
        thread_ts: 't1',
        ts: 'm1',
        user: 'U1',
        text: '<@BOT> hi',
      },
      client,
    })

    expect(runQueue.queueDepth).toHaveBeenCalledWith('slack:C1:t1')
    expect(client.reactions.add).toHaveBeenCalledWith({
      channel: 'C1',
      timestamp: 'm1',
      name: 'hourglass_flowing_sand',
    })
    expect(orchestrator.handle).toHaveBeenCalledTimes(1)
  })

  it('缺 renderer 参数 → TypeScript 编译报错（type-level）', () => {
    // 这是 type-level 约束：如果有人忘了传 renderer，`pnpm tsc` 就会报错。
    // @ts-expect-error renderer 必填
    createSlackAdapter({
      orchestrator: createDeps().orchestrator,
      abortRegistry: new AbortRegistry<string>(),
      runQueue: new SessionRunQueue(),
      logger: stubLogger(),
      botToken: 'xoxb',
      appToken: 'xapp',
      signingSecret: 'ss',
    })
  })
})
