// .env / .env.local 模板生成器。
//
// - generateEnvExample()：与根目录 .env.example 字节一致；守护测试断言。
// - generateEnvLocal(args)：onboard 根据用户输入写入 .agent-slack/.env.local。

export interface SlackEnvCreds {
  slackBotToken: string
  slackAppToken: string
  slackSigningSecret: string
}

export type GenerateEnvLocalArgs =
  | (SlackEnvCreds & {
      provider: 'litellm'
      litellmBaseUrl: string
      litellmApiKey: string
    })
  | (SlackEnvCreds & {
      provider: 'anthropic'
      anthropicApiKey: string
      anthropicBaseUrl?: string
    })

const TAIL_BLOCK = `
# ---------- 日志 & 调试 ----------
# 日志级别: trace | debug | info | warn | error
# 详细的 Slack 渲染诊断（[render-debug] ...）走 debug 级，必要时改为 LOG_LEVEL=debug。
LOG_LEVEL=info

# ---------- Slack live E2E（可选；真实发 Slack 消息）----------
# SLACK_E2E_CHANNEL_ID=C...
# SLACK_E2E_TRIGGER_USER_TOKEN=xoxp-...
# SLACK_E2E_TIMEOUT_MS=240000
# SLACK_E2E_RESULT_PATH=.agent-slack/e2e/result.json
`

// 根目录 .env.example：示例占位符版本（无真实凭证），开头带工程引言。
export function generateEnvExample(): string {
  return `# agent-slack 环境变量示例（复制为 .env.local；onboard 会在 workspace 生成 .agent-slack/.env.local）
# 行为配置（model / provider / maxSteps / skills）全部在 config.yaml，env 仅放凭证/URL/debug。

# ---------- Slack（必填）----------
SLACK_BOT_TOKEN=xoxb-...
SLACK_APP_TOKEN=xapp-...
SLACK_SIGNING_SECRET=...

# ---------- LiteLLM（config.yaml agent.provider=litellm 或 openai-responses 时必填）----------
# openai-responses 复用同一组 LiteLLM 凭证（走网关的 /responses 端点）
LITELLM_BASE_URL=http://localhost:4000
LITELLM_API_KEY=sk-...

# ---------- Anthropic（config.yaml agent.provider=anthropic 时必填）----------
# ANTHROPIC_API_KEY=sk-ant-...
# 可选；走自建网关时覆盖，默认 https://api.anthropic.com/v1
# ANTHROPIC_BASE_URL=
${TAIL_BLOCK}`
}

// onboard 写入 .agent-slack/.env.local：基于用户实际填写的凭证。
export function generateEnvLocal(args: GenerateEnvLocalArgs): string {
  const slackBlock = `# ---------- Slack（必填）----------
SLACK_BOT_TOKEN=${args.slackBotToken}
SLACK_APP_TOKEN=${args.slackAppToken}
SLACK_SIGNING_SECRET=${args.slackSigningSecret}
`

  if (args.provider === 'litellm') {
    return `${slackBlock}
# ---------- LiteLLM（当前 config.yaml 选用）----------
LITELLM_BASE_URL=${args.litellmBaseUrl}
LITELLM_API_KEY=${args.litellmApiKey}

# ---------- Anthropic（切到 anthropic 时填；provider 切换在 config.yaml）----------
# ANTHROPIC_API_KEY=sk-ant-...
# 可选；走自建网关时覆盖，默认 https://api.anthropic.com/v1
# ANTHROPIC_BASE_URL=
${TAIL_BLOCK}`
  }

  const anthropicBaseUrlLine = args.anthropicBaseUrl
    ? `ANTHROPIC_BASE_URL=${args.anthropicBaseUrl}`
    : `# 可选；走自建网关时覆盖，默认 https://api.anthropic.com/v1\n# ANTHROPIC_BASE_URL=`
  return `${slackBlock}
# ---------- Anthropic（当前 config.yaml 选用）----------
ANTHROPIC_API_KEY=${args.anthropicApiKey}
${anthropicBaseUrlLine}

# ---------- LiteLLM（切到 litellm 时填；provider 切换在 config.yaml）----------
# LITELLM_BASE_URL=http://localhost:4000
# LITELLM_API_KEY=sk-...
${TAIL_BLOCK}`
}

export const GITIGNORE_BLOCK = `
# agent-slack
.agent-slack/sessions/
.agent-slack/logs/
.agent-slack/channel-tasks/
.agent-slack/.env.local
`
