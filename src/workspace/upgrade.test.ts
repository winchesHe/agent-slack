import { describe, expect, it } from 'vitest'
import YAML from 'yaml'
import { backupSuffix, planUpgradeYaml } from './upgrade.ts'
import { generateConfigYaml } from './templates/index.ts'

describe('planUpgradeYaml — 顶层缺失 key 自动追加', () => {
  it('用户文件缺整段 daemon → 追加 daemon 块（含中文注释），结构可被 schema 解析', () => {
    const template = generateConfigYaml({
      mode: 'workspace',
      model: 'gpt-5.4',
      provider: 'litellm',
    })
    // 模拟旧版用户配置：没有 daemon 段
    const userYaml = template.replace(/\ndaemon:[\s\S]*$/, '')

    const plan = planUpgradeYaml(userYaml, template)
    expect(plan.missingTopLevel).toEqual(['daemon'])
    expect(plan.missingNested).toEqual([])
    expect(plan.plannedAppend).toContain('agent-slack upgrade')
    expect(plan.plannedAppend).toContain('daemon:')
    expect(plan.plannedAppend).toContain('host:')
    expect(plan.plannedAppend).toContain('port:')

    const reparsed = YAML.parse(plan.upgraded) as { daemon?: { host?: string; port?: number } }
    expect(reparsed.daemon).toMatchObject({ host: '127.0.0.1', port: 51732 })
  })

  it('多顶层缺失 → 一次追加多块，分隔注释列出全部 key', () => {
    const template = generateConfigYaml({ mode: 'workspace' })
    // 用户文件只剩 agent: 段
    const userYaml = template.replace(/\nskills:[\s\S]*$/, '')

    const plan = planUpgradeYaml(userYaml, template)
    expect(plan.missingTopLevel).toEqual(['skills', 'im', 'daemon'])
    expect(plan.plannedAppend).toContain('追加缺失字段：skills, im, daemon')

    const reparsed = YAML.parse(plan.upgraded) as Record<string, unknown>
    expect(reparsed.skills).toBeDefined()
    expect(reparsed.im).toBeDefined()
    expect(reparsed.daemon).toBeDefined()
  })

  it('用户文件无尾换行 → upgrade 后结构仍合法', () => {
    const template = generateConfigYaml({ mode: 'workspace' })
    const userYaml = template.replace(/\ndaemon:[\s\S]*$/, '').replace(/\n$/, '')

    const plan = planUpgradeYaml(userYaml, template)
    expect(plan.upgraded.startsWith(userYaml)).toBe(true)
    expect(() => YAML.parse(plan.upgraded)).not.toThrow()
  })
})

describe('planUpgradeYaml — 嵌套缺失', () => {
  it('agent.responses 父存在子缺失 → 列入 missingNested 不自动追加', () => {
    const template = generateConfigYaml({ mode: 'workspace' })
    // 模拟用户旧 config：agent 存在但缺 responses 子段
    const userYaml = `agent:
  name: default
  provider: litellm
  model: gpt-5.4
  maxSteps: 50
skills:
  enabled: ['*']
im:
  provider: slack
  slack:
    resolveChannelName: true
daemon:
  host: 127.0.0.1
  port: 51732
`
    const plan = planUpgradeYaml(userYaml, template)
    expect(plan.missingTopLevel).toEqual([])
    expect(plan.missingNested).toContain('agent.responses')
    expect(plan.missingNested).toContain('agent.context')
    expect(plan.plannedAppend).toBe('')
    expect(plan.upgraded).toBe(userYaml)
  })
})

describe('planUpgradeYaml — 无缺失 / 损坏', () => {
  it('无缺失字段 → plannedAppend 空，upgraded 与 user 完全一致', () => {
    const template = generateConfigYaml({ mode: 'workspace' })
    const plan = planUpgradeYaml(template, template)
    expect(plan.missingTopLevel).toEqual([])
    expect(plan.missingNested).toEqual([])
    expect(plan.plannedAppend).toBe('')
    expect(plan.upgraded).toBe(template)
  })

  it('用户 yaml 完全损坏 → 视为整体缺失，所有顶级 key 都追加', () => {
    const template = generateConfigYaml({ mode: 'workspace' })
    const plan = planUpgradeYaml('::: not yaml :::', template)
    expect(plan.missingTopLevel).toEqual(['agent', 'skills', 'im', 'daemon'])
    expect(plan.plannedAppend.length).toBeGreaterThan(0)
  })
})

describe('backupSuffix', () => {
  it('替换冒号与小数点为 -，便于 macOS/linux 文件名', () => {
    const suffix = backupSuffix(new Date('2026-04-29T08:30:45.123Z'))
    expect(suffix).toBe('2026-04-29T08-30-45-123Z')
  })
})
