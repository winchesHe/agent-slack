import { consola } from 'consola'

async function main(): Promise<void> {
  consola.info('agent-slack dev entry (placeholder)')
  consola.info('完整启动逻辑将在 Task 3.6 接入 createApplication')
}

main().catch((err) => {
  consola.error(err)
  process.exit(1)
})
