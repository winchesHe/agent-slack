import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import { createAnthropic } from '@ai-sdk/anthropic'
import { createOpenAI } from '@ai-sdk/openai'
import path from 'node:path'
import type { LanguageModel } from 'ai'
import type { ConfirmSender } from '@/im/types.ts'
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
import { createSlackConfirm } from '@/im/slack/SlackConfirm.ts'
import { createConfirmBridge } from '@/im/slack/ConfirmBridge.ts'
import { createSelfImproveCollector } from '@/agents/selfImprove/collectorAgent.ts'
import { createSelfImproveGenerator } from '@/agents/selfImprove/generatorAgent.ts'
import { createSemanticDedup } from '@/agents/selfImprove/semanticDedupAgent.ts'
import { createCompactAgent } from '@/agents/compact/index.ts'
import { createContextCompactor } from '@/orchestrator/ContextCompactor.ts'
import { createMentionCommandRouter } from '@/orchestrator/MentionCommandRouter.ts'
import { loadChannelTasksConfigFile } from '@/channelTasks/config.ts'
import { createChannelTaskTriggerLedger } from '@/channelTasks/triggerLedger.ts'
import { ConfigError } from '@/core/errors.ts'
import type { Application } from './types.ts'

type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error'

export type AgentProvider = 'litellm' | 'anthropic' | 'openai-responses'

export interface CreateApplicationArgs {
  workspaceDir: string
}

