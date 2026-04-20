import { describe, expect, it } from 'vitest'
import { AbortRegistry } from './AbortRegistry.ts'

describe('AbortRegistry', () => {
  it('create: 新建 controller 并按 key 存入；重复 key 抛错', () => {
    const r = new AbortRegistry<string>()
    const c1 = r.create('k1')
    expect(c1.signal.aborted).toBe(false)

    expect(() => r.create('k1')).toThrow(/already exists/i)
  })

  it('abort: 命中 key 会 abort；unknown key 静默 no-op', () => {
    const r = new AbortRegistry<string>()
    const c1 = r.create('k1')

    r.abort('k-unknown')
    expect(c1.signal.aborted).toBe(false)

    r.abort('k1', 'bye')
    expect(c1.signal.aborted).toBe(true)
    expect(c1.signal.reason).toBe('bye')
  })

  it('delete: 删除后可重建同 key', () => {
    const r = new AbortRegistry<string>()
    const c1 = r.create('k1')
    r.abort('k1', 'first')
    expect(c1.signal.aborted).toBe(true)

    r.delete('k1')
    const c2 = r.create('k1')
    expect(c2.signal.aborted).toBe(false)
  })

  it('abortAll: 逐个 abort 并清空 map', () => {
    const r = new AbortRegistry<string>()
    const c1 = r.create('k1')
    const c2 = r.create('k2')

    r.abortAll('all')
    expect(c1.signal.aborted).toBe(true)
    expect(c1.signal.reason).toBe('all')
    expect(c2.signal.aborted).toBe(true)
    expect(c2.signal.reason).toBe('all')

    // 清空后同 key 可重建，证明内部 map 已释放
    const c1b = r.create('k1')
    expect(c1b.signal.aborted).toBe(false)
  })
})
