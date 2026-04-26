import fs from 'node:fs/promises'
import path from 'node:path'
import YAML from 'yaml'
import { describe, expect, it } from 'vitest'
import { parseChannelTasksConfig } from '@/channelTasks/config.ts'
import { parseConfig } from '@/workspace/config.ts'

const examplesDir = path.join(process.cwd(), 'examples', 'agent-slack')

describe('agent-slack 配置示例', () => {
  it('config.yaml 能被 workspace config schema 解析', async () => {
    const raw = await fs.readFile(path.join(examplesDir, 'config.yaml'), 'utf8')
    const parsed = parseConfig(YAML.parse(raw))

    expect(parsed.agent.maxSteps).toBe(50)
    expect(parsed.im.provider).toBe('slack')
  })

  it('channel-tasks.yaml 能被 channel task schema 解析', async () => {
    const raw = await fs.readFile(path.join(examplesDir, 'channel-tasks.yaml'), 'utf8')
    const parsed = parseChannelTasksConfig(YAML.parse(raw))

    expect(parsed.version).toBe(1)
    expect(parsed.rules.map((rule) => rule.id)).toEqual(['daily-watch', 'bot-alert-watch'])
  })

  it('system.md 和 .env.local.example 存在且不包含真实 token', async () => {
    const system = await fs.readFile(path.join(examplesDir, 'system.md'), 'utf8')
    const env = await fs.readFile(path.join(examplesDir, '.env.local.example'), 'utf8')

    expect(system).toContain('System Prompt 示例')
    expect(env).toContain('SLACK_BOT_TOKEN=xoxb-...')
    expect(env).not.toMatch(/xox[baprs]-[0-9A-Za-z-]{20,}/)
  })
})
