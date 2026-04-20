import { consola, type ConsolaInstance } from 'consola'
import type { Redactor } from './redactor.ts'

export interface Logger {
  withTag(tag: string): Logger
  /**
   * trace 用于最细粒度的观测点（例如：完整 system prompt 拼装结果）。
   */
  trace(msg: string, meta?: unknown): void
  debug(msg: string, meta?: unknown): void
  info(msg: string, meta?: unknown): void
  warn(msg: string, meta?: unknown): void
  error(msg: string, meta?: unknown): void
}

export function createLogger(opts: {
  level?: 'trace' | 'debug' | 'info' | 'warn' | 'error'
  redactor: Redactor
}): Logger {
  const root = consola.create({ level: levelToNumeric(opts.level ?? 'info') })
  return wrap(root, opts.redactor)
}

function levelToNumeric(level: string): number {
  return { trace: 5, debug: 4, info: 3, warn: 2, error: 0 }[level] ?? 3
}

function wrap(inst: ConsolaInstance, redact: Redactor): Logger {
  const wrapMeta = (meta: unknown): unknown => redact(meta)

  // consola 的方法签名允许第二参数为 undefined，但我们不传它，避免日志尾部出现无意义的 `undefined`。
  const log = (fn: (message: unknown, ...args: unknown[]) => void, msg: string, meta?: unknown) => {
    const safeMsg = redact(msg)
    if (meta === undefined) fn.call(inst, safeMsg)
    else fn.call(inst, safeMsg, wrapMeta(meta))
  }

  return {
    withTag: (tag) => wrap(inst.withTag(tag), redact),
    trace: (msg, meta) => log(inst.trace, msg, meta),
    debug: (msg, meta) => log(inst.debug, msg, meta),
    info: (msg, meta) => log(inst.info, msg, meta),
    warn: (msg, meta) => log(inst.warn, msg, meta),
    error: (msg, meta) => log(inst.error, msg, meta),
  }
}
