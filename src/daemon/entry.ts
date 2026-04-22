// daemon 子进程入口：D1 最小实现
// 启动 createApplication，写 daemon.json，响应信号优雅退出，退出时清理 daemon.json
// D2 会在此基础上加 dashboard server / /api/daemon/* 路由
import { consola } from 'consola'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { createApplication } from '@/application/createApplication.ts'
import { resolveWorkspacePaths } from '@/workspace/paths.ts'
import { loadWorkspaceContext } from '@/workspace/WorkspaceContext.ts'
import { createLogger } from '@/logger/logger.ts'
import { createRedactor } from '@/logger/redactor.ts'
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

  // 提前读 config 获取 daemon.host / port（用于写入 daemon.json）
  // 若 D2 起 HTTP server 在此 host:port 上监听
  const tmpLogger = createLogger({ level: 'warn', redactor: createRedactor([]) })
  const ctx = await loadWorkspaceContext(opts.cwd, tmpLogger)
  const host = ctx.config.daemon.host
  const port = ctx.config.daemon.port

  const app = await createApplication({ workspaceDir: opts.cwd })

  // D1 阶段尚未起 HTTP server；url 先按 config 值写入，D2 会校准为实际监听端口
  const url = `http://${host}:${port}`
  const meta: DaemonMeta = {
    pid: process.pid,
    port,
    host,
    url,
    dashboardUrl: url,
    startedAt: new Date().toISOString(),
    version: pkg.version,
    cwd: path.resolve(opts.cwd),
  }
  await ensureDaemonDir(paths)
  await writeDaemonMeta(paths, meta)

  await app.start()
  consola.success(`agent-slack daemon 已启动 pid=${process.pid} cwd=${opts.cwd}`)

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
}
