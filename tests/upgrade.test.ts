import { describe, expect, it } from 'vitest'
import YAML from 'yaml'
import { planUpgradeYaml } from '@/workspace/upgrade.ts'
import { generateConfigYaml } from '@/workspace/templates/index.ts'

const template = generateConfigYaml({ mode: 'workspace' })

describe('planUpgradeYaml — rename migrations', () => {
  it('把旧 im.provider: slack 改写为 im.enabled: [slack]，并记录到 appliedRenames', () => {
    const userYaml = `
agent:
  name: default
  model: gpt-5.5
im:
  provider: slack
  slack:
    resolveChannelName: true
`.trimStart()

    const plan = planUpgradeYaml(userYaml, template)

    expect(plan.appliedRenames).toHaveLength(1)
    expect(plan.appliedRenames[0]).toMatchObject({
      from: 'im.provider',
      to: 'im.enabled',
    })

    const upgradedObj = YAML.parse(plan.upgraded) as Record<string, any>
    expect(upgradedObj.im.enabled).toEqual(['slack'])
    expect(upgradedObj.im.provider).toBeUndefined()
  })

  it('若 im.enabled 已存在则不动 provider（避免覆盖用户已迁移的配置）', () => {
    const userYaml = `
im:
  provider: slack
  enabled: ['slack', 'wechat']
`.trimStart()

    const plan = planUpgradeYaml(userYaml, template)

    // enabled 已存在 → 不触发改名；provider 字段保留（运行时 migrateLegacyImProvider 也是这个语义）
    expect(plan.appliedRenames).toHaveLength(0)
    const upgradedObj = YAML.parse(plan.upgraded) as Record<string, any>
    expect(upgradedObj.im.enabled).toEqual(['slack', 'wechat'])
    expect(upgradedObj.im.provider).toBe('slack')
  })

  it('完全没有 im.provider 时不触发改名', () => {
    const userYaml = `
agent:
  name: default
im:
  enabled: ['slack']
`.trimStart()

    const plan = planUpgradeYaml(userYaml, template)
    expect(plan.appliedRenames).toHaveLength(0)
  })
})
