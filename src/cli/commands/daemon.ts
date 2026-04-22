// daemon 子命令集：start / stop / restart / status / logs / attach
// D1 只实现 start / stop / restart / status（基于 pidfile，无 HTTP）
// logs / attach 将在 D4 实现
import { consola } from 'consola'
import { spawn } from 'node:child_process'
import { existsSync, openSync } from 'node:fs'
import { mkdir, stat } from 'node:fs/promises'
import { resolveWorkspacePaths } from '@/workspace/paths.ts'
import {
  clearDaemonMeta,
  daemonDailyLogFile,
  ensureDaemonDir,
  isProcessAlive,
  readDaemonMeta,
  readDaemonStatus,
} from '@/daemon/daemonFile.ts'

const START_TIMEOUT_MS = 10_000 // 等待子进程写 daemon.json 的最长时间
const STOP_TIMEOUT_MS = 5_000 // SIGTERM 后等待退出的最长时间

export interface DaemonCommandOpts {
  cwd: string
}

// ---------- start ----------
export async function daemonStartCommand(opts: DaemonCommandOpts): Promise<void> {
  const paths = resolveWorkspacePaths(opts.cwd)
  if (!existsSync(paths.root)) {
    consola.error(`未找到 ${paths.root}，请先 agent-slack onboard`)
    process.exit(1)
  }

  const status = await readDaemonStatus(paths)
  if (status.state === 'running') {
    consola.warn(`daemon 已在运行 pid=${status.meta.pid} url=${status.meta.url}`)
    return
  }
  if (status.state === 'stale') {
    consola.info(`清理 stale daemon 元数据 pid=${status.meta.pid}`)
    await clearDaemonMeta(paths)
  }

  await ensureDaemonDir(paths)
  // daemon stdout/stderr 重定向到 logs/daemon-YYYY-MM-DD.log
  await mkdir(paths.logsDir, { recursive: true })
  const logFile = daemonDailyLogFile(paths)
  const logFd = openSync(logFile, 'a')

  // 通过当前 CLI 入口脚本（process.argv[1]）执行隐藏的 __daemon-run 子命令
  // 使用 detached:true + unref 确保 daemon 独立于启动进程生存
  const nodeExec = process.execPath
  const cliEntry = process.argv[1]
  if (!cliEntry) {
    consola.error('无法定位 CLI 入口，请通过 agent-slack 命令调用 daemon start')
    process.exit(1)
  }

  const child = spawn(
    nodeExec,
    [...process.execArgv, cliEntry, '__daemon-run', '--cwd', opts.cwd],
    {
      detached: true,
      stdio: ['ignore', logFd, logFd],
      env: process.env,
    },
  )
  child.unref()

  consola.info(`daemon 子进程已启动 pid=${child.pid}，等待初始化完成…`)

  // 轮询 daemon.json，出现即视为启动成功
  const deadline = Date.now() + START_TIMEOUT_MS
  let meta = await readDaemonMeta(paths)
  while (!meta && Date.now() < deadline) {
    await delay(150)
    meta = await readDaemonMeta(paths)
  }

  if (!meta) {
    consola.error('daemon 启动超时，未在 10s 内写出 daemon.json')
    consola.info(`请查看日志：${logFile}`)
    process.exit(1)
  }

  consola.success(`daemon 已就绪 pid=${meta.pid} url=${meta.url}`)
  consola.info(`日志：${logFile}`)
}

// ---------- stop ----------
export async function daemonStopCommand(opts: DaemonCommandOpts): Promise<void> {
  const paths = resolveWorkspacePaths(opts.cwd)
  const status = await readDaemonStatus(paths)
  if (status.state === 'offline') {
    consola.info('daemon 未运行')
    return
  }
  if (status.state === 'stale') {
    consola.info(`清理 stale daemon 元数据 pid=${status.meta.pid}`)
    await clearDaemonMeta(paths)
    return
  }

  const pid = status.meta.pid
  consola.info(`向 daemon pid=${pid} 发送 SIGTERM`)
  try {
    process.kill(pid, 'SIGTERM')
  } catch (err) {
    consola.warn(`SIGTERM 发送失败：${(err as Error).message}`)
  }

  const deadline = Date.now() + STOP_TIMEOUT_MS
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) break
    await delay(150)
  }

  if (isProcessAlive(pid)) {
    consola.warn('SIGTERM 后 5s 仍存活，发送 SIGKILL')
    try {
      process.kill(pid, 'SIGKILL')
    } catch {
      // ignore
    }
  }

  await clearDaemonMeta(paths)
  consola.success('daemon 已停止')
}

// ---------- restart ----------
export async function daemonRestartCommand(opts: DaemonCommandOpts): Promise<void> {
  await daemonStopCommand(opts)
  await daemonStartCommand(opts)
}

// ---------- status ----------
export async function daemonStatusCommand(opts: DaemonCommandOpts): Promise<void> {
  const paths = resolveWorkspacePaths(opts.cwd)
  const status = await readDaemonStatus(paths)

  if (status.state === 'offline') {
    consola.box('Daemon: offline')
    return
  }
  if (status.state === 'stale') {
    consola.box(
      [
        'Daemon: stale (meta 存在但进程已死)',
        `PID:    ${status.meta.pid}`,
        `Meta:   ${paths.daemonFile}`,
      ].join('\n'),
    )
    return
  }

  const uptimeSec = Math.round((Date.now() - new Date(status.meta.startedAt).getTime()) / 1000)
  const logFile = daemonDailyLogFile(paths)
  const logSize = existsSync(logFile) ? await fileSize(logFile) : 0
  consola.box(
    [
      'Daemon: running',
      `PID:        ${status.meta.pid}`,
      `URL:        ${status.meta.url}`,
      `Dashboard:  ${status.meta.dashboardUrl}`,
      `Version:    ${status.meta.version}`,
      `Started:    ${status.meta.startedAt}`,
      `Uptime:     ${formatUptime(uptimeSec)}`,
      `CWD:        ${status.meta.cwd}`,
      `Log:        ${logFile} (${formatSize(logSize)})`,
    ].join('\n'),
  )
}

// ---------- helpers ----------
function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

async function fileSize(p: string): Promise<number> {
  try {
    const s = await stat(p)
    return s.size
  } catch {
    return 0
  }
}

function formatSize(n: number): string {
  if (n < 1024) return `${n}B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`
  return `${(n / 1024 / 1024).toFixed(1)}MB`
}

function formatUptime(sec: number): string {
  if (sec < 60) return `${sec}s`
  if (sec < 3600) return `${Math.floor(sec / 60)}m${sec % 60}s`
  const h = Math.floor(sec / 3600)
  const m = Math.floor((sec % 3600) / 60)
  return `${h}h${m}m`
}

// 占位给 CLI 注册用：daemon logs / attach 在 D4 实现
export async function daemonLogsCommand(_opts: DaemonCommandOpts): Promise<void> {
  const paths = resolveWorkspacePaths(_opts.cwd)
  consola.info(`（D4 实现）请直接查看：${daemonDailyLogFile(paths)}`)
}

export async function daemonAttachCommand(_opts: DaemonCommandOpts): Promise<void> {
  consola.info('（D4 实现）attach 尚未可用')
}
