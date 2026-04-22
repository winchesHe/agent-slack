// dashboard 命令：启动本地 HTTP server + 前端 SPA，用于观察 context / sessions / messages / skills / logs / config / health / daemon
import { consola } from 'consola'
import { existsSync } from 'node:fs'
import { spawn } from 'node:child_process'
import path from 'node:path'
import { startDashboardServer } from '@/dashboard/server.ts'
import { createLogger } from '@/logger/logger.ts'
import { createRedactor } from '@/logger/redactor.ts'
import { loadWorkspaceEnv } from '@/workspace/loadEnv.ts'
import { resolveWorkspacePaths } from '@/workspace/paths.ts'
import { loadWorkspaceContext } from '@/workspace/WorkspaceContext.ts'
import { ensureDaemonDir, writeDashboardMeta, clearDashboardMeta } from '@/daemon/daemonFile.ts'

export interface DashboardOpts {
  cwd: string
  host?: string
  port?: number
  open?: boolean
}

export async function dashboardCommand(opts: DashboardOpts): Promise<void> {
  loadWorkspaceEnv({ workspaceDir: opts.cwd })

  // 读取配置获取 daemon 端口，standalone dashboard 默认使用相同端口
  const bootstrapLogger = createLogger({ level: 'warn', redactor: createRedactor([]) })
  const ctx = await loadWorkspaceContext(opts.cwd, bootstrapLogger)
  const defaultPort = ctx.config.daemon.port

  const paths = resolveWorkspacePaths(opts.cwd)

  const configDir = path.join(opts.cwd, '.agent-slack')
  if (!existsSync(configDir)) {
    consola.warn(`未找到 ${configDir}，仍会启动 dashboard（各分区将显示为空或提示缺失）`)
    consola.info('如需完整数据，请先运行 agent-slack onboard')
  }

  // redactor 接收主要凭证，防止日志中泄漏
  const secrets = [
    process.env.SLACK_BOT_TOKEN,
    process.env.SLACK_SIGNING_SECRET,
    process.env.SLACK_APP_TOKEN,
    process.env.LITELLM_API_KEY,
    process.env.ANTHROPIC_API_KEY,
  ].filter((v): v is string => Boolean(v))

  const logger = createLogger({
    level: (process.env.LOG_LEVEL as 'trace' | 'debug' | 'info' | 'warn' | 'error') ?? 'info',
    redactor: createRedactor(secrets),
  })

  const server = await startDashboardServer({
    cwd: opts.cwd,
    host: opts.host ?? ctx.config.daemon.host,
    port: opts.port !== undefined && opts.port !== 0 ? opts.port : defaultPort,
    logger,
  })

  // 写 dashboard.json，供 daemon 检测
  await ensureDaemonDir(paths)
  await writeDashboardMeta(paths, {
    pid: process.pid,
    port: server.port,
    host: server.host,
    url: server.url,
    startedAt: new Date().toISOString(),
    cwd: path.resolve(opts.cwd),
  })

  consola.success(`dashboard running at ${server.url}`)
  consola.info('Ctrl+C 退出')

  if (opts.open) openInBrowser(server.url)
  let shuttingDown = false

  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return
    shuttingDown = true
    consola.info(`收到 ${signal}，关闭 dashboard…`)
    await server.stop()
    await clearDashboardMeta(paths).catch(() => {})
    process.exit(0)
  }
  process.once('SIGINT', () => {
    void shutdown('SIGINT')
  })
  process.once('SIGTERM', () => {
    void shutdown('SIGTERM')
  })
}

function openInBrowser(url: string): void {
  const cmd =
    process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open'
  try {
    const child = spawn(cmd, [url], {
      stdio: 'ignore',
      detached: true,
      shell: process.platform === 'win32',
    })
    child.unref()
  } catch {
    // 打开失败不阻塞 server，静默即可
  }
}
