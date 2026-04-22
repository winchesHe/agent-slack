import { consola, type ConsolaInstance } from 'consola'
import fs from 'node:fs'
import path from 'node:path'
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

export interface CreateLoggerOpts {
  level?: 'trace' | 'debug' | 'info' | 'warn' | 'error'
  redactor: Redactor
  /**
   * 可选：若提供文件路径，日志会同时 append 写入（不影响 stdout）。
   * 父目录不存在会自动创建。用于 dashboard Logs tab 离线查看。
   */
  logFile?: string
}

export function createLogger(opts: CreateLoggerOpts): Logger {
  const root = consola.create({ level: levelToNumeric(opts.level ?? 'info') })
  if (opts.logFile) {
    attachFileReporter(root, opts.logFile, opts.redactor)
  }
  return wrap(root, opts.redactor)
}

function attachFileReporter(inst: ConsolaInstance, filePath: string, redact: Redactor): void {
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true })
  } catch {
    // 目录创建失败时静默关闭 file reporter，避免阻塞 stdout logger 的正常工作
    return
  }
  inst.addReporter({
    log(logObj) {
      const ts = new Date().toISOString()
      const level = (logObj as { type?: string }).type ?? 'log'
      const tag = (logObj as { tag?: string }).tag
      const rawArgs = (logObj as { args?: unknown[] }).args ?? []
      const parts = rawArgs.map((a) => {
        if (typeof a === 'string') return a
        try {
          return JSON.stringify(a)
        } catch {
          return String(a)
        }
      })
      const line = `[${ts}] [${level}]${tag ? ` [${tag}]` : ''} ${redact(parts.join(' '))}\n`
      fs.appendFile(filePath, line, () => {
        // 写失败不抛错，避免影响主流程
      })
    },
  })
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
