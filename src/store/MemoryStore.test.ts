import { describe, expect, it, beforeEach } from 'vitest'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { resolveWorkspacePaths } from '@/workspace/paths.ts'
import { createMemoryStore } from './MemoryStore.ts'

let cwd: string
beforeEach(() => {
  cwd = mkdtempSync(path.join(tmpdir(), 'ms-'))
})

describe('MemoryStore', () => {
  it('save 按 userName+userId 命名，写入 updatedAt frontmatter + content', async () => {
    const store = createMemoryStore(resolveWorkspacePaths(cwd))
    const file = await store.save({ userName: '张三', userId: 'U123', content: '是 DE' })
    expect(file).toMatch(/张三-U123\.md$/)
    const body = readFileSync(file, 'utf8')
    expect(body).toMatch(/^---\nupdatedAt: /)
    expect(body).toContain('是 DE')
  })

  it('userName 中不合法字符被替换（空白 / 斜杠 / 引号），中文保留', async () => {
    const store = createMemoryStore(resolveWorkspacePaths(cwd))
    const file = await store.save({ userName: '李 四/x', userId: 'U1', content: 'x' })
    expect(file).toMatch(/李_四_x-U1\.md$/)
  })

  it('pathFor + exists 联动', async () => {
    const store = createMemoryStore(resolveWorkspacePaths(cwd))
    const p = store.pathFor('alice', 'U9')
    expect(await store.exists('alice', 'U9')).toBe(false)
    await store.save({ userName: 'alice', userId: 'U9', content: 'hi' })
    expect(await store.exists('alice', 'U9')).toBe(true)
    expect(p).toMatch(/alice-U9\.md$/)
  })

  it('save 覆盖写入（后写赢）', async () => {
    const store = createMemoryStore(resolveWorkspacePaths(cwd))
    await store.save({ userName: 'a', userId: 'U1', content: 'v1' })
    await store.save({ userName: 'a', userId: 'U1', content: 'v2' })
    const file = store.pathFor('a', 'U1')
    const body = readFileSync(file, 'utf8')
    expect(body).toContain('v2')
    expect(body).not.toContain('v1')
  })
})
