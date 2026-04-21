import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import type { LanguageModel } from 'ai'
import { loadWorkspaceContext } from '@/workspace/WorkspaceContext.ts'
import { loadWorkspaceEnv } from '@/workspace/loadEnv.ts'
import { createSessionStore } from '@/store/SessionStore.ts'
import { createMemoryStore } from '@/store/MemoryStore.ts'
import { createLogger } from '@/logger/logger.ts'
import { createRedactor } from '@/logger/redactor.ts'
import { createAiSdkExecutor } from '@/agent/AiSdkExecutor.ts'
import { buildBuiltinTools } from '@/agent/tools/index.ts'
import { createConversationOrchestrator } from '@/orchestrator/ConversationOrchestrator.ts'
import { SessionRunQueue } from '@/orchestrator/SessionRunQueue.ts'
import { AbortRegistry } from '@/orchestrator/AbortRegistry.ts'
import { createSlackAdapter } from '@/im/slack/SlackAdapter.ts'
import { createSlackRenderer } from '@/im/slack/SlackRenderer.ts'
import { ConfigError } from '@/core/errors.ts'
import type { Application } from './types.ts'

type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error'

export type AgentProvider = 'litellm' | 'anthropic'

export interface CreateApplicationArgs {
  workspaceDir: string
}

export async function createApplication(args: CreateApplicationArgs): Promise<Application> {
  loadWorkspaceEnv({ workspaceDir: args.workspaceDir })

  const provider = selectProvider()

  // 通用凭证
  const slackBotToken = requireEnv('SLACK_BOT_TOKEN')
  const slackAppToken = requireEnv('SLACK_APP_TOKEN')
  const slackSigningSecret = requireEnv('SLACK_SIGNING_SECRET')
  const logLevel = parseLogLevel(process.env.LOG_LEVEL)

  // 分支凭证
  const providerEnv = loadProviderEnv(provider)

  const redactor = createRedactor([
    slackBotToken,
    slackAppToken,
    slackSigningSecret,
    ...providerEnv.secrets,
  ])
  const logger = createLogger({ level: logLevel, redactor })
  logger.withTag('agent').info(`provider=${provider}`)

  const ctx = await loadWorkspaceContext(args.workspaceDir, logger)

  const sessionStore = createSessionStore(ctx.paths)
  const memoryStore = createMemoryStore(ctx.paths)
  const runQueue = new SessionRunQueue()
  const abortRegistry = new AbortRegistry<string>()

  const modelName = process.env.AGENT_MODEL ?? ctx.config.agent.model
  const runtime = buildProviderRuntime(provider, providerEnv, modelName)

  const toolsBuilder = (currentUser: { userName: string; userId: string }) =>
    buildBuiltinTools({ cwd: ctx.cwd, logger, currentUser }, { memoryStore })

  const executorFactory = (tools: ReturnType<typeof toolsBuilder>) =>
    createAiSdkExecutor({
      model: runtime.model,
      modelName: runtime.modelName,
      tools,
      maxSteps: ctx.config.agent.maxSteps,
      logger,
      ...(runtime.providerNameForOptions
        ? { providerName: runtime.providerNameForOptions }
        : {}),
    })

  const orchestrator = createConversationOrchestrator({
    toolsBuilder,
    executorFactory,
    sessionStore,
    memoryStore,
    runQueue,
    abortRegistry,
    systemPrompt: ctx.systemPrompt,
    logger,
  })

  const renderer = createSlackRenderer({ logger })

  const slack = createSlackAdapter({
    orchestrator,
    abortRegistry,
    runQueue,
    renderer,
    logger,
    botToken: slackBotToken,
    appToken: slackAppToken,
    signingSecret: slackSigningSecret,
  })

  return {
    adapters: [slack],
    abortRegistry,
    async start() {
      for (const a of [slack]) await a.start()
    },
    async stop() {
      for (const a of [slack]) await a.stop()
    },
  }
}

export function selectProvider(): AgentProvider {
  const raw = process.env.AGENT_PROVIDER
  if (!raw || raw.trim() === '') return 'litellm'
  const v = raw.trim().toLowerCase()
  if (v === 'litellm' || v === 'anthropic') return v
  throw new ConfigError(
    `非法 provider: AGENT_PROVIDER=${raw}`,
    '可选值为 litellm（默认）或 anthropic',
  )
}

type ProviderEnv =
  | {
      provider: 'litellm'
      litellmBaseUrl: string
      litellmApiKey: string
      providerName: string
      secrets: string[]
    }
  | {
      provider: 'anthropic'
      anthropicApiKey: string
      anthropicBaseUrl?: string
      secrets: string[]
    }

function loadProviderEnv(provider: AgentProvider): ProviderEnv {
  if (provider === 'litellm') {
    const litellmBaseUrl = requireEnv('LITELLM_BASE_URL')
    const litellmApiKey = requireEnv('LITELLM_API_KEY')
    return {
      provider: 'litellm',
      litellmBaseUrl,
      litellmApiKey,
      providerName: process.env.PROVIDER_NAME ?? 'litellm',
      secrets: [litellmApiKey],
    }
  }
  const anthropicApiKey = requireEnv('ANTHROPIC_API_KEY')
  const anthropicBaseUrl = process.env.ANTHROPIC_BASE_URL?.trim() || undefined
  return {
    provider: 'anthropic',
    anthropicApiKey,
    ...(anthropicBaseUrl ? { anthropicBaseUrl } : {}),
    secrets: [anthropicApiKey],
  }
}

interface ProviderRuntime {
  model: LanguageModel
  modelName: string
  providerNameForOptions: string | undefined
}

function buildProviderRuntime(
  provider: AgentProvider,
  env: ProviderEnv,
  modelName: string,
): ProviderRuntime {
  if (provider === 'litellm' && env.provider === 'litellm') {
    const p = createOpenAICompatible({
      baseURL: env.litellmBaseUrl,
      apiKey: env.litellmApiKey,
      name: env.providerName,
    })
    return {
      model: p.chatModel(modelName),
      modelName,
      providerNameForOptions: env.providerName,
    }
  }
  throw new ConfigError(
    'AGENT_PROVIDER=anthropic 暂未实装，P3 阶段接入',
    '临时改用 litellm 或等待 P3',
  )
}

function requireEnv(key: string): string {
  const v = process.env[key]
  if (!v) throw new ConfigError(`缺少环境变量 ${key}`, `请确认 .env 或环境变量`)
  return v
}

function parseLogLevel(v: string | undefined): LogLevel {
  const normalized = (v ?? 'info').trim().toLowerCase()

  if (normalized === 'warning') return 'warn'
  if (
    normalized === 'trace' ||
    normalized === 'debug' ||
    normalized === 'info' ||
    normalized === 'warn' ||
    normalized === 'error'
  ) {
    return normalized
  }

  // 历史上这里是宽松回退；保留该兼容性，避免旧环境值导致启动失败。
  return 'info'
}
