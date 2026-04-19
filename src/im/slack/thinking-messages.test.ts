import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  LOADING_POOL,
  STATUS,
  TOOL_PHRASE,
  getShuffledLoadingMessages,
} from './thinking-messages.ts'

describe('thinking-messages', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('STATUS 三个固定文案', () => {
    expect(STATUS.thinking).toBe('思考中…')
    expect(STATUS.composing).toBe('回复中…')
    expect(STATUS.reasoning).toBe('推理中…')
  })

  it('LOADING_POOL 非空且无重复', () => {
    expect(LOADING_POOL.length).toBeGreaterThanOrEqual(12)
    expect(new Set(LOADING_POOL).size).toBe(LOADING_POOL.length)
  })

  it('getShuffledLoadingMessages 长度正确且为 LOADING_POOL 的子集', () => {
    const shuffled = getShuffledLoadingMessages(8)

    expect(shuffled).toHaveLength(8)
    for (const message of shuffled) {
      expect(LOADING_POOL).toContain(message)
    }
  })

  it('两次 shuffle 会根据随机序列变化而产生不同结果', () => {
    let callCount = 0
    vi.spyOn(Math, 'random').mockImplementation(() => {
      callCount += 1
      return callCount < LOADING_POOL.length ? 0 : 0.999999
    })

    const first = getShuffledLoadingMessages(8)
    const second = getShuffledLoadingMessages(8)

    expect(first).not.toEqual(second)
  })

  it('TOOL_PHRASE 格式正确', () => {
    expect(TOOL_PHRASE.input('read_file')).toBe('准备调用 read_file…')
    expect(TOOL_PHRASE.running('bash')).toBe('正在 bash…')
  })
})
