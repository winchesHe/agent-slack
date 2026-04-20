import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ConsolaInstance } from 'consola'
import { createLogger } from './logger.ts'
import type { Redactor } from './redactor.ts'

const consolaMock = vi.hoisted(() => {
  const root = {
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    withTag: vi.fn(),
  }
  const tagged = {
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    withTag: vi.fn(),
  }

  root.withTag.mockReturnValue(tagged as unknown as ConsolaInstance)
  tagged.withTag.mockReturnValue(tagged as unknown as ConsolaInstance)

  return {
    create: vi.fn(() => root as unknown as ConsolaInstance),
    root,
    tagged,
  }
})

vi.mock('consola', () => ({
  consola: {
    create: consolaMock.create,
  },
}))

const passthroughRedactor: Redactor = (input) =>
  typeof input === 'string' ? input : JSON.stringify(input)

describe('logger', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('LOG_LEVEL=trace 时映射到 consola level 5', () => {
    const logger = createLogger({
      level: 'trace',
      redactor: passthroughRedactor,
    })

    logger.trace('完整 prompt')

    expect(consolaMock.create).toHaveBeenCalledWith({ level: 5 })
    expect(consolaMock.root.trace).toHaveBeenCalledWith('完整 prompt')
  })

  it('单参日志不透传 undefined 尾参', () => {
    const logger = createLogger({
      level: 'info',
      redactor: passthroughRedactor,
    })

    logger.info('只有消息')

    expect(consolaMock.root.info).toHaveBeenCalledTimes(1)
    expect(consolaMock.root.info.mock.calls[0]).toEqual(['只有消息'])
  })
})
