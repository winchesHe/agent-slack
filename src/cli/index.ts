#!/usr/bin/env node
// agent-slack CLI 入口：commander 路由 + 四个子命令
import { Command } from 'commander'
import { consola } from 'consola'
import { startCommand } from './commands/start.ts'
import { doctorCommand } from './commands/doctor.ts'
import { statusCommand } from './commands/status.ts'
import { onboardCommand } from './commands/onboard.ts'
import pkg from '../../package.json' with { type: 'json' }

const program = new Command()
program
  .name('agent-slack')
  .description('Slack agent 服务（绑定当前目录作为 workspace）')
  .version(pkg.version)

program
  .command('start')
  .description('启动 Slack agent 服务（前台阻塞）')
  .option('--cwd <dir>', 'workspace 目录', process.cwd())
  .action(async (opts: { cwd: string }) => {
    await startCommand({ cwd: opts.cwd })
  })

program
  .command('onboard')
  .description('交互式初始化当前目录为 agent-slack workspace')
  .option('--cwd <dir>', 'workspace 目录', process.cwd())
  .action(async (opts: { cwd: string }) => {
    await onboardCommand({ cwd: opts.cwd })
  })

program
  .command('status')
  .description('查看 workspace 状态')
  .option('--cwd <dir>', 'workspace 目录', process.cwd())
  .action(async (opts: { cwd: string }) => {
    await statusCommand({ cwd: opts.cwd })
  })

program
  .command('doctor')
  .description('环境自检')
  .option('--cwd <dir>', 'workspace 目录', process.cwd())
  .action(async (opts: { cwd: string }) => {
    await doctorCommand({ cwd: opts.cwd })
  })

program.parseAsync().catch((err: unknown) => {
  consola.error(err instanceof Error ? err.message : String(err))
  process.exit(1)
})
