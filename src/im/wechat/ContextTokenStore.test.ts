import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createContextTokenStore } from './ContextTokenStore.ts'

describe('ContextTokenStore', () => {
  let dir: string
  let file: string
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'wechat-ctx-'))
    file = path.join(dir, 'context-tokens.json')
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('文件不存在 → 空 store，get 返回 undefined', async () => {
    const store = await createContextTokenStore(file)
    expect(store.get('any-user')).toBeUndefined()
  })

  it('save 后 get 立即返回最新值（内存优先）', async () => {
    const store = await createContextTokenStore(file)
    await store.save('userA', 'tok-A1')
    expect(store.get('userA')).toBe('tok-A1')
    await store.save('userA', 'tok-A2')
    expect(store.get('userA')).toBe('tok-A2')
  })

  it('save 落盘后另起一个 store 能读回（持久化生效）', async () => {
    const store1 = await createContextTokenStore(file)
    await store1.save('userA', 'tok-A')
    await store1.save('userB', 'tok-B')
    const store2 = await createContextTokenStore(file)
    expect(store2.get('userA')).toBe('tok-A')
    expect(store2.get('userB')).toBe('tok-B')
  })

  it('save 并发 30 条不丢、不交错（同进程串行化）', async () => {
    const store = await createContextTokenStore(file)
    const promises: Promise<void>[] = []
    for (let i = 0; i < 30; i++) {
      promises.push(store.save(`u${i}`, `t${i}`))
    }
    await Promise.all(promises)
    for (let i = 0; i < 30; i++) {
      expect(store.get(`u${i}`)).toBe(`t${i}`)
    }
    // 重新加载校验落盘
    const reloaded = await createContextTokenStore(file)
    for (let i = 0; i < 30; i++) {
      expect(reloaded.get(`u${i}`)).toBe(`t${i}`)
    }
  })

  it('损坏文件 → 视为空 store（不抛、不阻塞 daemon 启动）', async () => {
    writeFileSync(file, '{ this is not json')
    const store = await createContextTokenStore(file)
    expect(store.get('any')).toBeUndefined()
    // 仍可继续 save
    await store.save('u', 't')
    expect(store.get('u')).toBe('t')
  })

  it('save 用 atomic write（落盘前不会出现半截 json）', async () => {
    const store = await createContextTokenStore(file)
    await store.save('userA', 'tok-A')
    const content = readFileSync(file, 'utf8')
    expect(() => JSON.parse(content)).not.toThrow()
    expect(JSON.parse(content)).toEqual({ userA: 'tok-A' })
  })

  it('save 创建父目录（不存在自动 mkdir）', async () => {
    const nested = path.join(dir, 'deep', 'nested', 'context-tokens.json')
    const store = await createContextTokenStore(nested)
    await store.save('u', 't')
    expect(JSON.parse(readFileSync(nested, 'utf8'))).toEqual({ u: 't' })
  })
})
