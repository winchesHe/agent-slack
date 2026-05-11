// Slack 定时任务实发验证（spec §7.6 标 "建议加，非强制"）。
//
// 前置条件：
// 1. SLACK_BOT_TOKEN / SLACK_APP_TOKEN / SLACK_SIGNING_SECRET 配齐。
// 2. .agent-slack/scheduled-tasks.yaml 至少一条 enabled task，target.im=slack，channelId 是测试频道。
//
// 用法：
//   tsx src/e2e/live/run-scheduled-task-slack.ts <task-id>
//
// 验证点：
// - 进程退出码 0
// - 目标频道出现 `[定时任务: <id>] 启动…` 根帖与后续 agent 回复
// - .agent-slack/logs/scheduled-tasks.jsonl 末尾两行 trigger='manual' started/success

import './load-e2e-env.ts'
import { readFileSync } from 'node:fs'
import { resolveWorkspacePaths } from '@/workspace/paths.ts'
import { runScheduledTaskCli } from '@/cli/commands/scheduledTasks.ts'

async function main() {
  const taskId = process.argv[2]
  if (!taskId) {
    console.error('usage: tsx src/e2e/live/run-scheduled-task-slack.ts <task-id>')
    process.exit(1)
  }
  const cwd = process.cwd()
  const code = await runScheduledTaskCli({ cwd, id: taskId })
  console.log(`runScheduledTaskCli exit code = ${code}`)

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
