import { spawn } from 'node:child_process'
import { tool } from 'ai'
import { z } from 'zod'
import type { ConfirmSender } from '@/im/types.ts'

export interface ToolContext {
  cwd: string
  logger: {
    debug(m: string, meta?: unknown): void
    info(m: string, meta?: unknown): void
    warn(m: string, meta?: unknown): void
    error(m: string, meta?: unknown): void
    withTag(t: string): ToolContext['logger']
  }
  /** 当前用户（per-handle 由 Orchestrator 注入）；组件 wiring 时缺失。 */
  currentUser?: { userName: string; userId: string }
  /** 当前会话的确认发送器，由 IM Adapter 绑定 channel/thread 后注入；无 IM 时为 undefined。 */
  confirm?: ConfirmSender
}

const MAX_BYTES = 30_000
const DEFAULT_TIMEOUT = 60_000
const MAX_TIMEOUT = 600_000

function truncate(s: string): string {
  if (s.length <= MAX_BYTES) return s
  return s.slice(0, MAX_BYTES) + '\n…[truncated]'
}

export interface BashResult {
  stdout: string
  stderr: string
  exitCode: number
  timedOut: boolean
}

export function bashTool(ctx: ToolContext) {
  return tool({
    description:
      '在 workspace 下执行 bash 命令。可用于读文件（cat）、列目录（ls）、搜索（rg / grep）、写文件（tee / >）、运行脚本。不适合精确原位替换——用 edit_file。',
    parameters: z.object({
      cmd: z.string().min(1),
      timeout_ms: z.number().int().positive().max(MAX_TIMEOUT).optional(),
    }),
    async execute({ cmd, timeout_ms }): Promise<BashResult> {
      const log = ctx.logger.withTag('bash')
      log.info(`执行命令: ${cmd}`)
      const timeout = timeout_ms ?? DEFAULT_TIMEOUT
      return await new Promise<BashResult>((resolve) => {
        const child = spawn('bash', ['-c', cmd], { cwd: ctx.cwd })
        let stdout = ''
        let stderr = ''
        let timedOut = false
        const timer = setTimeout(() => {
          timedOut = true
          child.kill('SIGKILL')
        }, timeout)
        child.stdout.on('data', (b: Buffer) => {
          stdout += b.toString('utf8')
        })
        child.stderr.on('data', (b: Buffer) => {
          stderr += b.toString('utf8')
        })
        child.on('close', (code) => {
          clearTimeout(timer)
          resolve({
            stdout: truncate(stdout),
            stderr: truncate(stderr),
            exitCode: timedOut ? -1 : (code ?? -1),
            timedOut,
          })
        })
      })
    },
  })
}
