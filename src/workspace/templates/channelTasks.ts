// channel-tasks.yaml 模板生成器（**单一权威**）。
//
// 模板源在 examples/channel-tasks.example.yaml；本文件只负责：
// 1. example mode：原样返回 examples/channel-tasks.example.yaml。
// 2. workspace mode：去掉示例引导注释，前置 workspace 头部说明。

import { CHANNEL_TASKS_EXAMPLE, stripExampleLeadingComments } from './_assets.ts'

export interface GenerateChannelTasksYamlArgs {
  mode: 'example' | 'workspace'
}

const WORKSPACE_HEADER = `# Slack 频道任务监听配置。
# 文件缺失时该功能关闭；enabled=false 时即使配置了规则也不会监听执行。
`

export function generateChannelTasksYaml(args: GenerateChannelTasksYamlArgs): string {
  if (args.mode === 'example') return CHANNEL_TASKS_EXAMPLE
  return WORKSPACE_HEADER + stripExampleLeadingComments(CHANNEL_TASKS_EXAMPLE)
}
