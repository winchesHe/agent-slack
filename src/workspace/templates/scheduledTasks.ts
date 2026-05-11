// scheduled-tasks.yaml 模板生成器（**单一权威**）。
//
// 模板源在 examples/scheduled-tasks.example.yaml；本文件只负责：
// 1. example mode：原样返回 examples/scheduled-tasks.example.yaml。
// 2. workspace mode：去掉示例引导注释，前置 workspace 头部说明。

import { SCHEDULED_TASKS_EXAMPLE, stripExampleLeadingComments } from './_assets.ts'

export interface GenerateScheduledTasksYamlArgs {
  mode: 'example' | 'workspace'
}

const WORKSPACE_HEADER = `# agent-slack 定时任务（scheduledTasks）配置。
# 文件缺失时功能关闭；顶层 enabled=false 时即使配置了任务也不会被调度。
`

export function generateScheduledTasksYaml(args: GenerateScheduledTasksYamlArgs): string {
  if (args.mode === 'example') return SCHEDULED_TASKS_EXAMPLE
  return WORKSPACE_HEADER + stripExampleLeadingComments(SCHEDULED_TASKS_EXAMPLE)
}
