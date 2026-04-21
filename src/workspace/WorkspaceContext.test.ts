import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { writeFileSync, mkdirSync, rmSync } from 'node:fs'
import path from 'node:path'
import { loadWorkspaceContext } from './WorkspaceContext.ts'
import type { Logger } from '@/logger/logger.ts'

let cwd: string

// 测试用 logger stub
const stubLogger: Logger = {
  withTag: () => stubLogger,
  trace: () => {},
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
}

beforeEach(() => {
  // 使用 repo-local 临时目录而非 /tmp，避免权限问题并保持测试可见性
  const timestamp = Date.now()
  const random = Math.random().toString(36).slice(2, 8)
  const testTmpBase = path.join(process.cwd(), 'memory/.test-tmp')
  cwd = path.join(testTmpBase, `ws-${timestamp}-${random}`)
  mkdirSync(path.join(cwd, '.agent-slack'), { recursive: true })
})

afterEach(() => {
  if (cwd) {
    rmSync(cwd, { recursive: true, force: true })
  }
})

describe('loadWorkspaceContext', () => {
  it('加载 config + system.md', async () => {
    writeFileSync(path.join(cwd, '.agent-slack/config.yaml'), 'agent:\n  model: x-model\n')
    writeFileSync(path.join(cwd, '.agent-slack/system.md'), '# system')
    const ctx = await loadWorkspaceContext(cwd, stubLogger)
    expect(ctx.config.agent.model).toBe('x-model')
    expect(ctx.systemPrompt).toBe('# system')
    expect(ctx.skills).toEqual([])
  })

  it('config 缺失使用默认', async () => {
    const ctx = await loadWorkspaceContext(cwd, stubLogger)
    expect(ctx.config.agent.name).toBe('default')
  })

  it('system.md 缺失 → systemPrompt 为空串', async () => {
    const ctx = await loadWorkspaceContext(cwd, stubLogger)
    expect(ctx.systemPrompt).toBe('')
  })

  it('有 skill 的 workspace → systemPrompt 包含 Available Skills', async () => {
    writeFileSync(path.join(cwd, '.agent-slack/system.md'), 'Base system prompt')

    const skillsDir = path.join(cwd, '.agent-slack/skills')
    mkdirSync(skillsDir, { recursive: true })

    mkdirSync(path.join(skillsDir, 'tone'))
    writeFileSync(
      path.join(skillsDir, 'tone/SKILL.md'),
      '---\nname: tone\ndescription: 控制语气\nwhenToUse: 当需要特定语气时\n---\n使用正式书面语',
    )

    const ctx = await loadWorkspaceContext(cwd, stubLogger)
    expect(ctx.skills).toHaveLength(1)
    expect(ctx.skills[0]!.name).toBe('tone')
    expect(ctx.systemPrompt).toContain('Available Skills')
    expect(ctx.systemPrompt).toContain('### tone')
    expect(ctx.systemPrompt).toContain('控制语气')
    expect(ctx.systemPrompt).toContain('当需要特定语气时')
    // skill 全文内容不应出现在 system prompt，只保留元数据索引
    expect(ctx.systemPrompt).not.toContain('使用正式书面语')
    expect(ctx.systemPrompt).toContain('Source:')
    expect(ctx.systemPrompt).toContain('SKILL.md')
    expect(ctx.systemPrompt).toContain('Base system prompt')
  })

  it('无 skill 时 systemPrompt 保持原样', async () => {
    writeFileSync(path.join(cwd, '.agent-slack/system.md'), 'Base system prompt')
    const ctx = await loadWorkspaceContext(cwd, stubLogger)
    expect(ctx.skills).toHaveLength(0)
    expect(ctx.systemPrompt).toBe('Base system prompt')
    expect(ctx.systemPrompt).not.toContain('Available Skills')
  })
})
