import { consola, type ConsolaInstance } from 'consola'
import type { Redactor } from './redactor.ts'

export interface Logger {
  withTag(tag: string): Logger
  debug(msg: string, meta?: unknown): void
  info(msg: string, meta?: unknown): void
  warn(msg: string, meta?: unknown): void
  error(msg: string, meta?: unknown): void
}

export function createLogger(opts: {
  level?: 'debug' | 'info' | 'warn' | 'error'
  redactor: Redactor
}): Logger {
  const root = consola.create({ level: levelToNumeric(opts.level ?? 'info') })
  return wrap(root, opts.redactor)
}

function levelToNumeric(level: string): number {
  return { debug: 4, info: 3, warn: 2, error: 0 }[level] ?? 3
}

function wrap(inst: ConsolaInstance, redact: Redactor): Logger {
  return {
    withTag: (tag) => wrap(inst.withTag(tag), redact),
    debug: (msg, meta) => inst.debug(redact(msg), meta !== undefined ? redact(meta) : undefined),
    info: (msg, meta) => inst.info(redact(msg), meta !== undefined ? redact(meta) : undefined),
    warn: (msg, meta) => inst.warn(redact(msg), meta !== undefined ? redact(meta) : undefined),
    error: (msg, meta) => inst.error(redact(msg), meta !== undefined ? redact(meta) : undefined),
  }
}
