import { consola } from 'consola'
import { createApplication } from '@/application/createApplication.ts'

async function main(): Promise<void> {
  const app = await createApplication({ workspaceDir: process.cwd() })
  await app.start()
  consola.success('agent-slack 已启动，等待 Slack 事件。Ctrl+C 退出。')

  const shutdown = async (signal: string): Promise<void> => {
    consola.info(`收到 ${signal}，正在关闭…`)
    await app.stop()
    process.exit(0)
  }
  process.on('SIGINT', () => {
    void shutdown('SIGINT')
  })
  process.on('SIGTERM', () => {
    void shutdown('SIGTERM')
  })
}

main().catch((err: unknown) => {
  consola.error(err)
  process.exit(1)
})
