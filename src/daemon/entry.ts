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
  writeDaemonMeta,
  type DaemonMeta,
} from '@/daemon/daemonFile.ts'
import pkg from '../../package.json' with { type: 'json' }

export async function runDaemonEntry(opts: { cwd: string }): Promise<void> {
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
  // 启动统一的 HTTP server（dashboard + /api/daemon/*）
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
    consola.error(`daemon 启动 HTTP server 失败：${(err as Error).message}`)
    // 启动失败直接退出，不留残留 meta
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
