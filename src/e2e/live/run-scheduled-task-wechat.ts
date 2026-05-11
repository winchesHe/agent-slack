// 微信定时任务实发验证（spec §6.4 contextToken 持久化路径）。
//
// 前置条件（自己手工准备）：
// 1. 配过一遍 wechat 扫码（`agent-slack daemon start` 跑过一次，凭证写到 .agent-slack/wechat/credentials.json）。
// 2. 那位 target 联系人**先给 bot 发过至少一条入站消息**，daemon 会自动把 context_token
//    落盘到 .agent-slack/wechat/context-tokens.json（per-peer）。
//    自己微信账号的 microid 可在 credentials.json 的 userId 字段查到，用来推到 bot ↔ 自己的私聊。
// 3. .agent-slack/scheduled-tasks.yaml 至少一条 enabled task，target.im=wechat，
//    target.to=<上一步落盘到 context-tokens.json 的 microid>。
//
// 用法：
//   tsx src/e2e/live/run-scheduled-task-wechat.ts <task-id>
//
// 验证点：
// - 进程退出码 0
// - 那位联系人跟 bot 的私聊里实际收到消息（手机微信 / PC 微信肉眼）
// - .agent-slack/logs/scheduled-tasks.jsonl 末尾出现 trigger='manual' 的两行（started + success）
//
// 若 target.to 未命中 store，runScheduledWechatSession 会抛 MissingContextTokenError，
// 退出码仍是 0（runner 内部 catch），但 jsonl 写 'failed' 行，error 字段会告诉你怎么修。

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
