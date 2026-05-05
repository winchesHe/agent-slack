// .env / .env.local 模板生成器。
//
// - generateEnvExample()：直接返回 examples/.env.example 内容。
// - generateEnvLocal(args)：onboard 根据用户输入写入 .agent-slack/.env.local。
//
// 模板源在 examples/.env.example；不要在本文件硬编码示例正文。

import { ENV_EXAMPLE } from './_assets.ts'

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

// 从 examples/.env.example 末尾切出公共尾部（日志 + Slack live E2E 段），
// 让 .env.local 与 .env.example 的尾部内容自动同步。
const TAIL_SENTINEL = '# ---------- 日志 & 调试 ----------'
const tailIndex = ENV_EXAMPLE.indexOf(TAIL_SENTINEL)
if (tailIndex < 0) {
  throw new Error(
    `agent-slack: examples/.env.example 缺少哨兵注释 "${TAIL_SENTINEL}"，无法切出公共尾部。`,
  )
}
const TAIL_BLOCK = '\n' + ENV_EXAMPLE.slice(tailIndex)

export function generateEnvExample(): string {
  return ENV_EXAMPLE
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
