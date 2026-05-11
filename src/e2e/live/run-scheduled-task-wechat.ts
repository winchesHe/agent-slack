// 微信定时任务实发验证（spec §6.4 强制 filehelper 验证）。
//
// 前置条件（自己手工准备）：
// 1. 配过一遍 wechat 扫码（`agent-slack daemon start` 跑过一次，凭证写到 .agent-slack/wechat/credentials.json）。
// 2. .agent-slack/scheduled-tasks.yaml 至少一条 enabled task，target.im=wechat，target.to=filehelper。
//
// 用法：
//   tsx src/e2e/live/run-scheduled-task-wechat.ts <task-id>
//
// 验证点：
// - 进程退出码 0
// - filehelper 实际收到消息（肉眼 / 手机微信 / PC 微信）
// - .agent-slack/logs/scheduled-tasks.jsonl 末尾出现 trigger='manual' 的两行（started + success）

import { readFileSync } from 'node:fs'
import { resolveWorkspacePaths } from '@/workspace/paths.ts'
import { runScheduledTaskCli } from '@/cli/commands/scheduledTasks.ts'

async function main() {
  const taskId = process.argv[2]
  if (!taskId) {
    console.error('usage: tsx src/e2e/live/run-scheduled-task-wechat.ts <task-id>')
    process.exit(1)
  }
  const cwd = process.cwd()
  const code = await runScheduledTaskCli({ cwd, id: taskId })
  console.log(`runScheduledTaskCli exit code = ${code}`)

  // 读 jsonl 末尾，便于人工核对
  const paths = resolveWorkspacePaths(cwd)
  try {
    const raw = readFileSync(paths.scheduledTasksLogFile, 'utf8')
    const lines = raw.trim().split('\n').slice(-4)
    console.log(`末尾 ${lines.length} 行历史:`)
    for (const line of lines) console.log('  ' + line)
  } catch (err) {
    console.warn('读取 history 文件失败:', err instanceof Error ? err.message : err)
  }

  process.exit(code)
}

void main()