export async function createApplication(args: CreateApplicationArgs): Promise<Application> {
  loadWorkspaceEnv({ workspaceDir: args.workspaceDir })

  // 通用凭证
  const slackBotToken = requireEnv('SLACK_BOT_TOKEN')
  const slackAppToken = requireEnv('SLACK_APP_TOKEN')
  const slackSigningSecret = requireEnv('SLACK_SIGNING_SECRET')
  const slackE2eTriggerUserToken = process.env.SLACK_E2E_TRIGGER_USER_TOKEN?.trim()
  const logLevel = parseLogLevel(process.env.LOG_LEVEL)

  // 日志文件路径：.agent-slack/logs/agent-YYYY-MM-DD.log；由 Dashboard Logs tab 消费
  const logFile = resolveDailyLogFile(args.workspaceDir)

  // 先用 bootstrap logger 加载 workspace context（此时尚未知晓 provider secrets）
  const bootstrapRedactor = createRedactor([
    slackBotToken,
    slackAppToken,
    slackSigningSecret,
    ...(slackE2eTriggerUserToken ? [slackE2eTriggerUserToken] : []),
  ])
  const bootstrapLogger = createLogger({ level: logLevel, redactor: bootstrapRedactor, logFile })

  const ctx = await loadWorkspaceContext(args.workspaceDir, bootstrapLogger)
  const channelTasksConfig = await loadChannelTasksConfigFile(ctx.paths.channelTasksFile)

  // provider 唯一来源：config.agent.provider（env 不参与选择）
  const provider = selectProvider(ctx.config.agent.provider)
  const providerEnv = loadProviderEnv(provider)

  const redactor = createRedactor([
    slackBotToken,
    slackAppToken,
    slackSigningSecret,
    ...(slackE2eTriggerUserToken ? [slackE2eTriggerUserToken] : []),
    ...providerEnv.secrets,
  ])
  const logger = createLogger({ level: logLevel, redactor, logFile })
  logger.withTag('agent').info(`provider=${provider}`)

  const sessionStore = createSessionStore(ctx.paths)
  const memoryStore = createMemoryStore(ctx.paths)
  const selfImproveCollector = createSelfImproveCollector({ paths: ctx.paths, logger })
  const selfImproveGenerator = createSelfImproveGenerator()
  const confirmBridge = createConfirmBridge({ logger })
  const runQueue = new SessionRunQueue()
  const abortRegistry = new AbortRegistry<string>()

  const modelName = ctx.config.agent.model
  const runtime = buildProviderRuntime(provider, providerEnv, modelName)
  const selfImproveSemanticDedup = createSemanticDedup({ model: runtime.model, logger })
  const compactAgent = createCompactAgent({ model: runtime.model, logger })
  const contextCompactor = createContextCompactor({ compactAgent, logger })
  const mentionCommandRouter = createMentionCommandRouter({ compactor: contextCompactor })
  const channelTaskLedger = channelTasksConfig
    ? createChannelTaskTriggerLedger(ctx.paths.channelTaskTriggersFile)
    : undefined

  const toolsBuilder = (
    currentUser: { userName: string; userId: string },
    imContext: { confirm?: ConfirmSender },
  ) =>
    buildBuiltinTools(
      {
        cwd: ctx.cwd,
        logger,
        currentUser,
        ...(imContext.confirm ? { confirm: imContext.confirm } : {}),
      },
      {
        memoryStore,
        selfImproveCollector,
        selfImproveGenerator,
        selfImproveSemanticDedup,
        confirmBridge,
        paths: ctx.paths,
        logger,
      },
    )

  // 仅 provider='openai-responses' 时构造 reasoning 透传对象。
  // key 必须是字面量 'openai'：@ai-sdk/openai 内部 parseProviderOptions({ provider: "openai" })
  // 写死该字面量，与 createOpenAI({ name: 'openai-responses' }) 的 name 字段无关。
  const extraProviderOptions =
    provider === 'openai-responses'
      ? {
          openai: {
            reasoningEffort: ctx.config.agent.responses.reasoningEffort,
            reasoningSummary: ctx.config.agent.responses.reasoningSummary,
            store: false, // spec §9 决策：不在 OpenAI 服务端长期保留对话内容
            // 关闭 OpenAI Responses API 的 strict function schema 校验。
            // strict 模式要求 required 数组包含 properties 全部 key（即所有字段都必填，可选字段须用 nullable union 表达）。
            // 但本仓库的内置 tools（如 bash 的 timeout_ms）大量使用 zod .optional()，转出的 JSON schema
            // 不符合 strict 形态。LiteLLM 网关在 /responses 端点会以 400 invalid_function_parameters 拒绝请求。
            // 设 false 让 ai-sdk 直接发送 zod 转出的宽松 schema，与 /chat/completions 路径一致。
            strictSchemas: false,
          },
        }
      : undefined

  const executorFactory = (tools: ReturnType<typeof toolsBuilder>) =>
    createAiSdkExecutor({
      model: runtime.model,
      modelName: runtime.modelName,
      tools,
      maxSteps: ctx.config.agent.maxSteps,
      logger,
      ...(runtime.providerNameForOptions ? { providerName: runtime.providerNameForOptions } : {}),
      ...(extraProviderOptions ? { extraProviderOptions } : {}),
    })

  const orchestrator = createConversationOrchestrator({
    toolsBuilder,
    executorFactory,
    sessionStore,
    memoryStore,
    runQueue,
    abortRegistry,
    systemPrompt: ctx.systemPrompt,
    modelMessageBudget: ctx.config.agent.context,
    mentionCommandRouter,
    contextCompactor,
    logger,
  })

  const renderer = createSlackRenderer({ logger })
  const slackConfirm = createSlackConfirm({ logger })

  const slack = createSlackAdapter({
    orchestrator,
    abortRegistry,
    runQueue,
    renderer,
    slackConfirm,
    confirmBridge,
    sessionStore,
    ...(channelTasksConfig && channelTaskLedger
      ? { channelTasks: { config: channelTasksConfig, ledger: channelTaskLedger } }
      : {}),
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
  | {
      provider: 'openai-responses'
      litellmBaseUrl: string
      litellmApiKey: string
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
  if (provider === 'openai-responses') {
    const litellmBaseUrl = requireEnv('LITELLM_BASE_URL')
    const litellmApiKey = requireEnv('LITELLM_API_KEY')
    return {
      provider: 'openai-responses',
      litellmBaseUrl,
      litellmApiKey,
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
  if (provider === 'openai-responses' && env.provider === 'openai-responses') {
    // name: 'openai-responses' 仅用于错误标签；reasoning 字段透传必须靠 providerOptions.openai
    // （字面量 'openai'，由 @ai-sdk/openai 内部 parseProviderOptions 写死），不是 'openai-responses'。
    // compatibility: 'compatible' 让 ai-sdk 跳过严格 OpenAI schema 校验，避免 LiteLLM 网关接收
    // 不被原生 OpenAI 支持的字段时报错。
    const p = createOpenAI({
      baseURL: env.litellmBaseUrl,
      apiKey: env.litellmApiKey,
      name: 'openai-responses',
      compatibility: 'compatible',
    })
    return {
      model: p.responses(modelName),
      modelName,
      // 关键：不写 providerNameForOptions（保持 undefined）。
      // 否则 AiSdkExecutor 会向 providerOptions['openai-responses'] 注入 stream_options，
      // 但 /responses 端点不接受 stream_options 字段（这是 /chat/completions 才有的），
      // 实测会让 LiteLLM 在长 reasoning 流式下 hang/拒绝响应。
      // OpenAI Responses API 在 streaming 模式下 finish chunk 已自动包含 usage，无需 stream_options。
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
