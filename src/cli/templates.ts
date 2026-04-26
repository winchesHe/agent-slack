// onboard 写入的默认文件模板
export function defaultConfigYaml(model: string, provider: 'litellm' | 'anthropic'): string {
  return `agent:
  name: default
  model: ${model}
  # 可选值: litellm | anthropic；env 不参与选择，需改此处后重启生效
  provider: ${provider}
  maxSteps: 50
  context:
    # 传给模型的历史上下文近似字符预算；只影响模型视图，不裁剪 messages.jsonl
    maxApproxChars: 120000
    # 传给模型的最近消息数上限；用于限制大量短消息导致的上下文膨胀
    keepRecentMessages: 80
    # 保留最近 N 个完整工具结果；更旧的工具结果仅在模型视图中替换为占位提示
    keepRecentToolResults: 20

skills:
  enabled: ['*']

im:
  provider: slack
  slack:
    resolveChannelName: true
`
}

export function defaultSystemMd(): string {
  return `# System Prompt

你是本项目的 agent 助手。工作目录是当前 workspace（\`.agent-slack/\` 所在位置）。

## 工具
- \`bash\`：通用 shell 命令（cat / ls / rg / tee 等）。
- \`edit_file\`：精确字符串替换（old_string 必须唯一）。
- \`save_memory\`：保存长期记忆到 \`.agent-slack/memory/\`。

## Memory
你的长期记忆在 \`.agent-slack/memory/\`，可用 bash 读取。

## 风格
简洁、直接。代码引用 \`file:line\` 格式。
`
}

export interface SlackCreds {
  slackBotToken: string
  slackAppToken: string
  slackSigningSecret: string
}

export type DefaultEnvArgs =
  | (SlackCreds & {
      provider: 'litellm'
      litellmBaseUrl: string
      litellmApiKey: string
    })
  | (SlackCreds & {
      provider: 'anthropic'
      anthropicApiKey: string
      anthropicBaseUrl?: string
    })

export function defaultEnv(args: DefaultEnvArgs): string {
  const slackBlock = `# ---------- Slack（必填）----------
SLACK_BOT_TOKEN=${args.slackBotToken}
SLACK_APP_TOKEN=${args.slackAppToken}
SLACK_SIGNING_SECRET=${args.slackSigningSecret}
`

  const tailBlock = `
# ---------- 日志 & 调试 ----------
# 日志级别: trace | debug | info | warn | error
LOG_LEVEL=info
# Slack Block Kit 渲染调试: 1 启用 / 0 禁用
# SLACK_RENDER_DEBUG=0

# ---------- Slack live E2E（可选；真实发 Slack 消息）----------
# SLACK_E2E_CHANNEL_ID=C...
# SLACK_E2E_TRIGGER_USER_TOKEN=xoxp-...
# SLACK_E2E_TIMEOUT_MS=120000
# SLACK_E2E_RESULT_PATH=.agent-slack/e2e/result.json
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
${tailBlock}`
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
${tailBlock}`
}

export const GITIGNORE_BLOCK = `
# agent-slack
.agent-slack/sessions/
.agent-slack/logs/
.agent-slack/.env.local
`
