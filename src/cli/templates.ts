// onboard 写入的默认文件模板
export function defaultConfigYaml(model: string): string {
  return `agent:
  name: default
  model: ${model}
  provider: litellm
  maxSteps: 20

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

export interface DefaultEnvArgs {
  slackBotToken: string
  slackAppToken: string
  slackSigningSecret: string
  litellmBaseUrl: string
  litellmApiKey: string
}

export function defaultEnv(args: DefaultEnvArgs): string {
  return `SLACK_BOT_TOKEN=${args.slackBotToken}
SLACK_APP_TOKEN=${args.slackAppToken}
SLACK_SIGNING_SECRET=${args.slackSigningSecret}
LITELLM_BASE_URL=${args.litellmBaseUrl}
LITELLM_API_KEY=${args.litellmApiKey}
LOG_LEVEL=info
`
}

export const GITIGNORE_BLOCK = `
# agent-slack
.agent-slack/sessions/
.agent-slack/logs/
.agent-slack/.env.local
`
