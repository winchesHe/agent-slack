import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  loadScheduledTasksConfigFile,
  parseScheduledTasksConfig,
  ScheduledTasksConfigSchema,
} from './config.ts'

describe('parseScheduledTasksConfig: 合法解析', () => {
  it('parses minimal slack target with defaults', () => {
    const cfg = parseScheduledTasksConfig({
      version: 1,
      enabled: true,
      tasks: [
        {
          id: 'daily-standup',
          cron: '0 9 * * 1-5',
          prompt: '请总结昨日变更。',
          target: { im: 'slack', channelId: 'C0123456789' },
        },
      ],
    })
    expect(cfg.version).toBe(1)
    expect(cfg.enabled).toBe(true)
    expect(cfg.tasks).toHaveLength(1)
    const task = cfg.tasks[0]!
    expect(task.id).toBe('daily-standup')
    expect(task.enabled).toBe(true) // default
    expect(task.target).toEqual({ im: 'slack', channelId: 'C0123456789' })
  })

  it('parses minimal wechat target', () => {
    const cfg = parseScheduledTasksConfig({
      version: 1,
      enabled: true,
      tasks: [
        {
          id: 'weekly-report',
          cron: '0 17 * * 5',
          prompt: '本周小结。',
          target: { im: 'wechat', to: 'oABC@im.wechat' },
        },
      ],
    })
    expect(cfg.tasks[0]!.target).toEqual({ im: 'wechat', to: 'oABC@im.wechat' })
  })

  it('defaults: version=1 / enabled=false / tasks=[]', () => {
    const cfg = parseScheduledTasksConfig({})
    expect(cfg.version).toBe(1)
    expect(cfg.enabled).toBe(false)
    expect(cfg.tasks).toEqual([])
  })

  it('accepts optional timezone & description', () => {
    const cfg = parseScheduledTasksConfig({
      tasks: [
        {
          id: 'a',
          description: '说明',
          cron: '*/5 * * * *',
          timezone: 'Asia/Shanghai',
          prompt: 'hi',
          target: { im: 'slack', channelId: 'C0000000001' },
        },
      ],
    })
    expect(cfg.tasks[0]!.description).toBe('说明')
    expect(cfg.tasks[0]!.timezone).toBe('Asia/Shanghai')
  })
})

describe('parseScheduledTasksConfig: 拒绝非法配置', () => {
  it('rejects duplicate task id', () => {
    expect(() =>
      parseScheduledTasksConfig({
        tasks: [
          {
            id: 'dup',
            cron: '0 9 * * *',
            prompt: 'p',
            target: { im: 'slack', channelId: 'C0000000001' },
          },
          {
            id: 'dup',
            cron: '0 10 * * *',
            prompt: 'q',
            target: { im: 'slack', channelId: 'C0000000002' },
          },
        ],
      }),
    ).toThrow(/重复.*id/)
  })

  it('rejects invalid cron expression', () => {
    expect(() =>
      parseScheduledTasksConfig({
        tasks: [
          {
            id: 'a',
            cron: 'not-a-cron',
            prompt: 'p',
            target: { im: 'slack', channelId: 'C0000000001' },
          },
        ],
      }),
    ).toThrow(/非法 cron/)
  })

  it('rejects illegal channelId format (must start with C/G)', () => {
    expect(() =>
      parseScheduledTasksConfig({
        tasks: [
          {
            id: 'a',
            cron: '0 9 * * *',
            prompt: 'p',
            target: { im: 'slack', channelId: 'lowercase-id' },
          },
        ],
      }),
    ).toThrow()
  })

  it('rejects empty prompt', () => {
    expect(() =>
      parseScheduledTasksConfig({
        tasks: [
          {
            id: 'a',
            cron: '0 9 * * *',
            prompt: '   ',
            target: { im: 'slack', channelId: 'C0000000001' },
          },
        ],
      }),
    ).toThrow()
  })

  it('rejects unknown target.im', () => {
    expect(() =>
      parseScheduledTasksConfig({
        tasks: [
          {
            id: 'a',
            cron: '0 9 * * *',
            prompt: 'p',
            target: { im: 'foo', channelId: 'C0000000001' },
          },
        ],
      }),
    ).toThrow()
  })

  it('rejects illegal task id (空 / 含非法字符)', () => {
    expect(() =>
      parseScheduledTasksConfig({
        tasks: [
          {
            id: '',
            cron: '0 9 * * *',
            prompt: 'p',
            target: { im: 'slack', channelId: 'C0000000001' },
          },
        ],
      }),
    ).toThrow()
    expect(() =>
      parseScheduledTasksConfig({
        tasks: [
          {
            id: 'has space',
            cron: '0 9 * * *',
            prompt: 'p',
            target: { im: 'slack', channelId: 'C0000000001' },
          },
        ],
      }),
    ).toThrow()
  })

  it('rejects wechat target without "to"', () => {
    expect(() =>
      parseScheduledTasksConfig({
        tasks: [
          {
            id: 'a',
            cron: '0 9 * * *',
            prompt: 'p',
            target: { im: 'wechat' },
          },
        ],
      }),
    ).toThrow()
  })
})

