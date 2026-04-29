// onboard 命令：交互式初始化 workspace
//   - 询问 Slack 三件套 + LiteLLM 基座 + 默认模型
//   - 当场校验（Slack auth.test / LiteLLM /models），失败允许"继续写入"
//   - 已存在 .agent-slack/ 时询问 fill / overwrite / exit
//   - 写 config.yaml / system.md / .env.local / 空子目录，并追加 .gitignore
//
// 业务逻辑通过依赖注入（Prompter + fs + validators）与 IO 解耦，便于单测。
import { existsSync } from 'node:fs'
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { resolveWorkspacePaths } from '@/workspace/paths.ts'
import { createClackPrompter, PrompterCancelled, type Prompter } from '../prompts.ts'
import {
  generateConfigYaml,
  generateEnvLocal,
  generateSystemMd,
  GITIGNORE_BLOCK,
} from '@/workspace/templates/index.ts'
import {
  validateAnthropic,
  validateLiteLLM,
  validateSlack,
  type ValidateAnthropicArgs,
  type ValidateLiteLLMArgs,
  type ValidateSlackArgs,
  type ValidationResult,
} from '../validators.ts'

export interface OnboardOpts {
  cwd: string
}

// 便于测试的注入口：真实场景下默认使用 clack + node:fs + validators
export interface OnboardDeps {
  prompter: Prompter
  writeFile: (p: string, data: string) => Promise<void>
  appendFile: (p: string, data: string) => Promise<void>
  readFile: (p: string) => Promise<string>
  mkdir: (p: string) => Promise<void>
  exists: (p: string) => boolean
  validateSlack: (args: ValidateSlackArgs) => Promise<ValidationResult>
  validateLiteLLM: (args: ValidateLiteLLMArgs) => Promise<ValidationResult>
  validateAnthropic: (args: ValidateAnthropicArgs) => Promise<ValidationResult>
}

export async function onboardCommand(opts: OnboardOpts): Promise<void> {
  try {
    await runOnboard(opts, buildDefaultDeps())
  } catch (err) {
    if (err instanceof PrompterCancelled) {
      process.exit(1)
    }
    throw err
  }
}

function buildDefaultDeps(): OnboardDeps {
  return {
    prompter: createClackPrompter(),
    writeFile: (p, data) => writeFile(p, data),
    appendFile: (p, data) => appendFile(p, data),
    readFile: (p) => readFile(p, 'utf8'),
    mkdir: async (p) => {
      await mkdir(p, { recursive: true })
    },
    exists: existsSync,
    validateSlack,
    validateLiteLLM,
    validateAnthropic,
  }
}

