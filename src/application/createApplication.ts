import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import { createAnthropic } from '@ai-sdk/anthropic'
import path from 'node:path'
import type { LanguageModel } from 'ai'
import { loadWorkspaceContext } from '@/workspace/WorkspaceContext.ts'
import { loadWorkspaceEnv } from '@/workspace/loadEnv.ts'
import { resolveWorkspacePaths } from '@/workspace/paths.ts'
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

  // 通用凭证
  const slackBotToken = requireEnv('SLACK_BOT_TOKEN')
  const slackAppToken = requireEnv('SLACK_APP_TOKEN')
  const slackSigningSecret = requireEnv('SLACK_SIGNING_SECRET')
  const logLevel = parseLogLevel(process.env.LOG_LEVEL)

  // 日志文件路径：.agent-slack/logs/agent-YYYY-MM-DD.log；由 Dashboard Logs tab 消费
  const logFile = resolveDailyLogFile(args.workspaceDir)

  // 先用 bootstrap logger 加载 workspace context（此时尚未知晓 provider secrets）
  const bootstrapRedactor = createRedactor([slackBotToken, slackAppToken, slackSigningSecret])
  const bootstrapLogger = createLogger({ level: logLevel, redactor: bootstrapRedactor, logFile })

  const ctx = await loadWorkspaceContext(args.workspaceDir, bootstrapLogger)

  // provider 唯一来源：config.agent.provider（env 不参与选择）
  const provider = selectProvider(ctx.config.agent.provider)
  const providerEnv = loadProviderEnv(provider)

  const redactor = createRedactor([
    slackBotToken,
    slackAppToken,
    slackSigningSecret,
    ...providerEnv.secrets,
  ])
  const logger = createLogger({ level: logLevel, redactor, logFile })
  logger.withTag('agent').info(`provider=${provider}`)

  const sessionStore = createSessionStore(ctx.paths)
  const memoryStore = createMemoryStore(ctx.paths)
  const runQueue = new SessionRunQueue()
  const abortRegistry = new AbortRegistry<string>()

  const modelName = ctx.config.agent.model
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
      ...(runtime.providerNameForOptions ? { providerName: runtime.providerNameForOptions } : {}),
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

/**
 * provider 校验：config.agent.provider 已是 z.enum，此处仅做类型收窄。
 */
export function selectProvider(configProvider: AgentProvider): AgentProvider {
  return configProvider
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
      providerName: 'litellm',
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
  if (provider === 'anthropic' && env.provider === 'anthropic') {
    const p = createAnthropic({
      apiKey: env.anthropicApiKey,
      ...(env.anthropicBaseUrl ? { baseURL: env.anthropicBaseUrl } : {}),
    })
    return {
      model: p.languageModel(modelName),
      modelName,
      providerNameForOptions: undefined,
    }
  }
  throw new ConfigError(
    `provider 装配不一致：config=${provider}, env=${env.provider}`,
    '这是内部错误；请检查 config.yaml 与 env 是否一致',
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

function resolveDailyLogFile(workspaceDir: string): string {
  const paths = resolveWorkspacePaths(workspaceDir)
  const date = new Date().toISOString().slice(0, 10)
  return path.join(paths.logsDir, `agent-${date}.log`)
}
