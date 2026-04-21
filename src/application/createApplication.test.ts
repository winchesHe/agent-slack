import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApplication } from './createApplication.ts'
import { AbortRegistry } from '@/orchestrator/AbortRegistry.ts'
import { SessionRunQueue } from '@/orchestrator/SessionRunQueue.ts'

const mocks = vi.hoisted(() => {
  const logger = {
    withTag: vi.fn(() => logger),
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }

  const slackAdapter = {
    id: 'slack' as const,
    start: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
  }

  return {
    createOpenAICompatible: vi.fn(() => ({
      chatModel: vi.fn((modelName: string) => ({ modelName })),
    })),
    loadWorkspaceContext: vi.fn(async () => ({
      cwd: '/mock-workspace',
      paths: {
        rootDir: '/mock-workspace/.agent-slack',
      },
      config: {
        agent: {
          model: 'test-model',
          maxSteps: 8,
        },
      },
      systemPrompt: 'system prompt',
      skills: [],
    })),
    createSessionStore: vi.fn(() => ({ kind: 'session-store' })),
    createMemoryStore: vi.fn(() => ({ kind: 'memory-store' })),
    createLogger: vi.fn(() => logger),
    createRedactor: vi.fn(() => (value: unknown) => value),
    createAiSdkExecutor: vi.fn(() => ({
      execute: vi.fn(),
      drain: vi.fn(async () => {}),
    })),
    buildBuiltinTools: vi.fn(() => ({ bash: { description: 'mock tool' } })),
    createConversationOrchestrator: vi.fn((_args: unknown) => ({
      handle: vi.fn(async () => {}),
    })),
    createSlackRenderer: vi.fn(() => ({
      addAck: vi.fn(async () => {}),
      removeAck: vi.fn(async () => {}),
      addDone: vi.fn(async () => {}),
      addError: vi.fn(async () => {}),
      addStopped: vi.fn(async () => {}),
      setStatus: vi.fn(async () => {}),
      clearStatus: vi.fn(async () => {}),
      upsertProgressMessage: vi.fn(async () => undefined),
      finalizeProgressMessageDone: vi.fn(async () => {}),
      finalizeProgressMessageStopped: vi.fn(async () => {}),
      finalizeProgressMessageError: vi.fn(async () => {}),
      deleteProgressMessage: vi.fn(async () => {}),
      postThreadReply: vi.fn(async () => {}),
      postSessionUsage: vi.fn(async () => {}),
    })),
    createSlackAdapter: vi.fn((_args: unknown) => slackAdapter),
    logger,
    slackAdapter,
  }
})

vi.mock('@ai-sdk/openai-compatible', () => ({
  createOpenAICompatible: mocks.createOpenAICompatible,
}))

vi.mock('@/workspace/WorkspaceContext.ts', () => ({
  loadWorkspaceContext: mocks.loadWorkspaceContext,
}))

vi.mock('@/store/SessionStore.ts', () => ({
  createSessionStore: mocks.createSessionStore,
}))

vi.mock('@/store/MemoryStore.ts', () => ({
  createMemoryStore: mocks.createMemoryStore,
}))

vi.mock('@/logger/logger.ts', () => ({
  createLogger: mocks.createLogger,
}))

vi.mock('@/logger/redactor.ts', () => ({
  createRedactor: mocks.createRedactor,
}))

vi.mock('@/agent/AiSdkExecutor.ts', () => ({
  createAiSdkExecutor: mocks.createAiSdkExecutor,
}))

vi.mock('@/agent/tools/index.ts', () => ({
  buildBuiltinTools: mocks.buildBuiltinTools,
}))

vi.mock('@/orchestrator/ConversationOrchestrator.ts', () => ({
  createConversationOrchestrator: mocks.createConversationOrchestrator,
}))

vi.mock('@/im/slack/SlackRenderer.ts', () => ({
  createSlackRenderer: mocks.createSlackRenderer,
}))

vi.mock('@/im/slack/SlackAdapter.ts', () => ({
  createSlackAdapter: mocks.createSlackAdapter,
}))

describe('createApplication', () => {
  const originalEnv = process.env

  beforeEach(() => {
    vi.clearAllMocks()
    process.env = {
      ...originalEnv,
      SLACK_BOT_TOKEN: 'xoxb-test',
      SLACK_APP_TOKEN: 'xapp-test',
      SLACK_SIGNING_SECRET: 'secret-test',
      LITELLM_BASE_URL: 'https://litellm.example.com',
      LITELLM_API_KEY: 'litellm-key',
      LOG_LEVEL: 'info',
    }
    delete process.env.AGENT_PROVIDER
    delete process.env.ANTHROPIC_API_KEY
    delete process.env.ANTHROPIC_BASE_URL
  })

  afterEach(() => {
    process.env = originalEnv
  })

  it('应用内部复用同一组 runQueue 和 abortRegistry 完成依赖注入', async () => {
    const app = await createApplication({ workspaceDir: '/workspace-under-test' })

    const orchestratorArgs = mocks.createConversationOrchestrator.mock.calls[0]?.[0] as
      | {
          runQueue: SessionRunQueue
          abortRegistry: AbortRegistry<string>
        }
      | undefined
    const slackAdapterArgs = mocks.createSlackAdapter.mock.calls[0]?.[0] as
      | {
          runQueue: SessionRunQueue
          abortRegistry: AbortRegistry<string>
        }
      | undefined

    expect(orchestratorArgs).toBeDefined()
    expect(slackAdapterArgs).toBeDefined()
    expect(orchestratorArgs?.runQueue).toBeInstanceOf(SessionRunQueue)
    expect(orchestratorArgs?.abortRegistry).toBeInstanceOf(AbortRegistry)
    expect(orchestratorArgs?.runQueue).toBe(slackAdapterArgs?.runQueue)
    expect(orchestratorArgs?.abortRegistry).toBe(slackAdapterArgs?.abortRegistry)

    await app.start()
    await app.stop()
    expect(mocks.slackAdapter.start).toHaveBeenCalledTimes(1)
    expect(mocks.slackAdapter.stop).toHaveBeenCalledTimes(1)
  })

  it('AGENT_PROVIDER 未设 → 走 litellm 分支并调用 createOpenAICompatible', async () => {
    await createApplication({ workspaceDir: '/workspace' })
    expect(mocks.createOpenAICompatible).toHaveBeenCalledWith({
      baseURL: 'https://litellm.example.com',
      apiKey: 'litellm-key',
      name: 'litellm',
    })
  })

  it('AGENT_PROVIDER=anthropic → 抛 ConfigError 文案含"暂未实装"', async () => {
    process.env.AGENT_PROVIDER = 'anthropic'
    process.env.ANTHROPIC_API_KEY = 'sk-ant-xxx'
    await expect(createApplication({ workspaceDir: '/workspace' })).rejects.toThrow(/暂未实装/)
  })

  it('AGENT_PROVIDER=anthropic 缺 ANTHROPIC_API_KEY → 抛 ConfigError', async () => {
    process.env.AGENT_PROVIDER = 'anthropic'
    await expect(createApplication({ workspaceDir: '/workspace' })).rejects.toThrow(
      /ANTHROPIC_API_KEY/,
    )
  })

  it('AGENT_PROVIDER=foo → 抛 ConfigError 文案含"非法 provider"', async () => {
    process.env.AGENT_PROVIDER = 'foo'
    await expect(createApplication({ workspaceDir: '/workspace' })).rejects.toThrow(/非法 provider/)
  })
})
