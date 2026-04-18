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
    await invoke(asInvokable(editFileTool(stubCtx())), {
      path: 'a.txt',
      old_string: 'bar',
      new_string: 'BAR',
    })
    expect(readFileSync(path.join(cwd, 'a.txt'), 'utf8')).toBe('foo BAR baz')
  })

  it('old_string 不唯一报错', async () => {
    writeFileSync(path.join(cwd, 'a.txt'), 'xx xx xx')
    await expect(
      invoke(asInvokable(editFileTool(stubCtx())), {
        path: 'a.txt',
        old_string: 'xx',
        new_string: 'yy',
      }),
    ).rejects.toThrow(/not unique/)
  })

  it('replace_all 放行', async () => {
    writeFileSync(path.join(cwd, 'a.txt'), 'xx xx xx')
    await invoke(asInvokable(editFileTool(stubCtx())), {
      path: 'a.txt',
      old_string: 'xx',
      new_string: 'yy',
      replace_all: true,
    })
    expect(readFileSync(path.join(cwd, 'a.txt'), 'utf8')).toBe('yy yy yy')
  })

  it('未找到 old_string 报错', async () => {
    writeFileSync(path.join(cwd, 'a.txt'), 'abc')
    await expect(
      invoke(asInvokable(editFileTool(stubCtx())), {
        path: 'a.txt',
        old_string: 'xyz',
        new_string: 'q',
      }),
    ).rejects.toThrow(/not found/)
  })
})
