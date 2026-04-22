#!/usr/bin/env node
// agent-slack CLI 入口：commander 路由 + 四个子命令
import { Command } from 'commander'
import { consola } from 'consola'
import { startCommand } from './commands/start.ts'
import { doctorCommand } from './commands/doctor.ts'
import { statusCommand } from './commands/status.ts'
import { onboardCommand } from './commands/onboard.ts'
import { dashboardCommand } from './commands/dashboard.ts'
import {
  daemonStartCommand,
  daemonStopCommand,
  daemonRestartCommand,
  daemonStatusCommand,
  daemonLogsCommand,
  daemonAttachCommand,
} from './commands/daemon.ts'
import { runDaemonEntry } from '@/daemon/entry.ts'
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
  .command('dashboard')
  .description('启动本地 web dashboard 观察 context/sessions/messages/skills/logs/config/health')
  .option('--cwd <dir>', 'workspace 目录', process.cwd())
  .option('--host <host>', '监听地址', '127.0.0.1')
  .option('--port <port>', '监听端口（0 自动分配）', (v) => Number(v), 0)
  .action(async (opts: { cwd: string; host: string; port: number }) => {
    await dashboardCommand({ cwd: opts.cwd, host: opts.host, port: opts.port, open: true })
  })

program
  .command('doctor')
  .description('环境自检')
  .option('--cwd <dir>', 'workspace 目录', process.cwd())
  .action(async (opts: { cwd: string }) => {
    await doctorCommand({ cwd: opts.cwd })
  })

// ---------- daemon 子命令集 ----------
const daemon = program
  .command('daemon')
  .description('后台常驻进程控制（start/stop/restart/status/logs/attach）')

daemon
  .command('start')
  .description('启动 daemon（detached 后台运行）')
  .option('--cwd <dir>', 'workspace 目录', process.cwd())
  .action(async (opts: { cwd: string }) => {
    await daemonStartCommand({ cwd: opts.cwd })
  })

daemon
  .command('stop')
  .description('停止 daemon')
  .option('--cwd <dir>', 'workspace 目录', process.cwd())
  .action(async (opts: { cwd: string }) => {
    await daemonStopCommand({ cwd: opts.cwd })
  })

daemon
  .command('restart')
  .description('重启 daemon')
  .option('--cwd <dir>', 'workspace 目录', process.cwd())
  .action(async (opts: { cwd: string }) => {
    await daemonRestartCommand({ cwd: opts.cwd })
  })

daemon
  .command('status')
  .description('查看 daemon 运行状态')
  .option('--cwd <dir>', 'workspace 目录', process.cwd())
  .action(async (opts: { cwd: string }) => {
    await daemonStatusCommand({ cwd: opts.cwd })
  })

daemon
  .command('logs')
  .description('查看 daemon 日志（末尾 N 行，-f 持续跟随）')
  .option('--cwd <dir>', 'workspace 目录', process.cwd())
  .option('-n, --tail <n>', '末尾行数', (v) => Number(v), 200)
  .option('-f, --follow', '持续跟随（tail -f）', false)
  .action(async (opts: { cwd: string; tail: number; follow: boolean }) => {
    await daemonLogsCommand({ cwd: opts.cwd, tail: opts.tail, follow: opts.follow })
  })

daemon
  .command('attach')
  .description('连接 daemon 实时事件流（SSE），Ctrl+C 断开但 daemon 不停')
  .option('--cwd <dir>', 'workspace 目录', process.cwd())
  .action(async (opts: { cwd: string }) => {
    await daemonAttachCommand({ cwd: opts.cwd })
  })

// 隐藏子命令：被 `daemon start` spawn 出的子进程调用
program
  .command('__daemon-run', { hidden: true })
  .description('（内部）daemon 子进程入口，勿直接使用')
  .option('--cwd <dir>', 'workspace 目录', process.cwd())
  .option('--headless', '无头模式（不启动内建 dashboard）', false)
  .action(async (opts: { cwd: string; headless: boolean }) => {
    await runDaemonEntry({ cwd: opts.cwd, headless: opts.headless })
  })

program.parseAsync().catch((err: unknown) => {
  consola.error(err instanceof Error ? err.message : String(err))
  process.exit(1)
})