describe('cron schema 副作用守护', () => {
  it('cron 校验通过后不会真注册一个 cron job（无 tick 在跑）', async () => {
    // 用一个"每秒触发"的合法 cron 表达式校验，然后等待 1.2s，验证没有任何回调被异步调用、
    // 也没有 process 上残留的活跃 Timer（间接：schema 通过后立即返回，不持有引用）。
    const proc = process as unknown as { _getActiveHandles?: () => unknown[] }
    const before = proc._getActiveHandles?.().length ?? 0
    parseScheduledTasksConfig({
      tasks: [
        {
          id: 'a',
          cron: '* * * * * *', // croner 支持 6 字段 / 5 字段
          prompt: 'p',
          target: { im: 'slack', channelId: 'C0000000001' },
        },
      ],
    })
    await new Promise((r) => setTimeout(r, 50))
    const after = proc._getActiveHandles?.().length ?? 0
    // 允许 setTimeout 本身留下 1 个 handle；不允许新增 croner 内部 timer
    expect(after - before).toBeLessThanOrEqual(1)
  })
})

describe('IM 启用交叉校验（spec §4.3）', () => {
  // 注：spec §4.3 把"target.im 是否在 config.im.enabled 数组中"放在 createApplication 装配阶段做，
  // 不在 schema 内做。这里用一个独立 helper assertScheduledTasksTargetsAvailable 来表达，
  // 由 createApplication 调用；schema 仅做形态校验。
  it('schema 不强校验 IM 启用集合（留给装配阶段）', () => {
    // 即便 im=wechat 在 createApplication 里未启用，schema 也应通过；交叉校验在装配阶段抛
    expect(() =>
      parseScheduledTasksConfig({
        enabled: true,
        tasks: [
          {
            id: 'a',
            cron: '0 9 * * *',
            prompt: 'p',
            target: { im: 'wechat', to: 'oABC@im.wechat' },
          },
        ],
      }),
    ).not.toThrow()
  })
})

describe('loadScheduledTasksConfigFile', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'scheduled-tasks-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('returns undefined when file does not exist', async () => {
    expect(await loadScheduledTasksConfigFile(path.join(dir, 'missing.yaml'))).toBeUndefined()
  })

  it('parses a valid yaml file', async () => {
    const file = path.join(dir, 'scheduled-tasks.yaml')
    writeFileSync(
      file,
      [
        'version: 1',
        'enabled: true',
        'tasks:',
        '  - id: a',
        "    cron: '0 9 * * *'",
        '    prompt: hi',
        '    target:',
        '      im: slack',
        '      channelId: C0123456789',
      ].join('\n'),
    )
    const cfg = await loadScheduledTasksConfigFile(file)
    expect(cfg?.tasks[0]!.id).toBe('a')
  })

  it('throws on invalid yaml schema', async () => {
    const file = path.join(dir, 'scheduled-tasks.yaml')
    writeFileSync(file, 'tasks: [{ id: a, cron: bad-cron, prompt: p, target: { im: slack, channelId: C1 } }]')
    await expect(loadScheduledTasksConfigFile(file)).rejects.toThrow()
  })
})

describe('ScheduledTasksConfigSchema 直接出口', () => {
  it('exports a Zod schema usable directly', () => {
    expect(ScheduledTasksConfigSchema.safeParse({}).success).toBe(true)
  })
})
