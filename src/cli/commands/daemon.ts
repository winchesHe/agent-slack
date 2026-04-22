// daemon 子命令集：start / stop / restart / status / logs / attach
// D1 只实现 start / stop / restart / status（基于 pidfile，无 HTTP）
// logs / attach 将在 D4 实现
import { consola } from 'consola'
import path from 'node:path'
import net from 'node:net'
import { spawn } from 'node:child_process'
import { existsSync, openSync } from 'node:fs'
import { mkdir, stat } from 'node:fs/promises'
import { resolveWorkspacePaths } from '@/workspace/paths.ts'
import { loadWorkspaceContext } from '@/workspace/WorkspaceContext.ts'
import { createLogger } from '@/logger/logger.ts'
import { createRedactor } from '@/logger/redactor.ts'
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

  // 读取配置获取 daemon 端口，检测端口是否已被占用
  const bootstrapLogger = createLogger({ level: 'warn', redactor: createRedactor([]) })
  const ctx = await loadWorkspaceContext(opts.cwd, bootstrapLogger)
  const daemonPort = ctx.config.daemon.port
  const daemonHost = ctx.config.daemon.host
  // 检测端口是否已被本 workspace 的独立 dashboard 占用
  let headless = false
  if (daemonPort > 0 && (await isPortInUse(daemonHost, daemonPort))) {
    // 探测是否是本 workspace 的 agent-slack dashboard
    const isDashboard = await probeAgentSlackDashboard(
      daemonHost,
      daemonPort,
      path.resolve(opts.cwd),
    )
    if (isDashboard) {
      consola.info(
        `检测到独立 dashboard 已在 ${daemonHost}:${daemonPort} 运行，daemon 将以无头模式启动`,
      )
      headless = true
    } else {
      consola.error(
        `端口 ${daemonHost}:${daemonPort} 已被占用，daemon 无法启动\n` +
          `可能是上次 daemon 进程未正常退出；请运行：\n` +
          `  lsof -i :${daemonPort} -P -n | awk 'NR>1{print $2}' | xargs kill\n` +
          `或在 .agent-slack/config.yaml 修改 daemon.port 后重试`,
      )
      process.exit(1)
    }
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

  const spawnArgs = [...process.execArgv, cliEntry, '__daemon-run', '--cwd', opts.cwd]
  if (headless) spawnArgs.push('--headless')

  const child = spawn(nodeExec, spawnArgs, {
    detached: true,
    stdio: ['ignore', logFd, logFd],
    env: process.env,
  })
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

  if (meta.mode === 'headless') {
    consola.success(`daemon 已就绪 (headless) pid=${meta.pid}`)
    consola.info(`dashboard：${meta.dashboardUrl}`)
  } else {
    consola.success(`daemon 已就绪 pid=${meta.pid} url=${meta.url}`)
  }
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
  const mode = status.meta.mode ?? 'embedded'
  consola.box(
    [
      'Daemon: running',
      `Mode:       ${mode}`,
      `PID:        ${status.meta.pid}`,
      ...(mode === 'embedded' ? [`URL:        ${status.meta.url}`] : []),
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
// 尝试连接指定端口，判断是否已被占用
function isPortInUse(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new net.Socket()
    socket.once('connect', () => {
      socket.destroy()
      resolve(true)
    })
    socket.once('error', () => {
      socket.destroy()
      resolve(false)
    })
    socket.connect(port, host)
  })
}

// 探测指定端口是否运行着本 workspace 的 agent-slack dashboard
async function probeAgentSlackDashboard(host: string, port: number, cwd: string): Promise<boolean> {
  try {
    const ctrl = new AbortController()
    const timeout = setTimeout(() => ctrl.abort(), 2000)
    const resp = await fetch(`http://${host}:${port}/api/meta`, { signal: ctrl.signal })
    clearTimeout(timeout)
    if (!resp.ok) return false
    const body = (await resp.json()) as { app?: string; cwd?: string }
    return body.app === 'agent-slack-dashboard' && path.resolve(body.cwd ?? '') === cwd
  } catch {
    return false
  }
}

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

// ---------- logs ----------
export async function daemonLogsCommand(
  opts: DaemonCommandOpts & { tail?: number; follow?: boolean },
): Promise<void> {
  const paths = resolveWorkspacePaths(opts.cwd)
  const logFile = daemonDailyLogFile(paths)
  if (!existsSync(logFile)) {
    consola.warn(`日志文件不存在：${logFile}`)
    return
  }
  const tailN = opts.tail ?? 200

  // 先打印已有的末尾 tailN 行
  const initial = await readLastLines(logFile, tailN)
  process.stdout.write(initial)

  if (!opts.follow) return

  // follow 模式：每 500ms 轮询文件 size，增量读取
  consola.info(`--follow 中，Ctrl+C 退出`)
  const { open } = await import('node:fs/promises')
  const handle = await open(logFile, 'r')
  let pos = (await handle.stat()).size
  let closed = false

  const readIncremental = async (): Promise<void> => {
    if (closed) return
    try {
      const st = await handle.stat()
      if (st.size < pos) {
        // 文件被截断 / 轮转，重置
        pos = 0
      }
      if (st.size > pos) {
        const buf = Buffer.alloc(st.size - pos)
        await handle.read(buf, 0, buf.length, pos)
        pos = st.size
        process.stdout.write(buf.toString('utf8'))
      }
    } catch {
      // ignore
    }
  }

  const timer = setInterval(() => {
    void readIncremental()
  }, 500)

  const onSig = async (): Promise<void> => {
    closed = true
    clearInterval(timer)
    await handle.close().catch(() => {})
    process.exit(0)
  }
  process.on('SIGINT', () => {
    void onSig()
  })
  process.on('SIGTERM', () => {
    void onSig()
  })

  // keep the process alive
  await new Promise<void>(() => {})
}

// ---------- attach ----------
export async function daemonAttachCommand(opts: DaemonCommandOpts): Promise<void> {
  const paths = resolveWorkspacePaths(opts.cwd)
  const status = await readDaemonStatus(paths)
  if (status.state !== 'running') {
    consola.error(`daemon 未运行（${status.state}）`)
    process.exit(1)
  }

  const url = `${status.meta.url}/api/stream`
  consola.info(`连接 ${url}（SSE），Ctrl+C 退出`)

  // 使用 fetch 流式读 SSE
  const ctrl = new AbortController()
  const onSig = (): void => {
    ctrl.abort()
    process.exit(0)
  }
  process.on('SIGINT', onSig)
  process.on('SIGTERM', onSig)

  let resp: Response
  try {
    resp = await fetch(url, { signal: ctrl.signal })
  } catch (err) {
    consola.error(`连接失败：${(err as Error).message}`)
    process.exit(1)
  }
  if (!resp.ok || !resp.body) {
    consola.error(`HTTP ${resp.status}`)
    process.exit(1)
  }

  const reader = resp.body.getReader()
  const decoder = new TextDecoder('utf-8')
  let buf = ''
  while (true) {
    const { value, done } = await reader.read()
    if (done) break
    buf += decoder.decode(value, { stream: true })
    // 按 \n\n 切 event
    let idx: number
    while ((idx = buf.indexOf('\n\n')) >= 0) {
      const evBlock = buf.slice(0, idx)
      buf = buf.slice(idx + 2)
      printSseEvent(evBlock)
    }
  }
}

function printSseEvent(block: string): void {
  let eventName = 'message'
  const dataLines: string[] = []
  for (const line of block.split('\n')) {
    if (line.startsWith('event:')) eventName = line.slice(6).trim()
    else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim())
  }
  if (dataLines.length === 0) return
  const data = dataLines.join('\n')
  // 尝试 pretty print JSON
  try {
    const js = JSON.parse(data) as unknown
    process.stdout.write(`[${new Date().toISOString()}] ${eventName} ${JSON.stringify(js)}\n`)
  } catch {
    process.stdout.write(`[${new Date().toISOString()}] ${eventName} ${data}\n`)
  }
}

// 读文件末尾 N 行（简单实现：整读→split→取末尾；daemon log 通常不会太大）
async function readLastLines(filePath: string, n: number): Promise<string> {
  const { readFile } = await import('node:fs/promises')
  const content = await readFile(filePath, 'utf8')
  const lines = content.split('\n')
  const slice = lines.slice(-n - 1) // -n-1 因末尾通常有空行
  return slice.join('\n')
}
