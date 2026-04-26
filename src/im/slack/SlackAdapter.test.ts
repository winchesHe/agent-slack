import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createSlackAdapter } from './SlackAdapter.ts'
import type { ConversationOrchestrator } from '@/orchestrator/ConversationOrchestrator.ts'
import type { SlackRenderer } from './SlackRenderer.ts'
import type { Logger } from '@/logger/logger.ts'
import type { SessionStore } from '@/store/SessionStore.ts'
import { parseChannelTasksConfig, type ChannelTasksConfig } from '@/channelTasks/config.ts'
import type { ChannelTaskTriggerLedger } from '@/channelTasks/triggerLedger.ts'
import { AbortRegistry } from '@/orchestrator/AbortRegistry.ts'
import { SessionRunQueue } from '@/orchestrator/SessionRunQueue.ts'

type SlackEventHandler = (args: {
  event: Record<string, unknown>
  client: MockSlackClient
}) => Promise<void>

interface MockSlackClient {
  conversations: {
    info: ReturnType<typeof vi.fn>
    replies: ReturnType<typeof vi.fn>
  }
  users: {
    info: ReturnType<typeof vi.fn>
  }
  reactions: {
    add: ReturnType<typeof vi.fn>
  }
  auth: {
    test: ReturnType<typeof vi.fn>
  }
  chat: {
    getPermalink: ReturnType<typeof vi.fn>
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
      (pattern: string | RegExp, handler: (args: Record<string, unknown>) => Promise<void>) => {
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
      replies: vi.fn(async () => ({ messages: [] })),
    },
    users: {
      info: vi.fn(async () => ({ user: { real_name: 'Alice', name: 'alice' } })),
    },
    reactions: {
      add: vi.fn(async () => ({ ok: true })),
    },
    auth: {
      test: vi.fn(async () => ({ user_id: 'U_AGENT' })),
    },
    chat: {
      getPermalink: vi.fn(async () => ({
        permalink: 'https://example.slack.com/archives/C1/p1000000001',
      })),
    },
  }
}

function createDeps(
  overrides: {
    orchestrator?: ConversationOrchestrator
    abortRegistry?: AbortRegistry<string>
    runQueue?: SessionRunQueue
    logger?: Logger
    channelTasks?: {
      config: ChannelTasksConfig
      ledger: ChannelTaskTriggerLedger
    }
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
    sessionStore: stubSessionStore(),
    ...(overrides.channelTasks ? { channelTasks: overrides.channelTasks } : {}),
    logger: overrides.logger ?? stubLogger(),
    botToken: 'xoxb-test-token',
    appToken: 'xapp-test-token',
    signingSecret: 'secret-test-value',
  }
}

function stubChannelTaskLedger(recordIfNew = true): ChannelTaskTriggerLedger {
  return {
    load: vi.fn(async () => []),
    hasTriggered: vi.fn(async () => !recordIfNew),
    append: vi.fn(async () => {}),
    recordIfNew: vi.fn(async () => recordIfNew),
  }
}

function userChannelTaskConfig(overrides: Record<string, unknown> = {}): ChannelTasksConfig {
  return parseChannelTasksConfig({
    enabled: true,
    rules: [
      {
        id: 'rule-1',
        channelIds: ['C1'],
        source: { userIds: ['U1'] },
        task: { prompt: '请处理触发消息' },
        ...overrides,
      },
    ],
  })
}

