import { describe, expect, it, beforeEach } from 'vitest'
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { bashTool, type ToolContext } from './bash.ts'
import { editFileTool } from './editFile.ts'

let cwd: string
beforeEach(() => {
  cwd = mkdtempSync(path.join(tmpdir(), 'tools-'))
})

const stubCtx = (): ToolContext => {
  const make = (): ToolContext['logger'] => {
    const l: ToolContext['logger'] = {
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: () => {},
      withTag: () => make(),
    }
    return l
  }
  return { cwd, logger: make() }
}

type Invokable = { execute?: (input: unknown, ctx: unknown) => PromiseLike<unknown> }
const asInvokable = (t: unknown): Invokable => t as Invokable
const invoke = async (tool: Invokable, input: unknown): Promise<unknown> => {
  if (!tool.execute) throw new Error('tool has no execute')
  return await tool.execute(input, { toolCallId: 't', messages: [] })
}

type BashOut = { stdout: string; stderr: string; exitCode: number; timedOut: boolean }

describe('bash', () => {
  it('执行简单命令', async () => {
    writeFileSync(path.join(cwd, 'a.txt'), 'hello')
    const out = (await invoke(asInvokable(bashTool(stubCtx())), { cmd: 'cat a.txt' })) as BashOut
    expect(out.stdout.trim()).toBe('hello')
    expect(out.exitCode).toBe(0)
  })

  it('超时 kill', async () => {
    const out = (await invoke(asInvokable(bashTool(stubCtx())), {
      cmd: 'sleep 5',
      timeout_ms: 200,
    })) as BashOut
    expect(out.timedOut).toBe(true)
  })

  it('stdout 截断', async () => {
    const out = (await invoke(asInvokable(bashTool(stubCtx())), {
      cmd: 'yes x | head -c 40000',
    })) as BashOut
    expect(out.stdout.length).toBeLessThanOrEqual(30_000 + 32)
    expect(out.stdout).toContain('[truncated]')
  })
})

describe('edit_file', () => {
  it('唯一 old_string 替换', async () => {
    writeFileSync(path.join(cwd, 'a.txt'), 'foo bar baz')
    const result = (await invoke(asInvokable(editFileTool(stubCtx())), {
      path: 'a.txt',
      old_string: 'bar',
      new_string: 'BAR',
    })) as { ok: boolean; replaced: number }
    expect(result).toMatchObject({ ok: true, replaced: 1 })
    expect(readFileSync(path.join(cwd, 'a.txt'), 'utf8')).toBe('foo BAR baz')
  })

  it('old_string 不唯一时返回结构化失败结果', async () => {
    writeFileSync(path.join(cwd, 'a.txt'), 'xx xx xx')
    const result = (await invoke(asInvokable(editFileTool(stubCtx())), {
      path: 'a.txt',
      old_string: 'xx',
      new_string: 'yy',
    })) as { ok: boolean; error: string; matches: number }
    expect(result).toMatchObject({
      ok: false,
      error: 'old_string_not_unique',
      matches: 3,
    })
    expect(readFileSync(path.join(cwd, 'a.txt'), 'utf8')).toBe('xx xx xx')
  })

  it('replace_all 放行', async () => {
    writeFileSync(path.join(cwd, 'a.txt'), 'xx xx xx')
    const result = (await invoke(asInvokable(editFileTool(stubCtx())), {
      path: 'a.txt',
      old_string: 'xx',
      new_string: 'yy',
      replace_all: true,
    })) as { ok: boolean; replaced: number }
    expect(result).toMatchObject({ ok: true, replaced: 3 })
    expect(readFileSync(path.join(cwd, 'a.txt'), 'utf8')).toBe('yy yy yy')
  })

  it('未找到 old_string 时返回结构化失败结果', async () => {
    writeFileSync(path.join(cwd, 'a.txt'), 'abc')
    const result = (await invoke(asInvokable(editFileTool(stubCtx())), {
      path: 'a.txt',
      old_string: 'xyz',
      new_string: 'q',
    })) as { ok: boolean; error: string }
    expect(result).toMatchObject({ ok: false, error: 'old_string_not_found' })
  })

  it('old_string 和 new_string 相同时返回结构化失败结果', async () => {
    writeFileSync(path.join(cwd, 'a.txt'), 'abc')
    const result = (await invoke(asInvokable(editFileTool(stubCtx())), {
      path: 'a.txt',
      old_string: 'abc',
      new_string: 'abc',
    })) as { ok: boolean; error: string }
    expect(result).toMatchObject({ ok: false, error: 'old_string_identical' })
  })

  it('可用直引号匹配文件中的弯引号，并保持原有风格', async () => {
    writeFileSync(path.join(cwd, 'a.txt'), 'const title = “hello”')
    await invoke(asInvokable(editFileTool(stubCtx())), {
      path: 'a.txt',
      old_string: '"hello"',
      new_string: '"world"',
    })
    expect(readFileSync(path.join(cwd, 'a.txt'), 'utf8')).toBe('const title = “world”')
  })
})
