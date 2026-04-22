// daemon 子进程入口：D2 实现
// 启动 createApplication + dashboard HTTP server（含 /api/daemon/*）
// 写 daemon.json（含真实监听端口），响应信号优雅退出
import { consola } from 'consola'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { createApplication } from '@/application/createApplication.ts'
import { resolveWorkspacePaths } from '@/workspace/paths.ts'
import { loadWorkspaceContext } from '@/workspace/WorkspaceContext.ts'
import { createLogger } from '@/logger/logger.ts'
import { createRedactor } from '@/logger/redactor.ts'
import { startDashboardServer, type DashboardServer } from '@/dashboard/server.ts'
import {
  clearDaemonMeta,
  ensureDaemonDir,
  readDashboardMeta,
  writeDaemonMeta,
  type DaemonMeta,
} from '@/daemon/daemonFile.ts'
import pkg from '../../package.json' with { type: 'json' }

export async function runDaemonEntry(opts: { cwd: string; headless?: boolean }): Promise<void> {
  const paths = resolveWorkspacePaths(opts.cwd)
  const configDir = paths.root
  if (!existsSync(configDir)) {
    consola.error(`未找到 ${configDir}`)
    consola.info('请先运行 agent-slack onboard')
    process.exit(1)
  }

  // 提前读 config 获取 daemon.host / port
  const bootstrapLogger = createLogger({ level: 'warn', redactor: createRedactor([]) })
  const ctx = await loadWorkspaceContext(opts.cwd, bootstrapLogger)
  const host = ctx.config.daemon.host
  const port = ctx.config.daemon.port

  const app = await createApplication({ workspaceDir: opts.cwd })

  const startedAt = new Date().toISOString()

  if (opts.headless) {
    // headless 模式：不启动 HTTP server，从 dashboard.json 获取 dashboard URL
    const dashboardMeta = await readDashboardMeta(paths)
    const dashboardUrl = dashboardMeta?.url ?? `http://${host}:${port}`

    const meta: DaemonMeta = {
      pid: process.pid,
      port: 0,
      host,
      url: '',
      dashboardUrl,
      startedAt,
      version: pkg.version,
      cwd: path.resolve(opts.cwd),
      mode: 'headless',
    }
    await ensureDaemonDir(paths)
    await writeDaemonMeta(paths, meta)

    await app.start()
    consola.success(`agent-slack daemon 已启动 (headless) pid=${process.pid}`)

    let shuttingDown = false
    const shutdown = async (signal: string): Promise<void> => {
      if (shuttingDown) return
      shuttingDown = true
      consola.info(`daemon 收到 ${signal}，正在关闭…`)
      try {
        await app.stop()
        app.abortRegistry.abortAll('shutdown')
      } finally {
        await clearDaemonMeta(paths)
        process.exit(0)
      }
    }
    process.on('SIGINT', () => {
      void shutdown('SIGINT')
    })
    process.on('SIGTERM', () => {
      void shutdown('SIGTERM')
    })
    process.on('uncaughtException', async (err) => {
      consola.error('daemon uncaughtException:', err)
      await clearDaemonMeta(paths).catch(() => {})
      process.exit(1)
    })
    return
  }

  // embedded 模式：启动统一的 HTTP server（dashboard + /api/daemon/*）
  let server: DashboardServer
  try {
    server = await startDashboardServer({
      cwd: opts.cwd,
      host,
      port,
      logger: bootstrapLogger,
      daemon: {
        app,
        startedAt,
        version: pkg.version,
        cwd: path.resolve(opts.cwd),
      },
    })
  } catch (err) {
    const msg =
      (err as NodeJS.ErrnoException).code === 'EADDRINUSE'
        ? `daemon 启动失败：${host}:${port} 已被占用\n` +
          `可能是上次 daemon 进程未正常退出；请运行：\n` +
          `  lsof -i :${port} -P -n | awk 'NR>1{print $2}' | xargs kill\n` +
          `或在 .agent-slack/config.yaml 修改 daemon.port 后重试`
        : `daemon 启动 HTTP server 失败：${(err as Error).message}`
    consola.error(msg)
    process.exit(1)
  }

  const meta: DaemonMeta = {
    pid: process.pid,
    port: server.port,
    host: server.host,
    url: server.url,
    dashboardUrl: server.url,
    startedAt,
    version: pkg.version,
    cwd: path.resolve(opts.cwd),
    mode: 'embedded',
  }
  await ensureDaemonDir(paths)
  await writeDaemonMeta(paths, meta)

  await app.start()
  consola.success(`agent-slack daemon 已启动 pid=${process.pid} url=${server.url}`)

  let shuttingDown = false
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return
    shuttingDown = true
    consola.info(`daemon 收到 ${signal}，正在关闭…`)
    try {
      await server.stop().catch(() => {})
      await app.stop()
      app.abortRegistry.abortAll('shutdown')
    } finally {
      await clearDaemonMeta(paths)
      process.exit(0)
    }
  }
  process.on('SIGINT', () => {
    void shutdown('SIGINT')
  })
  process.on('SIGTERM', () => {
    void shutdown('SIGTERM')
  })
  process.on('uncaughtException', async (err) => {
    consola.error('daemon uncaughtException:', err)
    await clearDaemonMeta(paths).catch(() => {})
    process.exit(1)
  })
}
