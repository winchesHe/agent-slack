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
  it('save 写入带 frontmatter 的 markdown', async () => {
    const store = createMemoryStore(resolveWorkspacePaths(cwd))
    const file = await store.save({ category: 'user', slug: 'role', content: 'is DE' })
    const body = readFileSync(file, 'utf8')
    expect(body).toContain('category: user')
    expect(body).toContain('is DE')
  })

  it('slug 不合法字符被替换', async () => {
    const store = createMemoryStore(resolveWorkspacePaths(cwd))
    const file = await store.save({ category: 'user', slug: 'has space/x', content: 'x' })
    expect(file).toMatch(/user-has_space_x\.md$/)
  })
})
