import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runScheduledTaskCli } from './scheduledTasks.ts'

const mocks = vi.hoisted(() => {
  const prepareForManualRun = vi.fn(async () => undefined)
  const loadCredentialsOnly = vi.fn(async () => ({
    token: 'tok',
    baseUrl: 'https://x.example/',
    botId: '',
    userId: '',
  }))
  const wechatHandle = {
    adapter: { id: 'wechat', start: vi.fn(), stop: vi.fn() },
    scheduledHook: { run: vi.fn(async () => undefined) },
    loadCredentialsOnly,
    prepareForManualRun,
  }
  const runOnce = vi.fn(async () => undefined)
  return { runOnce, prepareForManualRun, loadCredentialsOnly, wechatHandle }
})

// 控制 createApplication 返回值（每个 case 可单独覆盖 im.enabled）
const appState = vi.hoisted(() => ({
  imEnabled: ['slack'] as Array<'slack' | 'wechat'>,
}))

vi.mock('@/application/createApplication.ts', () => ({
  createApplication: vi.fn(async () => ({
    adapters: [],
    abortRegistry: { abortAll: vi.fn() },
    scheduledTasks: { runner: { runOnce: mocks.runOnce, skip: vi.fn() } },
    wechatHandle: appState.imEnabled.includes('wechat') ? mocks.wechatHandle : undefined,
    start: vi.fn(),
    stop: vi.fn(),
  })),
}))

// CLI 命令内部会调 loadWorkspaceContext 拿到 im.enabled；这里 mock 它。
vi.mock('@/workspace/WorkspaceContext.ts', () => ({
  loadWorkspaceContext: vi.fn(async () => ({
    cwd: '/mock',
    paths: { scheduledTasksFile: '/will-be-overridden' },
    config: {
      im: { enabled: appState.imEnabled },
    },
    systemPrompt: 'sys',
    skills: [],
  })),
}))

vi.mock('@/workspace/loadEnv.ts', () => ({
  loadWorkspaceEnv: vi.fn(),
}))

function writeYaml(file: string, content: string) {
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, content)
}

function makeWorkspace() {
  const root = mkdtempSync(path.join(tmpdir(), 'cli-st-'))
  const cwd = root
  const stFile = path.join(root, '.agent-slack', 'scheduled-tasks.yaml')
  return { cwd, stFile, cleanup: () => rmSync(root, { recursive: true, force: true }) }
}

describe('runScheduledTaskCli', () => {
  beforeEach(() => {
    appState.imEnabled = ['slack']
    mocks.runOnce.mockReset()
    mocks.runOnce.mockResolvedValue(undefined)
    mocks.prepareForManualRun.mockReset()
    mocks.prepareForManualRun.mockResolvedValue(undefined)
    mocks.loadCredentialsOnly.mockReset()
    mocks.loadCredentialsOnly.mockResolvedValue({
      token: 'tok',
      baseUrl: 'https://x.example/',
      botId: '',
      userId: '',
    })
  })
  afterEach(() => {
    vi.clearAllMocks()
  })

  it('yaml 不存在 → exit 5', async () => {
    const ws = makeWorkspace()
    try {
      const code = await runScheduledTaskCli({ cwd: ws.cwd, id: 'anything' })
      expect(code).toBe(5)
    } finally {
      ws.cleanup()
    }
  })

  it('rule id 不存在 → exit 2', async () => {
    const ws = makeWorkspace()
    writeYaml(
      ws.stFile,
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
    try {
      const code = await runScheduledTaskCli({ cwd: ws.cwd, id: 'nope' })
      expect(code).toBe(2)
    } finally {
      ws.cleanup()
    }
  })

  it('yaml schema 错（cron 非法）→ exit 5', async () => {
    const ws = makeWorkspace()
    writeYaml(
      ws.stFile,
      [
        'version: 1',
        'enabled: true',
        'tasks:',
        '  - id: a',
        "    cron: 'not-a-cron'",
        '    prompt: hi',
        '    target:',
        '      im: slack',
        '      channelId: C0123456789',
      ].join('\n'),
    )
    try {
      const code = await runScheduledTaskCli({ cwd: ws.cwd, id: 'a' })
      expect(code).toBe(5)
    } finally {
      ws.cleanup()
    }
  })

  it('target IM 未在 config.im.enabled → exit 4', async () => {
    appState.imEnabled = ['slack']
    const ws = makeWorkspace()
    writeYaml(
      ws.stFile,
      [
        'version: 1',
        'enabled: true',
        'tasks:',
        '  - id: w1',
        '    enabled: false',
        "    cron: '0 9 * * *'",
        '    prompt: hi',
        '    target:',
        '      im: wechat',
        '      to: oABC@im.wechat',
      ].join('\n'),
    )
    try {
      const code = await runScheduledTaskCli({ cwd: ws.cwd, id: 'w1' })
      expect(code).toBe(4)
    } finally {
      ws.cleanup()
    }
  })

  it('slack target 成功 → exit 0；runner.runOnce(rule, manual)', async () => {
    appState.imEnabled = ['slack']
    const ws = makeWorkspace()
    writeYaml(
      ws.stFile,
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
    try {
      const code = await runScheduledTaskCli({ cwd: ws.cwd, id: 'a' })
      expect(code).toBe(0)
      expect(mocks.runOnce).toHaveBeenCalledTimes(1)
      const args0 = mocks.runOnce.mock.calls[0] as unknown as [{ id: string }, string]
      expect(args0[0].id).toBe('a')
      expect(args0[1]).toBe('manual')
    } finally {
      ws.cleanup()
    }
  })

  it('wechat target + 凭证缺失 → exit 3', async () => {
    appState.imEnabled = ['wechat']
    const ws = makeWorkspace()
    writeYaml(
      ws.stFile,
      [
        'version: 1',
        'enabled: true',
        'tasks:',
        '  - id: w1',
        "    cron: '0 9 * * *'",
        '    prompt: hi',
        '    target:',
        '      im: wechat',
        '      to: oABC@im.wechat',
      ].join('\n'),
    )
    const { MissingWechatCredentialsError } = await import('@/im/wechat/WechatAdapter.ts')
    mocks.prepareForManualRun.mockRejectedValueOnce(new MissingWechatCredentialsError('/x'))
    try {
      const code = await runScheduledTaskCli({ cwd: ws.cwd, id: 'w1' })
      expect(code).toBe(3)
      expect(mocks.runOnce).not.toHaveBeenCalled()
    } finally {
      ws.cleanup()
    }
  })

  it('wechat target 成功 → prepareForManualRun + runOnce(manual)', async () => {
    appState.imEnabled = ['wechat']
    const ws = makeWorkspace()
    writeYaml(
      ws.stFile,
      [
        'version: 1',
        'enabled: true',
        'tasks:',
        '  - id: w1',
        "    cron: '0 9 * * *'",
        '    prompt: hi',
        '    target:',
        '      im: wechat',
        '      to: oABC@im.wechat',
      ].join('\n'),
    )
    try {
      const code = await runScheduledTaskCli({ cwd: ws.cwd, id: 'w1' })
      expect(code).toBe(0)
      expect(mocks.prepareForManualRun).toHaveBeenCalledTimes(1)
      expect(mocks.runOnce).toHaveBeenCalledTimes(1)
      const args = mocks.runOnce.mock.calls[0] as unknown as [unknown, string]
      expect(args[1]).toBe('manual')
    } finally {
      ws.cleanup()
    }
  })
})
