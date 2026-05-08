import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import YAML from 'yaml'
import { createDashboardApi } from './api.ts'
import { generateConfigYaml } from '@/workspace/templates/index.ts'
import type { Logger } from '@/logger/logger.ts'

const stubLogger: Logger = {
  withTag: () => stubLogger,
  trace: () => {},
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
}

let workspaceDir: string
let configFile: string

beforeEach(() => {
  const tag = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  workspaceDir = path.join(process.cwd(), 'memory/.test-tmp', `api-${tag}`)
  mkdirSync(path.join(workspaceDir, '.agent-slack'), { recursive: true })
  configFile = path.join(workspaceDir, '.agent-slack', 'config.yaml')
})

afterEach(() => {
  if (workspaceDir) rmSync(workspaceDir, { recursive: true, force: true })
})

describe('updateConfigFields — 局部覆盖式表单提交', () => {
  it('已有 config 改 model + maxSteps：保留中文注释，新值落盘并通过 schema 校验', async () => {
    const original = generateConfigYaml({
      mode: 'workspace',
      model: 'gpt-5.5',
      provider: 'litellm',
    })
    writeFileSync(configFile, original, 'utf8')
    expect(original).toContain('用于日志、dashboard 展示和 workspace 标识。')

    const api = createDashboardApi(workspaceDir, stubLogger)
    const result = await api.updateConfigFields([
      { path: ['agent', 'model'], value: 'claude-sonnet-4-5' },
      { path: ['agent', 'maxSteps'], value: 80 },
    ])

    const onDisk = readFileSync(configFile, 'utf8')
    expect(onDisk).toBe(result.raw)
    // 中文注释保留
    expect(onDisk).toContain('用于日志、dashboard 展示和 workspace 标识。')
    expect(onDisk).toContain('单轮 agent run 最多调用模型/工具的步数')
    // 值已更新（schema parse 通过）
    expect(result.parsed.agent.model).toBe('claude-sonnet-4-5')
    expect(result.parsed.agent.maxSteps).toBe(80)
  })

  it('config.yaml 不存在时 → 基于 generator workspace 模板初始化再应用更新', async () => {
    const api = createDashboardApi(workspaceDir, stubLogger)
    const result = await api.updateConfigFields([
      { path: ['agent', 'provider'], value: 'anthropic' },
      { path: ['agent', 'model'], value: 'claude-sonnet-4-5' },
    ])

    expect(result.parsed.agent.provider).toBe('anthropic')
    expect(result.parsed.agent.model).toBe('claude-sonnet-4-5')
    // 初始化的模板含中文注释
    expect(result.raw).toContain('用于日志、dashboard 展示和 workspace 标识。')
  })

  it('schema 校验失败 → 抛错，不写文件', async () => {
    const original = generateConfigYaml({ mode: 'workspace' })
    writeFileSync(configFile, original, 'utf8')

    const api = createDashboardApi(workspaceDir, stubLogger)
    await expect(
      // maxSteps 必须是 positive int，0 不合法
      api.updateConfigFields([{ path: ['agent', 'maxSteps'], value: 0 }]),
    ).rejects.toThrow()

    const onDisk = readFileSync(configFile, 'utf8')
    expect(onDisk).toBe(original)
  })

  it('深层 setIn（agent.context.autoCompact.enabled）保留祖先注释，目标值落盘', async () => {
    const original = generateConfigYaml({ mode: 'workspace' })
    writeFileSync(configFile, original, 'utf8')

    const api = createDashboardApi(workspaceDir, stubLogger)
    const result = await api.updateConfigFields([
      { path: ['agent', 'context', 'autoCompact', 'enabled'], value: false },
    ])
    expect(result.parsed.agent.context.autoCompact.enabled).toBe(false)
    // autoCompact 上方的中文注释仍在
    expect(result.raw).toContain('达到上下文预算阈值时')
    // 重新 parse 一遍，结构合法
    expect(() => YAML.parse(result.raw)).not.toThrow()
  })
})

describe('config() 返回 fields 元数据', () => {
  it('config() 返回 fields 数组，包含 agent.model / agent.provider 等常用字段', async () => {
    const api = createDashboardApi(workspaceDir, stubLogger)
    const c = await api.config()
    const labels = c.fields.map((f) => f.label)
    expect(labels).toContain('agent.model')
    expect(labels).toContain('agent.provider')
    expect(labels).toContain('autoCompact.enabled')
    expect(labels).toContain('skills.enabled')
  })
})
