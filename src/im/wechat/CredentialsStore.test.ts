import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtempSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir, platform } from 'node:os'
import path from 'node:path'
import { createCredentialsStore } from './CredentialsStore.ts'

describe('CredentialsStore', () => {
  let dir: string
  let filePath: string
  const store = createCredentialsStore()

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'wechat-cred-'))
    filePath = path.join(dir, 'subdir', 'credentials.json')
  })

  it('save 然后 load 返回相同凭证；目录会自动创建', async () => {
    await store.save(filePath, {
      token: 'tok-1', baseUrl: 'https://ilink.example/', botId: 'b', userId: 'u',
    })
    const loaded = await store.load(filePath)
    expect(loaded).toEqual({
      token: 'tok-1', baseUrl: 'https://ilink.example/', botId: 'b', userId: 'u',
    })
  })

  it('load 不存在的文件返回 undefined', async () => {
    const loaded = await store.load(path.join(dir, 'nope.json'))
    expect(loaded).toBeUndefined()
  })

  it('load 损坏的 JSON 抛错', async () => {
    const bad = path.join(dir, 'bad.json')
    writeFileSync(bad, '{ not json }', 'utf8')
    await expect(store.load(bad)).rejects.toThrow()
  })

  it('load 缺关键字段（token/baseUrl）返回 undefined', async () => {
    const bad = path.join(dir, 'partial.json')
    writeFileSync(bad, JSON.stringify({ botId: 'b' }), 'utf8')
    expect(await store.load(bad)).toBeUndefined()
  })

  it('save 后文件权限是 0600（非 Windows）', async () => {
    if (platform() === 'win32') return  // skip on Windows
    await store.save(filePath, { token: 't', baseUrl: 'b', botId: '', userId: '' })
    const mode = statSync(filePath).mode & 0o777
    expect(mode).toBe(0o600)
  })

  it('clear 删除文件；不存在时不抛错', async () => {
    await store.save(filePath, { token: 't', baseUrl: 'b', botId: '', userId: '' })
    await store.clear(filePath)
    expect(await store.load(filePath)).toBeUndefined()
    // 再 clear 一次不抛
    await expect(store.clear(filePath)).resolves.toBeUndefined()
  })
})
