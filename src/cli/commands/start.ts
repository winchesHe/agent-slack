// start 命令：校验 .agent-slack/ 存在后调用 createApplication 并阻塞运行
import { consola } from 'consola'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { createApplication } from '@/application/createApplication.ts'

export async function startCommand(opts: { cwd: string }): Promise<void> {
  const configDir = path.join(opts.cwd, '.agent-slack')
  if (!existsSync(configDir)) {
    consola.error(`未找到 ${configDir}`)
    consola.info('请先运行 agent-slack onboard')
    process.exit(1)
  }
  const app = await createApplication({ workspaceDir: opts.cwd })
  await app.start()
  consola.success('agent-slack 已启动，等待 Slack 事件。Ctrl+C 退出。')

  const shutdown = async (signal: string): Promise<void> => {
    consola.info(`收到 ${signal}，正在关闭…`)
    await app.stop()
    app.abortRegistry.abortAll('shutdown')
    process.exit(0)
  }
  process.on('SIGINT', () => {
    void shutdown('SIGINT')
  })
  process.on('SIGTERM', () => {
    void shutdown('SIGTERM')
  })
}
