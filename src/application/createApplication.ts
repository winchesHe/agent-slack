import 'dotenv/config'
import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import { loadWorkspaceContext } from '@/workspace/WorkspaceContext.ts'
import { createSessionStore } from '@/store/SessionStore.ts'
import { createMemoryStore } from '@/store/MemoryStore.ts'
import { createLogger } from '@/logger/logger.ts'
import { createRedactor } from '@/logger/redactor.ts'
import { createAiSdkExecutor } from '@/agent/AiSdkExecutor.ts'
import { buildBuiltinTools } from '@/agent/tools/index.ts'
import { createConversationOrchestrator } from '@/orchestrator/ConversationOrchestrator.ts'
import { createSlackAdapter } from '@/im/slack/SlackAdapter.ts'
import { createSlackRenderer } from '@/im/slack/SlackRenderer.ts'
import { ConfigError } from '@/core/errors.ts'
import type { Application } from './types.ts'

export interface CreateApplicationArgs {
  workspaceDir: string
}

export async function createApplication(args: CreateApplicationArgs): Promise<Application> {
  const ctx = await loadWorkspaceContext(args.workspaceDir)

  const env = {
    slackBotToken: requireEnv('SLACK_BOT_TOKEN'),
    slackAppToken: requireEnv('SLACK_APP_TOKEN'),
    slackSigningSecret: requireEnv('SLACK_SIGNING_SECRET'),
    litellmBaseUrl: requireEnv('LITELLM_BASE_URL'),
    litellmApiKey: requireEnv('LITELLM_API_KEY'),
    logLevel: (process.env.LOG_LEVEL ?? 'info') as 'debug' | 'info' | 'warn' | 'error',
    providerName: process.env.PROVIDER_NAME ?? 'litellm',
  }

  const redactor = createRedactor([
    env.slackBotToken,
    env.slackAppToken,
    env.slackSigningSecret,
    env.litellmApiKey,
  ])
  const logger = createLogger({ level: env.logLevel, redactor })

  const sessionStore = createSessionStore(ctx.paths)
  const memoryStore = createMemoryStore(ctx.paths)

  const provider = createOpenAICompatible({
    baseURL: env.litellmBaseUrl,
    apiKey: env.litellmApiKey,
    name: env.providerName,
  })

  const modelName = process.env.AGENT_MODEL ?? ctx.config.agent.model
  const model = provider.chatModel(modelName)

  // tools per-handle 构造，将 currentUser 闭包注入
  const toolsBuilder = (currentUser: { userName: string; userId: string }) =>
    buildBuiltinTools({ cwd: ctx.cwd, logger, currentUser }, { memoryStore })

  const executorFactory = (tools: ReturnType<typeof toolsBuilder>) =>
    createAiSdkExecutor({
      model,
      modelName,
      tools,
      maxSteps: ctx.config.agent.maxSteps,
      logger,
      providerName: env.providerName,
    })

  const orchestrator = createConversationOrchestrator({
    toolsBuilder,
    executorFactory,
    sessionStore,
    memoryStore,
    systemPrompt: ctx.systemPrompt,
    logger,
  })

  const renderer = createSlackRenderer({ logger })

  const slack = createSlackAdapter({
    orchestrator,
    renderer,
    logger,
    botToken: env.slackBotToken,
    appToken: env.slackAppToken,
    signingSecret: env.slackSigningSecret,
  })

  return {
    adapters: [slack],
    async start() {
      for (const a of [slack]) await a.start()
    },
    async stop() {
      for (const a of [slack]) await a.stop()
    },
  }
}

function requireEnv(key: string): string {
  const v = process.env[key]
  if (!v) throw new ConfigError(`缺少环境变量 ${key}`, `请确认 .env 或环境变量`)
  return v
}