function stubSessionStore() {
  return {
    getOrCreate: vi.fn(),
    getMeta: vi.fn(),
    loadMessages: vi.fn(),
    appendMessage: vi.fn(),
    appendEvent: vi.fn(async () => {}),
    accumulateUsage: vi.fn(),
    accumulateCost: vi.fn(),
    setStatus: vi.fn(),
  } as unknown as SessionStore
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
    expect(boltMock.App).toHaveBeenCalledWith(
      expect.objectContaining({
        ignoreSelf: false,
      }),
    )
  })

  it('未注入 channelTasks 时不注册 message handler', () => {
    createSlackAdapter(createDeps())
    expect(boltMock.handlers.has('message')).toBe(false)
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

  it('app_mention 来自当前 agent 自身时跳过，避免关闭 Bolt ignoreSelf 后自触发', async () => {
    const client = createClient()
    const orchestrator: ConversationOrchestrator = {
      handle: vi.fn(async () => {}),
    }

    createSlackAdapter(createDeps({ orchestrator }))
    const handler = getRegisteredHandler('app_mention')

    await handler({
      event: {
        channel: 'C1',
        ts: 'm-self',
        user: 'U_AGENT',
        text: '<@U_AGENT> self ping',
      },
      client,
    })

    expect(client.auth.test).toHaveBeenCalledTimes(1)
    expect(orchestrator.handle).not.toHaveBeenCalled()
  })

  it('message 命中 user channel task 后在触发消息 thread 调用 orchestrator', async () => {
    const client = createClient()
    const ledger = stubChannelTaskLedger()
    const orchestrator: ConversationOrchestrator = {
      handle: vi.fn(async () => {}),
    }

    createSlackAdapter(
      createDeps({
        orchestrator,
        channelTasks: {
          config: userChannelTaskConfig(),
          ledger,
        },
      }),
    )
    const handler = getRegisteredHandler('message')

    await handler({
      event: {
        channel: 'C1',
        ts: '1000.0001',
        user: 'U1',
        text: '请看这条消息',
      },
      client,
    })

    expect(ledger.recordIfNew).toHaveBeenCalledWith(
      expect.objectContaining({
        ruleId: 'rule-1',
        channelId: 'C1',
        messageTs: '1000.0001',
        threadTs: '1000.0001',
        actorType: 'user',
        actorId: 'U1',
        sessionId: 'slack:C1:1000.0001',
      }),
    )
    expect(orchestrator.handle).toHaveBeenCalledTimes(1)
    const inbound = vi.mocked(orchestrator.handle).mock.calls[0]?.[0]
    expect(inbound).toMatchObject({
      imProvider: 'slack',
      channelId: 'C1',
      channelName: 'general',
      threadTs: '1000.0001',
      userId: 'U1',
      userName: 'Alice',
      messageTs: '1000.0001',
    })
    expect(inbound?.text).toContain('[频道任务触发: rule-1]')
    expect(inbound?.text).toContain('请处理触发消息')
    expect(inbound?.text).toContain('原始 Slack 消息：\n请看这条消息')
    expect(client.chat.getPermalink).toHaveBeenCalledWith({
      channel: 'C1',
      message_ts: '1000.0001',
    })
  })

  it('message 重复触发时按 ledger 跳过 orchestrator', async () => {
    const ledger = stubChannelTaskLedger(false)
    const orchestrator: ConversationOrchestrator = {
      handle: vi.fn(async () => {}),
    }

    createSlackAdapter(
      createDeps({
        orchestrator,
        channelTasks: {
          config: userChannelTaskConfig(),
          ledger,
        },
      }),
    )
    const handler = getRegisteredHandler('message')

    await handler({
      event: {
        channel: 'C1',
        ts: '1000.0001',
        user: 'U1',
        text: '重复消息',
      },
      client: createClient(),
    })

    expect(orchestrator.handle).not.toHaveBeenCalled()
  })

  it('message 命中 bot channel task 时使用 bot 身份并回复原 thread', async () => {
    const ledger = stubChannelTaskLedger()
    const orchestrator: ConversationOrchestrator = {
      handle: vi.fn(async () => {}),
    }
    const config = userChannelTaskConfig({
      source: {
        includeUserMessages: false,
        includeBotMessages: true,
        userIds: [],
        botIds: ['B1'],
        appIds: [],
      },
      message: {
        allowSubtypes: ['bot_message'],
        includeThreadReplies: true,
      },
    })

    createSlackAdapter(
      createDeps({
        orchestrator,
        channelTasks: { config, ledger },
      }),
    )
    const handler = getRegisteredHandler('message')

    await handler({
      event: {
        channel: 'C1',
        ts: '1000.0002',
        thread_ts: '1000.0001',
        subtype: 'bot_message',
        bot_id: 'B1',
        app_id: 'A1',
        username: 'Jenkins',
        text: 'build failed',
      },
      client: createClient(),
    })

    expect(orchestrator.handle).toHaveBeenCalledTimes(1)
    const inbound = vi.mocked(orchestrator.handle).mock.calls[0]?.[0]
    expect(inbound).toMatchObject({
      threadTs: '1000.0001',
      userId: 'B1',
      userName: 'Jenkins',
      messageTs: '1000.0002',
    })
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
