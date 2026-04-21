import { describe, expect, it, vi } from 'vitest'
import { runOnboard, type OnboardDeps } from './onboard.ts'
import type { Prompter } from '../prompts.ts'
import type { ValidationResult } from '../validators.ts'
import path from 'node:path'

interface MockFs {
  files: Map<string, string>
  dirs: Set<string>
}

const cwd = '/tmp/ws'
const root = `${cwd}/.agent-slack`

interface BuildDepsOverrides {
  answers?: Partial<{
    existsAction: 'fill' | 'overwrite' | 'exit'
    provider: 'litellm' | 'anthropic'
    slackBot: string
    slackApp: string
    slackSecret: string
    litellmUrl: string
    litellmKey: string
    anthropicKey: string
    anthropicBaseUrl: string
    model: string
    confirmProceed: boolean
  }>
  initialFs?: Partial<MockFs>
  slackResult?: ValidationResult
  litellmResult?: ValidationResult
  anthropicResult?: ValidationResult
}

function buildDeps(o: BuildDepsOverrides = {}): {
  deps: OnboardDeps
  fs: MockFs
  prompter: Prompter
} {
  const fs: MockFs = {
    files: new Map(o.initialFs?.files ?? []),
    dirs: new Set(o.initialFs?.dirs ?? []),
  }
  const a = {
    existsAction: o.answers?.existsAction ?? 'overwrite',
    provider: o.answers?.provider ?? 'litellm',
    slackBot: o.answers?.slackBot ?? 'xoxb-test',
    slackApp: o.answers?.slackApp ?? 'xapp-test',
    slackSecret: o.answers?.slackSecret ?? 'secret',
    litellmUrl: o.answers?.litellmUrl ?? 'http://localhost:4000',
    litellmKey: o.answers?.litellmKey ?? 'sk-test',
    anthropicKey: o.answers?.anthropicKey ?? 'sk-ant-xxx',
    anthropicBaseUrl: o.answers?.anthropicBaseUrl ?? '',
    model: o.answers?.model ?? 'gpt-5.4',
    confirmProceed: o.answers?.confirmProceed ?? true,
  }
  const textQueue =
    a.provider === 'litellm' ? [a.litellmUrl, a.model] : [a.anthropicBaseUrl, a.model]
  const passwordQueue =
    a.provider === 'litellm'
      ? [a.slackBot, a.slackApp, a.slackSecret, a.litellmKey]
      : [a.slackBot, a.slackApp, a.slackSecret, a.anthropicKey]

  // select 按调用顺序返回：第 1 次是 existsAction（仅当目录已存在），第 2 次是 provider
  const selectQueue: Array<'fill' | 'overwrite' | 'exit' | 'litellm' | 'anthropic'> = []
  if (fs.dirs.has(`${cwd}/.agent-slack`) || fs.files.has(`${cwd}/.agent-slack/config.yaml`)) {
    selectQueue.push(a.existsAction)
  }
  selectQueue.push(a.provider)

  const prompter: Prompter = {
    intro: vi.fn(),
    outro: vi.fn(),
    note: vi.fn(),
    text: vi.fn(async () => textQueue.shift() ?? ''),
    password: vi.fn(async () => passwordQueue.shift() ?? ''),
    select: vi.fn(async () => selectQueue.shift() ?? '') as Prompter['select'],
    confirm: vi.fn(async () => a.confirmProceed),
  }
  const deps: OnboardDeps = {
    prompter,
    writeFile: vi.fn(async (p: string, data: string) => {
      fs.files.set(p, data)
    }),
    appendFile: vi.fn(async (p: string, data: string) => {
      fs.files.set(p, (fs.files.get(p) ?? '') + data)
    }),
    readFile: vi.fn(async (p: string) => fs.files.get(p) ?? ''),
    mkdir: vi.fn(async (p: string) => {
      fs.dirs.add(p)
    }),
    exists: (p: string) => fs.files.has(p) || fs.dirs.has(p),
    validateSlack: vi.fn(
      async () => o.slackResult ?? ({ ok: true, team: 'T' } as ValidationResult),
    ),
    validateLiteLLM: vi.fn(async () => o.litellmResult ?? ({ ok: true } as ValidationResult)),
    validateAnthropic: vi.fn(async () => o.anthropicResult ?? ({ ok: true } as ValidationResult)),
  }
  return { deps, fs, prompter }
}

