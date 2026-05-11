import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createApplication } from './createApplication.ts'
import { AbortRegistry } from '@/orchestrator/AbortRegistry.ts'
import { SessionRunQueue } from '@/orchestrator/SessionRunQueue.ts'
import { resolveWorkspacePaths } from '@/workspace/paths.ts'

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
  const slackHandle = {
    adapter: slackAdapter,
    scheduledHook: { run: vi.fn(async () => {}) },
  }
  const wechatAdapter = {
    id: 'wechat' as const,
    start: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
  }
  const wechatHandle = {
    adapter: wechatAdapter,
    scheduledHook: { run: vi.fn(async () => {}) },
    loadCredentialsOnly: vi.fn(async () => ({
      token: 'tok',
      baseUrl: 'https://x.example/',
      botId: '',
      userId: '',
    })),
  }
  const paths = {
    root: '/mock-workspace/.agent-slack',
    configFile: '/mock-workspace/.agent-slack/config.yaml',
    channelTasksFile: '/mock-workspace/.agent-slack/channel-tasks.yaml',
    systemFile: '/mock-workspace/.agent-slack/system.md',
    experienceFile: '/mock-workspace/.agent-slack/experience.md',
    channelTasksDir: '/mock-workspace/.agent-slack/channel-tasks',
    channelTaskTriggersFile: '/mock-workspace/.agent-slack/channel-tasks/triggers.jsonl',
    sessionsDir: '/mock-workspace/.agent-slack/sessions',
    memoryDir: '/mock-workspace/.agent-slack/memory',
    scheduledTasksFile: '/mock-workspace/.agent-slack/scheduled-tasks.yaml',
    scheduledTasksLogFile: '/mock-workspace/.agent-slack/logs/scheduled-tasks.jsonl',
    skillsDir: '/mock-workspace/.agent-slack/skills',
    logsDir: '/mock-workspace/.agent-slack/logs',
    daemonDir: '/mock-workspace/.agent-slack/daemon',
    daemonFile: '/mock-workspace/.agent-slack/daemon/daemon.json',
    daemonPidFile: '/mock-workspace/.agent-slack/daemon/daemon.pid',
    daemonLockFile: '/mock-workspace/.agent-slack/daemon/daemon.lock',
    dashboardFile: '/mock-workspace/.agent-slack/daemon/dashboard.json',
    globalRoot: '/mock-home/.agent-slack',
    globalEnv: '/mock-home/.agent-slack/.env',
    globalConfig: '/mock-home/.agent-slack/global.yaml',
    wechatDir: '/mock-workspace/.agent-slack/wechat',
    wechatCredentialsFile: '/mock-workspace/.agent-slack/wechat/credentials.json',
    wechatContextTokensFile: '/mock-workspace/.agent-slack/wechat/context-tokens.json',
    cwd: '/mock-workspace',
  }

  return {
    createOpenAICompatible: vi.fn(() => ({
      chatModel: vi.fn((modelName: string) => ({ modelName })),
    })),
    createAnthropic: vi.fn(() => ({
      languageModel: vi.fn((modelName: string) => ({ modelName, provider: 'anthropic' })),
    })),
    createOpenAI: vi.fn(() => ({
      responses: vi.fn((modelName: string) => ({ modelName, provider: 'openai-responses' })),
    })),
    loadWorkspaceContext: vi.fn(async () => ({
      cwd: '/mock-workspace',
      paths,
      config: {
        agent: {
          model: 'test-model',
          maxSteps: 8,
          provider: 'litellm' as 'litellm' | 'anthropic' | 'openai-responses',
          responses: { reasoningEffort: 'medium', reasoningSummary: 'auto' } as {
            reasoningEffort: 'low' | 'medium' | 'high'
            reasoningSummary: 'auto' | 'concise' | 'detailed'
          },
          context: { keepRecentToolResults: 20 } as { keepRecentToolResults: number },
        },
        im: {
          enabled: ['slack'] as Array<'slack' | 'wechat'>,
          wechat: {
            baseUrl: 'https://ilinkai.weixin.qq.com',
            cdnBaseUrl: 'https://novac2c.cdn.weixin.qq.com/c2c',
          },
        },
      },
      systemPrompt: 'system prompt',
      skills: [],
    })),
    createSessionStore: vi.fn(() => ({ kind: 'session-store' })),
    createMemoryStore: vi.fn(() => ({ kind: 'memory-store' })),
    createLogger: vi.fn(() => logger),
    createRedactor: vi.fn(() => (value: unknown) => value),
    createAiSdkExecutor: vi.fn((_deps: unknown) => ({
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
    createSlackAdapter: vi.fn((_args: unknown) => slackHandle),
    WechatApi: vi.fn(),
    createCredentialsStore: vi.fn(() => ({
      load: vi.fn(async () => undefined),
      save: vi.fn(async () => {}),
      clear: vi.fn(async () => {}),
    })),
    createWechatRenderer: vi.fn(() => ({
      onEvent: vi.fn(),
      flush: vi.fn(() => []),
      STARTING_MESSAGE: '开始处理...',
    })),
    createWechatAdapter: vi.fn((_args: unknown) => wechatHandle),
    logger,
    slackAdapter,
    wechatAdapter,
    paths,
  }
})

vi.mock('@ai-sdk/openai-compatible', () => ({
  createOpenAICompatible: mocks.createOpenAICompatible,
}))

vi.mock('@ai-sdk/anthropic', () => ({
  createAnthropic: mocks.createAnthropic,
}))

vi.mock('@ai-sdk/openai', () => ({
  createOpenAI: mocks.createOpenAI,
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

vi.mock('@/im/wechat/WechatApi.ts', () => ({
  WechatApi: mocks.WechatApi,
}))

vi.mock('@/im/wechat/CredentialsStore.ts', () => ({
  createCredentialsStore: mocks.createCredentialsStore,
}))

vi.mock('@/im/wechat/WechatRenderer.ts', () => ({
  createWechatRenderer: mocks.createWechatRenderer,
}))

vi.mock('@/im/wechat/WechatAdapter.ts', () => ({
  createWechatAdapter: mocks.createWechatAdapter,
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

  it('存在 channel-tasks.yaml 时注入 SlackAdapter channelTasks 依赖', async () => {
    const workspace = mkdtempSync(path.join(tmpdir(), 'app-channel-tasks-'))
    const paths = resolveWorkspacePaths(workspace)
    mkdirSync(paths.root, { recursive: true })
    writeFileSync(
      paths.channelTasksFile,
      [
        'version: 1',
        'enabled: true',
        'rules:',
        '  - id: rule-1',
        '    channelIds: [C1]',
        '    source:',
        '      userIds: [U1]',
        '    task:',
        '      prompt: 处理消息',
        '',
      ].join('\n'),
      'utf8',
    )
    mocks.loadWorkspaceContext.mockResolvedValueOnce({
      cwd: workspace,
      paths,
      config: {
        agent: {
          model: 'test-model',
          maxSteps: 8,
          provider: 'litellm' as const,
          responses: { reasoningEffort: 'medium', reasoningSummary: 'auto' } as const,
          context: { keepRecentToolResults: 20 } as { keepRecentToolResults: number },
        },
        im: {
          enabled: ['slack'] as Array<'slack' | 'wechat'>,
          wechat: {
            baseUrl: 'https://ilinkai.weixin.qq.com',
            cdnBaseUrl: 'https://novac2c.cdn.weixin.qq.com/c2c',
          },
        },
      },
      systemPrompt: 'system prompt',
      skills: [],
    })

    await createApplication({ workspaceDir: workspace })

    const slackAdapterArgs = mocks.createSlackAdapter.mock.calls[0]?.[0] as
      | {
          channelTasks?: {
            config: { enabled: boolean; rules: Array<{ id: string }> }
            ledger: unknown
          }
        }
      | undefined
    expect(slackAdapterArgs?.channelTasks?.config.enabled).toBe(true)
    expect(slackAdapterArgs?.channelTasks?.config.rules[0]?.id).toBe('rule-1')
    expect(slackAdapterArgs?.channelTasks?.ledger).toBeDefined()
  })

  it('config 默认 provider=litellm → 调用 createOpenAICompatible', async () => {
    await createApplication({ workspaceDir: '/workspace' })
    expect(mocks.createOpenAICompatible).toHaveBeenCalledWith({
      baseURL: 'https://litellm.example.com',
      apiKey: 'litellm-key',
      name: 'litellm',
    })
  })

  it('config.agent.provider=anthropic → 调用 createAnthropic（含 apiKey，无 baseURL）', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-xxx'
    mocks.loadWorkspaceContext.mockResolvedValueOnce({
      cwd: '/mock-workspace',
      paths: mocks.paths,
      config: {
        agent: {
          model: 'claude-sonnet-4-5',
          maxSteps: 8,
          provider: 'anthropic' as const,
          responses: { reasoningEffort: 'medium', reasoningSummary: 'auto' } as const,
          context: { keepRecentToolResults: 20 } as { keepRecentToolResults: number },
        },
        im: {
          enabled: ['slack'] as Array<'slack' | 'wechat'>,
          wechat: {
            baseUrl: 'https://ilinkai.weixin.qq.com',
            cdnBaseUrl: 'https://novac2c.cdn.weixin.qq.com/c2c',
          },
        },
      },
      systemPrompt: 'system prompt',
      skills: [],
    })
    await createApplication({ workspaceDir: '/workspace' })
    expect(mocks.createAnthropic).toHaveBeenCalledWith({ apiKey: 'sk-ant-xxx' })
    expect(mocks.createOpenAICompatible).not.toHaveBeenCalled()
  })

  it('config.agent.provider=anthropic + ANTHROPIC_BASE_URL → createAnthropic 收到 baseURL', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-xxx'
    process.env.ANTHROPIC_BASE_URL = 'https://gateway.example.com/v1'
    mocks.loadWorkspaceContext.mockResolvedValueOnce({
      cwd: '/mock-workspace',
      paths: mocks.paths,
      config: {
        agent: {
          model: 'claude-sonnet-4-5',
          maxSteps: 8,
          provider: 'anthropic' as const,
          responses: { reasoningEffort: 'medium', reasoningSummary: 'auto' } as const,
          context: { keepRecentToolResults: 20 } as { keepRecentToolResults: number },
        },
        im: {
          enabled: ['slack'] as Array<'slack' | 'wechat'>,
          wechat: {
            baseUrl: 'https://ilinkai.weixin.qq.com',
            cdnBaseUrl: 'https://novac2c.cdn.weixin.qq.com/c2c',
          },
        },
      },
      systemPrompt: 'system prompt',
      skills: [],
    })
    await createApplication({ workspaceDir: '/workspace' })
    expect(mocks.createAnthropic).toHaveBeenCalledWith({
      apiKey: 'sk-ant-xxx',
      baseURL: 'https://gateway.example.com/v1',
    })
  })

  it('config.agent.provider=anthropic 缺 ANTHROPIC_API_KEY → 抛 ConfigError', async () => {
    mocks.loadWorkspaceContext.mockResolvedValueOnce({
      cwd: '/mock-workspace',
      paths: mocks.paths,
      config: {
        agent: {
          model: 'test-model',
          maxSteps: 8,
          provider: 'anthropic' as const,
          responses: { reasoningEffort: 'medium', reasoningSummary: 'auto' } as const,
          context: { keepRecentToolResults: 20 } as { keepRecentToolResults: number },
        },
        im: {
          enabled: ['slack'] as Array<'slack' | 'wechat'>,
          wechat: {
            baseUrl: 'https://ilinkai.weixin.qq.com',
            cdnBaseUrl: 'https://novac2c.cdn.weixin.qq.com/c2c',
          },
        },
      },
      systemPrompt: 'system prompt',
      skills: [],
    })
    await expect(createApplication({ workspaceDir: '/workspace' })).rejects.toThrow(
      /ANTHROPIC_API_KEY/,
    )
  })

  // executorFactory 在 createApplication 里是懒调用的（由 orchestrator 在收到 tools 后触发），
  // 测试中需要从 orchestrator mock 拿到 args 然后手动触发一次。
  function triggerExecutorFactory(): void {
    const orchestratorArgs = mocks.createConversationOrchestrator.mock.calls[0]?.[0] as
      | {
          toolsBuilder: (
            user: { userId: string; userName: string },
            im: Record<string, unknown>,
          ) => unknown
          executorFactory: (tools: unknown) => unknown
        }
      | undefined
    if (!orchestratorArgs) throw new Error('orchestrator mock 未被调用')
    const tools = orchestratorArgs.toolsBuilder({ userId: 'U1', userName: 'tester' }, {})
    orchestratorArgs.executorFactory(tools)
  }

  it('config.agent.provider=openai-responses → 调用 createOpenAI(.responses) + LiteLLM 凭证 + extraProviderOptions', async () => {
    mocks.loadWorkspaceContext.mockResolvedValueOnce({
      cwd: '/mock-workspace',
      paths: mocks.paths,
      config: {
        agent: {
          model: 'gpt-5.5',
          maxSteps: 8,
          provider: 'openai-responses' as const,
          responses: { reasoningEffort: 'low', reasoningSummary: 'detailed' },
          context: { keepRecentToolResults: 20 } as { keepRecentToolResults: number },
        },
        im: {
          enabled: ['slack'] as Array<'slack' | 'wechat'>,
          wechat: {
            baseUrl: 'https://ilinkai.weixin.qq.com',
            cdnBaseUrl: 'https://novac2c.cdn.weixin.qq.com/c2c',
          },
        },
      },
      systemPrompt: 'system prompt',
      skills: [],
    })

    await createApplication({ workspaceDir: '/workspace' })

    expect(mocks.createOpenAI).toHaveBeenCalledWith({
      baseURL: 'https://litellm.example.com',
      apiKey: 'litellm-key',
      name: 'openai-responses',
      compatibility: 'compatible',
    })
    expect(mocks.createOpenAICompatible).not.toHaveBeenCalled()
    expect(mocks.createAnthropic).not.toHaveBeenCalled()

    triggerExecutorFactory()

    const executorArgs = mocks.createAiSdkExecutor.mock.calls[0]?.[0] as
      | { extraProviderOptions?: Record<string, unknown>; providerName?: string }
      | undefined
    expect(executorArgs?.extraProviderOptions).toEqual({
      openai: {
        reasoningEffort: 'low',
        reasoningSummary: 'detailed',
        store: false,
        strictSchemas: false,
      },
    })
    // openai-responses 路径下 providerName 必须是 undefined：避免向 /responses 端点注入
    // stream_options（那是 /chat/completions 字段）。OpenAI Responses 流式响应自带 usage。
    expect(executorArgs?.providerName).toBeUndefined()
  })

  it('config.agent.provider=litellm 时不传 extraProviderOptions', async () => {
    await createApplication({ workspaceDir: '/workspace' })
    triggerExecutorFactory()
    const executorArgs = mocks.createAiSdkExecutor.mock.calls[0]?.[0] as
      | { extraProviderOptions?: unknown }
      | undefined
    expect(executorArgs?.extraProviderOptions).toBeUndefined()
  })

  it('env AGENT_PROVIDER 不再影响选择（config 单一权威）', async () => {
    process.env.AGENT_PROVIDER = 'anthropic'
    await createApplication({ workspaceDir: '/workspace' })
    expect(mocks.createOpenAICompatible).toHaveBeenCalled()
  })

  it('仅 slack 启用：adapters 长度 1，且 id=slack', async () => {
    const app = await createApplication({ workspaceDir: '/workspace' })
    expect(app.adapters).toHaveLength(1)
    expect(app.adapters[0]?.id).toBe('slack')
  })

  it('仅 wechat 启用：不要求 SLACK_* env，adapters 含 wechat 一个', async () => {
    delete process.env.SLACK_BOT_TOKEN
    delete process.env.SLACK_APP_TOKEN
    delete process.env.SLACK_SIGNING_SECRET
    mocks.loadWorkspaceContext.mockResolvedValueOnce({
      cwd: '/mock-workspace',
      paths: mocks.paths,
      config: {
        agent: {
          model: 'test-model',
          maxSteps: 8,
          provider: 'litellm' as const,
          responses: { reasoningEffort: 'medium', reasoningSummary: 'auto' } as const,
          context: { keepRecentToolResults: 20 } as { keepRecentToolResults: number },
        },
        im: {
          enabled: ['wechat'] as Array<'slack' | 'wechat'>,
          wechat: {
            baseUrl: 'https://ilinkai.weixin.qq.com',
            cdnBaseUrl: 'https://novac2c.cdn.weixin.qq.com/c2c',
          },
        },
      },
      systemPrompt: 'system prompt',
      skills: [],
    })

    // 注意：不调 app.start() 以避免触发扫码登录长循环
    const app = await createApplication({ workspaceDir: '/workspace' })
    expect(app.adapters).toHaveLength(1)
    expect(app.adapters[0]?.id).toBe('wechat')
    // SlackAdapter 不应被构造
    expect(mocks.createSlackAdapter).not.toHaveBeenCalled()
    // WechatAdapter 被构造一次
    expect(mocks.createWechatAdapter).toHaveBeenCalledTimes(1)
  })

  it('scheduledTasks.yaml 不存在 → app.scheduledTasks 缺失', async () => {
    const app = await createApplication({ workspaceDir: '/workspace' })
    expect(app.scheduledTasks).toBeUndefined()
  })

  it('scheduledTasks.yaml enabled:true 但目标 IM 未启用 → 抛 ConfigError', async () => {
    // 写一个临时 yaml：im.enabled=[slack] 但 task target=wechat → 应抛
    const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const path = await import('node:path')
    const tmpRoot = mkdtempSync(path.default.join(tmpdir(), 'app-st-'))
    const scheduledTasksFile = path.default.join(tmpRoot, 'scheduled-tasks.yaml')
    writeFileSync(
      scheduledTasksFile,
      [
        'version: 1',
        'enabled: true',
        'tasks:',
        '  - id: w1',
        "    cron: '0 9 * * *'",
        '    prompt: hi',
        '    target:',
        '      im: wechat',
        '      to: filehelper',
      ].join('\n'),
    )
    try {
      mocks.loadWorkspaceContext.mockResolvedValueOnce({
        cwd: '/mock-workspace',
        paths: { ...mocks.paths, scheduledTasksFile },
        config: {
          agent: {
            model: 'test-model',
            maxSteps: 8,
            provider: 'litellm' as const,
            responses: { reasoningEffort: 'medium', reasoningSummary: 'auto' } as const,
            context: { keepRecentToolResults: 20 } as { keepRecentToolResults: number },
          },
          im: {
            enabled: ['slack'] as Array<'slack' | 'wechat'>,
            wechat: {
              baseUrl: 'https://ilinkai.weixin.qq.com',
              cdnBaseUrl: 'https://novac2c.cdn.weixin.qq.com/c2c',
            },
          },
        },
        systemPrompt: 'system prompt',
        skills: [],
      })
      await expect(createApplication({ workspaceDir: '/workspace' })).rejects.toThrow(
        /定时任务.*目标 IM.*未在 config.im.enabled/,
      )
    } finally {
      rmSync(tmpRoot, { recursive: true, force: true })
    }
  })

  it('scheduledTasks 启用 + IM 匹配 → 装配 runner+scheduler，app.scheduledTasks 存在', async () => {
    const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const path = await import('node:path')
    const tmpRoot = mkdtempSync(path.default.join(tmpdir(), 'app-st-'))
    const scheduledTasksFile = path.default.join(tmpRoot, 'scheduled-tasks.yaml')
    writeFileSync(
      scheduledTasksFile,
      [
        'version: 1',
        'enabled: true',
        'tasks:',
        '  - id: t1',
        "    cron: '0 9 * * *'",
        '    prompt: hi',
        '    target:',
        '      im: slack',
        '      channelId: C0123456789',
      ].join('\n'),
    )
    try {
      mocks.loadWorkspaceContext.mockResolvedValueOnce({
        cwd: '/mock-workspace',
        paths: { ...mocks.paths, scheduledTasksFile },
        config: {
          agent: {
            model: 'test-model',
            maxSteps: 8,
            provider: 'litellm' as const,
            responses: { reasoningEffort: 'medium', reasoningSummary: 'auto' } as const,
            context: { keepRecentToolResults: 20 } as { keepRecentToolResults: number },
          },
          im: {
            enabled: ['slack'] as Array<'slack' | 'wechat'>,
            wechat: {
              baseUrl: 'https://ilinkai.weixin.qq.com',
              cdnBaseUrl: 'https://novac2c.cdn.weixin.qq.com/c2c',
            },
          },
        },
        systemPrompt: 'system prompt',
        skills: [],
      })
      const app = await createApplication({ workspaceDir: '/workspace' })
      expect(app.scheduledTasks).toBeDefined()
      expect(app.scheduledTasks?.runner).toBeDefined()
      expect(app.scheduledTasks?.scheduler).toBeDefined()
    } finally {
      rmSync(tmpRoot, { recursive: true, force: true })
    }
  })

  it('双开 [slack, wechat]：两个 adapter id 正确', async () => {
    mocks.loadWorkspaceContext.mockResolvedValueOnce({
      cwd: '/mock-workspace',
      paths: mocks.paths,
      config: {
        agent: {
          model: 'test-model',
          maxSteps: 8,
          provider: 'litellm' as const,
          responses: { reasoningEffort: 'medium', reasoningSummary: 'auto' } as const,
          context: { keepRecentToolResults: 20 } as { keepRecentToolResults: number },
        },
        im: {
          enabled: ['slack', 'wechat'] as Array<'slack' | 'wechat'>,
          wechat: {
            baseUrl: 'https://ilinkai.weixin.qq.com',
            cdnBaseUrl: 'https://novac2c.cdn.weixin.qq.com/c2c',
          },
        },
      },
      systemPrompt: 'system prompt',
      skills: [],
    })

    // 注意：不调 app.start() 以避免触发扫码登录长循环
    const app = await createApplication({ workspaceDir: '/workspace' })
    expect(app.adapters).toHaveLength(2)
    const ids = app.adapters.map((a) => a.id).sort()
    expect(ids).toEqual(['slack', 'wechat'])
    expect(mocks.createSlackAdapter).toHaveBeenCalledTimes(1)
    expect(mocks.createWechatAdapter).toHaveBeenCalledTimes(1)
  })
})
