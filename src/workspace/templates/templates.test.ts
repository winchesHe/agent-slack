// 模板 generator 行为守护：example 模式直接返回 examples/* 内容；
// workspace 模式去掉示例头并按需注入参数。
//
// 失败时按 AGENTS.md "Env / Config 变更联动规则" 处理：
// - 改了 examples/ → 看 generator 是否需要更新参数化逻辑
// - workspace mode 替换正则失配 → 检查 examples/config.example.yaml 字段顺序

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  generateChannelTasksYaml,
  generateConfigYaml,
  generateEnvExample,
  generateEnvLocal,
  generateSystemMd,
} from './index.ts'

const examplesDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../examples')

function readExample(name: string): string {
  return readFileSync(path.join(examplesDir, name), 'utf8')
}

describe('templates: example mode 与 examples/* 一致', () => {
  it('generateEnvExample == examples/.env.example', () => {
    expect(generateEnvExample()).toBe(readExample('.env.example'))
  })

  it('generateConfigYaml({ mode: example }) == examples/config.example.yaml', () => {
    expect(generateConfigYaml({ mode: 'example' })).toBe(readExample('config.example.yaml'))
  })

  it('generateChannelTasksYaml({ mode: example }) == examples/channel-tasks.example.yaml', () => {
    expect(generateChannelTasksYaml({ mode: 'example' })).toBe(
      readExample('channel-tasks.example.yaml'),
    )
  })

  it('generateSystemMd({ mode: workspace }) == examples/system.md', () => {
    expect(generateSystemMd({ mode: 'workspace' })).toBe(readExample('system.md'))
  })

  it('generateSystemMd({ mode: example }) 在前面拼接引导段，正文与 system.md 一致', () => {
    const out = generateSystemMd({ mode: 'example' })
    const body = readExample('system.md')
    expect(out.endsWith(body)).toBe(true)
    expect(out).toMatch(/^<!--/)
    expect(out).toContain('复制到 .agent-slack/system.md')
  })
})

describe('templates: config workspace mode', () => {
  it('去掉示例引导注释，并按参数替换 model/provider', () => {
    const out = generateConfigYaml({
      mode: 'workspace',
      model: 'claude-sonnet-4-5',
      provider: 'anthropic',
    })
    expect(out).not.toContain('# agent-slack 行为配置示例')
    expect(out.startsWith('agent:\n')).toBe(true)
    expect(out).toMatch(/^\s*provider: anthropic$/m)
    expect(out).toMatch(/^\s*model: claude-sonnet-4-5$/m)
    // im.provider: slack 不被影响
    expect(out).toContain('provider: slack')
  })

  it('未指定参数时使用默认值 litellm / gpt-5.5', () => {
    const out = generateConfigYaml({ mode: 'workspace' })
    expect(out).toMatch(/^\s*provider: litellm$/m)
    expect(out).toMatch(/^\s*model: gpt-5\.5$/m)
  })
})

describe('templates: channelTasks workspace mode', () => {
  it('替换示例引导为 workspace 头部', () => {
    const out = generateChannelTasksYaml({ mode: 'workspace' })
    expect(out).not.toContain('# Slack 频道任务监听配置示例。')
    expect(out).toContain('# Slack 频道任务监听配置。')
    expect(out).toContain('# 文件缺失时该功能关闭')
    expect(out).toContain('version: 1')
    expect(out).toContain('rules:')
  })
})

describe('templates: env.local', () => {
  it('litellm 分支：Slack 凭证 + LiteLLM 凭证 + 注释掉的 Anthropic 占位', () => {
    const out = generateEnvLocal({
      provider: 'litellm',
      slackBotToken: 'xoxb-test',
      slackAppToken: 'xapp-test',
      slackSigningSecret: 'sig-test',
      litellmBaseUrl: 'http://localhost:4000',
      litellmApiKey: 'sk-test',
    })
    expect(out).toContain('SLACK_BOT_TOKEN=xoxb-test')
    expect(out).toContain('LITELLM_BASE_URL=http://localhost:4000')
    expect(out).toContain('LITELLM_API_KEY=sk-test')
    expect(out).toContain('# ANTHROPIC_API_KEY=sk-ant-...')
    expect(out).toContain('LOG_LEVEL=info')
  })

  it('anthropic 分支：填入 ANTHROPIC_API_KEY，base url 默认注释掉', () => {
    const out = generateEnvLocal({
      provider: 'anthropic',
      slackBotToken: 'xoxb-a',
      slackAppToken: 'xapp-a',
      slackSigningSecret: 'sig-a',
      anthropicApiKey: 'sk-ant-test',
    })
    expect(out).toContain('ANTHROPIC_API_KEY=sk-ant-test')
    expect(out).toMatch(/^# ANTHROPIC_BASE_URL=$/m)
    expect(out).toContain('# LITELLM_BASE_URL=http://localhost:4000')
  })

  it('anthropic 分支：显式 base url 覆盖默认', () => {
    const out = generateEnvLocal({
      provider: 'anthropic',
      slackBotToken: 'xoxb-a',
      slackAppToken: 'xapp-a',
      slackSigningSecret: 'sig-a',
      anthropicApiKey: 'sk-ant-test',
      anthropicBaseUrl: 'https://gw.example/v1',
    })
    expect(out).toContain('ANTHROPIC_BASE_URL=https://gw.example/v1')
  })
})
