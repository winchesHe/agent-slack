import { describe, expect, it, beforeEach } from 'vitest'
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { loadWorkspaceContext } from './WorkspaceContext.ts'

let cwd: string

beforeEach(() => {
  cwd = mkdtempSync(path.join(tmpdir(), 'ws-'))
  mkdirSync(path.join(cwd, '.agent-slack'), { recursive: true })
})

describe('loadWorkspaceContext', () => {
  it('加载 config + system.md', async () => {
    writeFileSync(path.join(cwd, '.agent-slack/config.yaml'), 'agent:\n  model: x-model\n')
    writeFileSync(path.join(cwd, '.agent-slack/system.md'), '# system')
    const ctx = await loadWorkspaceContext(cwd)
    expect(ctx.config.agent.model).toBe('x-model')
    expect(ctx.systemPrompt).toBe('# system')
    expect(ctx.skills).toEqual([])
  })

  it('config 缺失使用默认', async () => {
    const ctx = await loadWorkspaceContext(cwd)
    expect(ctx.config.agent.name).toBe('default')
  })

  it('system.md 缺失 → systemPrompt 为空串', async () => {
    const ctx = await loadWorkspaceContext(cwd)
    expect(ctx.systemPrompt).toBe('')
  })
})
