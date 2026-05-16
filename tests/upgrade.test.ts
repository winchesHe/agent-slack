import { describe, expect, it } from 'vitest'
import YAML from 'yaml'
import { collectImMismatch, planUpgradeYaml } from '@/workspace/upgrade.ts'
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

describe('collectImMismatch — scheduled-tasks 跨文件校验', () => {
  const baseScheduled = `
version: 1
enabled: true
tasks:
  - id: aihot-daily
    enabled: true
    cron: '0 8 * * *'
    prompt: 'foo'
    target:
      im: telegram
      to: '123'
  - id: slack-only
    enabled: true
    cron: '0 9 * * *'
    prompt: 'bar'
    target:
      im: slack
      channelId: C12345
  - id: disabled-task
    enabled: false
    cron: '0 10 * * *'
    prompt: 'baz'
    target:
      im: wechat
      to: 'someid'
`.trimStart()

  it('当 config.im.enabled=[slack] 时报告 telegram 未启用', () => {
    const mismatches = collectImMismatch(baseScheduled, ['slack'])
    expect(mismatches).toEqual([
      { taskId: 'aihot-daily', targetIm: 'telegram', enabledIms: ['slack'] },
    ])
  })

  it('忽略 enabled:false 的任务（不应报告）', () => {
    const mismatches = collectImMismatch(baseScheduled, ['slack', 'telegram'])
    // wechat 任务是 enabled:false，跳过；telegram 已在 enabled 列表里；剩 slack 任务匹配
    expect(mismatches).toEqual([])
  })

  it('scheduled-tasks.yaml 为空或顶层 enabled:false 时返回空数组', () => {
    expect(collectImMismatch('version: 1\nenabled: false\ntasks: []', ['slack'])).toEqual([])
  })

  it('scheduled-tasks.yaml 内容解析失败时返回空数组（不抛错）', () => {
    expect(collectImMismatch('not: yaml: at: all:', ['slack'])).toEqual([])
  })
})