describe('runOnboard', () => {
  it('全新目录 happy path：写入五件套 + 调用两次校验', async () => {
    const { deps, fs } = buildDeps()
    await runOnboard({ cwd }, deps)

    expect(fs.dirs.has(path.join(root, 'sessions'))).toBe(true)
    expect(fs.dirs.has(path.join(root, 'memory'))).toBe(true)
    expect(fs.dirs.has(path.join(root, 'skills'))).toBe(true)
    expect(fs.dirs.has(path.join(root, 'logs'))).toBe(true)

    expect(fs.files.get(`${root}/config.yaml`)).toContain('model: gpt-5.4')
    expect(fs.files.get(`${root}/system.md`)).toContain('System Prompt')
    expect(fs.files.get(`${root}/.env.local`)).toContain('SLACK_BOT_TOKEN=xoxb-test')
    expect(fs.files.get(`${root}/.env.local`)).toContain('LITELLM_API_KEY=sk-test')

    expect(deps.validateSlack).toHaveBeenCalledOnce()
    expect(deps.validateLiteLLM).toHaveBeenCalledOnce()
  })

  it('已存在目录 + 选择 exit：不写任何文件', async () => {
    const initialFiles = new Map<string, string>([[`${root}/config.yaml`, 'existing']])
    const { deps, fs } = buildDeps({
      answers: { existsAction: 'exit' },
      initialFs: { dirs: new Set([root]), files: initialFiles },
    })
    await runOnboard({ cwd }, deps)

    expect(fs.files.get(`${root}/config.yaml`)).toBe('existing')
    expect(deps.writeFile).not.toHaveBeenCalled()
    expect(deps.validateSlack).not.toHaveBeenCalled()
  })

  it('已存在目录 + 选择 fill：已有 config.yaml 不被覆盖', async () => {
    const initialFiles = new Map<string, string>([[`${root}/config.yaml`, 'existing-config']])
    const { deps, fs } = buildDeps({
      answers: { existsAction: 'fill' },
      initialFs: { dirs: new Set([root]), files: initialFiles },
    })
    await runOnboard({ cwd }, deps)

    expect(fs.files.get(`${root}/config.yaml`)).toBe('existing-config')
    expect(fs.files.get(`${root}/system.md`)).toContain('System Prompt')
    expect(fs.files.get(`${root}/.env.local`)).toBeDefined()
  })

  it('校验失败 + 用户同意继续：仍写入配置', async () => {
    const { deps, fs } = buildDeps({
      slackResult: { ok: false, reason: 'invalid_auth' },
      answers: { confirmProceed: true },
    })
    await runOnboard({ cwd }, deps)
    expect(fs.files.get(`${root}/.env.local`)).toContain('SLACK_BOT_TOKEN=xoxb-test')
  })

  it('校验失败 + 用户拒绝继续：不写入配置', async () => {
    const { deps, fs } = buildDeps({
      slackResult: { ok: false, reason: 'invalid_auth' },
      answers: { confirmProceed: false },
    })
    await runOnboard({ cwd }, deps)
    expect(fs.files.size).toBe(0)
  })

  it('有 .gitignore 且不含 .agent-slack/：追加 block', async () => {
    const initial = new Map<string, string>([[`${cwd}/.gitignore`, 'node_modules\n']])
    const { deps, fs } = buildDeps({ initialFs: { files: initial } })
    await runOnboard({ cwd }, deps)
    const gi = fs.files.get(`${cwd}/.gitignore`)
    expect(gi).toContain('.agent-slack/sessions/')
    expect(gi).toContain('.agent-slack/logs/')
    expect(gi).toContain('.agent-slack/.env.local')
  })

  it('有 .gitignore 且已含 .agent-slack/：不重复追加', async () => {
    const initial = new Map<string, string>([[`${cwd}/.gitignore`, '.agent-slack/\n']])
    const { deps, fs } = buildDeps({ initialFs: { files: initial } })
    await runOnboard({ cwd }, deps)
    expect(fs.files.get(`${cwd}/.gitignore`)).toBe('.agent-slack/\n')
  })

  it('无 .gitignore：不创建', async () => {
    const { deps, fs } = buildDeps()
    await runOnboard({ cwd }, deps)
    expect(fs.files.has(`${cwd}/.gitignore`)).toBe(false)
  })

  it('选择 anthropic → config.yaml 含 agent.provider=anthropic；.env.local 含 ANTHROPIC_API_KEY，无 LITELLM_ 实值', async () => {
    const { deps, fs } = buildDeps({
      answers: { provider: 'anthropic', anthropicKey: 'sk-ant-abc' },
    })
    await runOnboard({ cwd }, deps)
    const env = fs.files.get(`${root}/.env.local`) ?? ''
    expect(env).toContain('ANTHROPIC_API_KEY=sk-ant-abc')
    expect(env).not.toMatch(/^LITELLM_/m)
    expect(env).not.toMatch(/^ANTHROPIC_BASE_URL=/m)
    expect(env).not.toMatch(/^AGENT_PROVIDER=/m) // env 不再参与 provider 选择
    const cfg = fs.files.get(`${root}/config.yaml`) ?? ''
    expect(cfg).toContain('provider: anthropic')
    expect(cfg).not.toContain('provider: litellm')
    expect(deps.validateAnthropic).toHaveBeenCalledOnce()
    expect(deps.validateLiteLLM).not.toHaveBeenCalled()
  })

  it('选择 anthropic + 填 ANTHROPIC_BASE_URL → .env.local 含该行', async () => {
    const { deps, fs } = buildDeps({
      answers: {
        provider: 'anthropic',
        anthropicKey: 'sk-ant-abc',
        anthropicBaseUrl: 'https://api.anthropic.com/v1',
      },
    })
    await runOnboard({ cwd }, deps)
    const env = fs.files.get(`${root}/.env.local`) ?? ''
    expect(env).toContain('ANTHROPIC_BASE_URL=https://api.anthropic.com/v1')
  })

  it('选择 litellm → config.yaml 含 agent.provider=litellm；.env.local 无 AGENT_PROVIDER', async () => {
    const { deps, fs } = buildDeps()
    await runOnboard({ cwd }, deps)
    const env = fs.files.get(`${root}/.env.local`) ?? ''
    expect(env).not.toMatch(/^AGENT_PROVIDER=/m)
    expect(env).not.toMatch(/AGENT_PROVIDER/) // 不再在 env 里出现（包括注释）
    expect(env).not.toMatch(/^ANTHROPIC_[A-Z_]*=[^#]/m) // 无 uncommented ANTHROPIC_
    expect(env).toContain('LITELLM_BASE_URL=http://localhost:4000')
    const cfg = fs.files.get(`${root}/config.yaml`) ?? ''
    expect(cfg).toContain('provider: litellm')
  })
})
