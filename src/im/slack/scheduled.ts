// 定时任务的 Slack 入口：纯函数，不依赖 Bolt App。
//
// daemon 模式 / CLI 模式都调它：
// - daemon 通过 SlackAdapterHandle.scheduledHook.run 绑定 Bolt App.client；
// - CLI 自己 new WebClient(token) 后直接调本函数。
//
// 两种 rootBehavior：
// 1. 'text-placeholder'（默认 / 历史）：
//    - 用 chat.postMessage 发"启动"根帖到 channelId，拿到 root ts；
//    - threadTs=messageTs=rootTs，sink 把 LLM streaming text 自动渲染到该 thread；
//    - agent 在 prompt 里可以用 thread_ts 反查根帖发附件。
// 2. 'image-first'：
//    - **不发任何根帖**，sink 用 silent 版本，所有 LLM streaming text 都不自动落 Slack；
//    - prompt 前缀注入 channelId / taskId 信息，agent 自己在 prompt 里用
//      files_upload（无 thread_ts）把图片作为 channel 顶层根帖发出，
//      再用 thread_ts 把后续资讯发到 thread；
//    - 适用于"图片做根帖、资讯进 thread"这种由 agent 自己掌握消息节奏的场景。

import type { WebClient } from '@slack/web-api'
import type { Logger } from '@/logger/logger.ts'
import type { ConversationOrchestrator } from '@/orchestrator/ConversationOrchestrator.ts'
import { runSlackSession } from './SlackAdapter.ts'
import { createSilentSlackEventSink } from './SlackEventSink.ts'
import type { SlackRenderer } from './SlackRenderer.ts'

export interface RunScheduledSlackArgs {
  taskId: string
  channelId: string
  prompt: string
  /** task.description（来自 yaml），用于非 aihot 任务的 thread root 文案；缺省时回退到 taskId */
  description?: string
  /** 根帖行为；缺省按 'text-placeholder'（历史默认） */
  rootBehavior?: 'text-placeholder' | 'image-first'
  web: WebClient
  deps: {
    orchestrator: ConversationOrchestrator
    renderer: SlackRenderer
    workspaceLabel?: string
    logger: Logger
  }
}

/**
 * aihot 任务的 prompt 依赖 thread root 以 "🎯 【战略级抓手" 开头来挑根帖（用于后续图片上传），
 * 保留原文案；其它任务用 description 让用户知道 thread 是谁起的。
 */
function buildRootText(taskId: string, description: string | undefined): string {
  if (taskId === 'aihot') {
    return `🎯 【战略级抓手 · aihot-咨询】对齐中，赋能即将下发...`
  }
  return description?.trim() || taskId
}

/**
 * image-first 模式下，agent 没有 sink 自动渲染兜底，必须在 prompt 里全程显式发消息。
 * 这里把 channelId / taskId 等运行时上下文注入到 prompt 顶部，agent 才知道往哪个 channel 发图。
 */
function buildImageFirstPrompt(args: { taskId: string; channelId: string; userPrompt: string }): string {
  return [
    '<scheduled_task_context>',
    `task_id: ${args.taskId}`,
    `channel_id: ${args.channelId}`,
    `root_behavior: image-first`,
    '',
    '本次运行为 image-first 模式：',
    '- runner 不会主动发任何根帖；sink 也不会把你的 streaming 文本自动渲染到 Slack。',
    '- 你必须在 prompt 内的 bash 命令里全程显式发送 Slack 消息：',
    '  1) 第一条消息一定是把生成的图片 files_upload 到 channel 顶层（**不传 --thread-ts**），',
    '     拿到这条 file message 的 ts 作为后续 thread root。',
    '  2) 后续所有文字 / 附加内容用 chat.postMessage 或 files_upload 时**必须**带 --thread-ts <root_ts>，',
    '     否则会变成 channel 顶层的新孤儿消息。',
    '- 你输出的 markdown 文本不会被自动渲染到 Slack，仅作为内部推理；最终落地完全靠你显式调用的 bash 命令。',
    '</scheduled_task_context>',
    '',
    args.userPrompt,
  ].join('\n')
}

export async function runScheduledSlackSession(args: RunScheduledSlackArgs): Promise<void> {
  const behavior = args.rootBehavior ?? 'text-placeholder'

  if (behavior === 'image-first') {
    // 没有真实的 Slack root；用 taskId + 时间戳构造一个独特的 session key 占位，
    // 避免并发 / 连续两次同 taskId 跑撞到同一个 sessionStore key。
    const placeholderTs = `scheduled-image-first:${args.taskId}:${Date.now()}`
    await args.deps.orchestrator.handle(
      {
        imProvider: 'slack',
        channelId: args.channelId,
        channelName: args.channelId,
        threadTs: placeholderTs,
        messageTs: placeholderTs,
        userId: 'scheduler',
        userName: 'scheduler',
        text: buildImageFirstPrompt({
          taskId: args.taskId,
          channelId: args.channelId,
          userPrompt: args.prompt,
        }),
        // confirmSender 留空 → toolsBuilder 不挂载 confirm tool
      },
      createSilentSlackEventSink({ logger: args.deps.logger }),
    )
    return
  }

  // 'text-placeholder'：保留原 daemon 路径行为
  const root = (await args.web.chat.postMessage({
    channel: args.channelId,
    text: buildRootText(args.taskId, args.description),
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
