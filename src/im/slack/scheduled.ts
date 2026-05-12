// 定时任务的 Slack 入口：纯函数，不依赖 Bolt App。
//
// daemon 模式 / CLI 模式都调它：
// - daemon 通过 SlackAdapterHandle.scheduledHook.run 绑定 Bolt App.client；
// - CLI 自己 new WebClient(token) 后直接调本函数。
//
// 流程（spec §5.2 Slack 路径）：
// 1. 用 chat.postMessage 发"启动"根帖到 channelId，拿到 root ts。
// 2. 构造 InboundMessage：channelId 不变；threadTs=messageTs=rootTs；userId/userName='scheduler'；无 confirmSender。
// 3. 调 runSlackSession（与 inbound 共享 sink 构造），shouldSuppressUsage 留空（定时任务不参与 runQueue）。

import type { WebClient } from '@slack/web-api'
import type { Logger } from '@/logger/logger.ts'
import type { ConversationOrchestrator } from '@/orchestrator/ConversationOrchestrator.ts'
import type { SlackRenderer } from './SlackRenderer.ts'
import { runSlackSession } from './SlackAdapter.ts'

export interface RunScheduledSlackArgs {
  taskId: string
  channelId: string
  prompt: string
  web: WebClient
  deps: {
    orchestrator: ConversationOrchestrator
    renderer: SlackRenderer
    workspaceLabel?: string
    logger: Logger
  }
}

export async function runScheduledSlackSession(args: RunScheduledSlackArgs): Promise<void> {
  const root = (await args.web.chat.postMessage({
    channel: args.channelId,
    text: `🎯 【战略级抓手 · aihot-咨询】对齐中，赋能即将下发...`,
  })) as { ok?: boolean; ts?: string }

  if (!root.ok || !root.ts) {
    throw new Error('root-post-failed')
  }

  const rootTs = root.ts

  await runSlackSession({
    inbound: {
      imProvider: 'slack',
      channelId: args.channelId,
      // 不主动 resolve channelName（无 client cache 上下文）；fallback 到 channelId 即可。
      channelName: args.channelId,
      threadTs: rootTs,
      messageTs: rootTs,
      userId: 'scheduler',
      userName: 'scheduler',
      text: args.prompt,
      // confirmSender 留空 → toolsBuilder 不挂载 confirm tool（spec §6.3）
    },
    web: args.web,
    renderer: args.deps.renderer,
    orchestrator: args.deps.orchestrator,
    logger: args.deps.logger,
    ...(args.deps.workspaceLabel ? { workspaceLabel: args.deps.workspaceLabel } : {}),
    // 定时任务不参与 runQueue，shouldSuppressUsage 留空（sink 内置不抑制）
  })
}