export async function runOnboard(opts: OnboardOpts, deps: OnboardDeps): Promise<void> {
  const { prompter } = deps
  const paths = resolveWorkspacePaths(opts.cwd)
  prompter.intro(`agent-slack onboard — workspace: ${opts.cwd}`)

  let overwrite = false
  if (deps.exists(paths.root)) {
    const action = await prompter.select<'fill' | 'overwrite' | 'exit'>({
      message: `${paths.root} 已存在`,
      options: [
        { label: '补齐缺失文件（不覆盖已有字段）', value: 'fill' },
        { label: '完全覆盖（重写 config.yaml / system.md / .env.local）', value: 'overwrite' },
        { label: '退出', value: 'exit' },
      ],
      initialValue: 'fill',
    })
    if (action === 'exit') {
      prompter.outro('已取消')
      return
    }
    overwrite = action === 'overwrite'
  }

  const slackBotToken = await prompter.password({
    message: 'SLACK_BOT_TOKEN (xoxb-...)',
    validate: (v) => (v.startsWith('xoxb-') ? undefined : '应以 xoxb- 开头'),
  })
  const slackAppToken = await prompter.password({
    message: 'SLACK_APP_TOKEN (xapp-...)',
    validate: (v) => (v.startsWith('xapp-') ? undefined : '应以 xapp- 开头'),
  })
  const slackSigningSecret = await prompter.password({ message: 'SLACK_SIGNING_SECRET' })

  const provider = await prompter.select<'litellm' | 'anthropic'>({
    message: 'Agent provider',
    options: [
      { label: 'LiteLLM（默认，通过代理层走多家）', value: 'litellm' },
      { label: 'Anthropic（官方 Claude API）', value: 'anthropic' },
    ],
    initialValue: 'litellm',
  })

  let litellmBaseUrl = ''
  let litellmApiKey = ''
  let anthropicApiKey = ''
  let anthropicBaseUrl = ''

  if (provider === 'litellm') {
    litellmBaseUrl = await prompter.text({
      message: 'LiteLLM Base URL',
      initialValue: 'http://localhost:4000',
    })
    litellmApiKey = await prompter.password({ message: 'LiteLLM API Key' })
  } else {
    anthropicApiKey = await prompter.password({
      message: 'ANTHROPIC_API_KEY',
      validate: (v) => (v.startsWith('sk-ant-') ? undefined : '应以 sk-ant- 开头'),
    })
    anthropicBaseUrl = await prompter.text({
      message: 'ANTHROPIC_BASE_URL（可选，回车跳过）',
      initialValue: '',
    })
  }

  const model = await prompter.text({
    message: '默认模型',
    initialValue: provider === 'anthropic' ? 'claude-sonnet-4-5' : 'gpt-5.4',
  })

  const slackRes = await deps.validateSlack({ botToken: slackBotToken })
  prompter.note(
    slackRes.ok
      ? `✓ Slack auth.test 通过（team=${String((slackRes as { team?: unknown }).team)}）`
      : `✗ Slack: ${slackRes.reason}`,
    'Slack',
  )
  let providerRes: ValidationResult
  if (provider === 'litellm') {
    providerRes = await deps.validateLiteLLM({ baseUrl: litellmBaseUrl, apiKey: litellmApiKey })
    prompter.note(
      providerRes.ok
        ? '✓ LiteLLM /models 通过'
        : `✗ LiteLLM: ${providerRes.reason}（可稍后 doctor 排查）`,
      'LiteLLM',
    )
  } else {
    providerRes = await deps.validateAnthropic({
      apiKey: anthropicApiKey,
      ...(anthropicBaseUrl ? { baseUrl: anthropicBaseUrl } : {}),
    })
    prompter.note(
      providerRes.ok ? '✓ Anthropic API key 形状校验通过' : `✗ Anthropic: ${providerRes.reason}`,
      'Anthropic',
    )
  }

  if (!slackRes.ok || !providerRes.ok) {
    const go = await prompter.confirm({
      message: '有校验失败。仍要写入配置？',
      initialValue: true,
    })
    if (!go) {
      prompter.outro('已取消')
      return
    }
  }

  await deps.mkdir(paths.sessionsDir)
  await deps.mkdir(paths.memoryDir)
  await deps.mkdir(paths.skillsDir)
  await deps.mkdir(paths.logsDir)

  if (overwrite || !deps.exists(paths.configFile)) {
    await deps.writeFile(
      paths.configFile,
      generateConfigYaml({ mode: 'workspace', model, provider }),
    )
  }
  if (overwrite || !deps.exists(paths.systemFile)) {
    await deps.writeFile(paths.systemFile, generateSystemMd({ mode: 'workspace' }))
  }
  const envFile = path.join(paths.root, '.env.local')
  if (overwrite || !deps.exists(envFile)) {
    const envArgs =
      provider === 'litellm'
        ? ({
            provider: 'litellm' as const,
            slackBotToken,
            slackAppToken,
            slackSigningSecret,
            litellmBaseUrl,
            litellmApiKey,
          } as const)
        : ({
            provider: 'anthropic' as const,
            slackBotToken,
            slackAppToken,
            slackSigningSecret,
            anthropicApiKey,
            ...(anthropicBaseUrl ? { anthropicBaseUrl } : {}),
          } as const)
    await deps.writeFile(envFile, generateEnvLocal(envArgs))
  }

  await maybeAppendGitignore(opts.cwd, deps)

  const providerHint = `当前 provider=${provider}（写入 config.yaml 的 agent.provider）。切换方法：编辑 config.yaml 改为另一值后重启`
  prompter.outro([`✓ 已初始化 ${paths.root}`, providerHint, `下一步：agent-slack start`].join('\n'))
}

async function maybeAppendGitignore(cwd: string, deps: OnboardDeps): Promise<void> {
  const gi = path.join(cwd, '.gitignore')
  if (!deps.exists(gi)) return
  const content = await deps.readFile(gi)
  if (content.includes('.agent-slack/')) return
  await deps.appendFile(gi, GITIGNORE_BLOCK)
}
