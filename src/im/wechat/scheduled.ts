// 定时任务的 Wechat 入口：纯函数，不触发 QR 登录。
//
// daemon 模式 / CLI 模式都调它：
// - daemon 通过 WechatAdapterHandle.scheduledHook.run 绑定已 setToken 的 WechatApi；
// - CLI 自己 prepareForManualRun（loadCredentialsOnly + setToken）后直接调本函数。
//
// 流程（spec §5.2 / §6.4）：
// 1. 构造 InboundMessage：channelId/channelName/threadTs/userId/userName 全 = to（单聊语义）；userName='scheduler'；
//    messageTs 由 nowMs 生成（默认 Date.now()），确定性可注入。
// 2. 从 ContextTokenStore 按 to 查 context_token——
//    **微信服务端要求 bot 主动发消息必须带 context_token，由对方上一条入站消息提供**。
//    未命中 → 抛 MissingContextTokenError（runner catch 写 history failed）。
//    解决办法：让那位联系人先给 bot 发一条入站消息，daemon 会自动把 token 落盘到
//    .agent-slack/wechat/context-tokens.json，再跑定时任务即可命中。
// 3. 调 runWechatSession（与 inbound 共享 sink 构造）。

import type { Logger } from '@/logger/logger.ts'
import type { ConversationOrchestrator } from '@/orchestrator/ConversationOrchestrator.ts'
import type { WechatApi } from './WechatApi.ts'
import type { WechatRenderer } from './WechatRenderer.ts'
import type { ContextTokenStore } from './ContextTokenStore.ts'
import { runWechatSession } from './WechatAdapter.ts'

export class MissingContextTokenError extends Error {
  constructor(peerUserId: string) {
    super(
      `没有找到 ${peerUserId} 的 context_token；` +
        `先让该联系人给 bot 发一条入站消息（daemon 会自动落盘 token），再跑定时任务。`,
    )
    this.name = 'MissingContextTokenError'
  }
}

export interface RunScheduledWechatArgs {
  taskId: string
  to: string
  prompt: string
  api: WechatApi
  deps: {
    orchestrator: ConversationOrchestrator
    rendererFactory: () => WechatRenderer
    logger: Logger
    /**
     * per-peer context_token store。必填——拿不到 token 就直接 throw，
     * 由 runner catch 后写 history failed（spec §6.4：微信服务端要求 bot 主动发消息必须带 token）。
     */
    contextTokenStore: ContextTokenStore
    /** 注入用以保证 messageTs 确定性（默认 Date.now） */
    nowMs?: () => number
  }
}

export async function runScheduledWechatSession(args: RunScheduledWechatArgs): Promise<void> {
  const now = args.deps.nowMs?.() ?? Date.now()
  const messageTs = `scheduled-${args.taskId}-${now}`
  const contextToken = args.deps.contextTokenStore.get(args.to)
  if (!contextToken) {
    throw new MissingContextTokenError(args.to)
  }

  await runWechatSession({
    inbound: {
      imProvider: 'wechat',
      channelId: args.to,
      channelName: args.to,
      threadTs: args.to,
      messageTs,
      userId: 'scheduler',
      userName: 'scheduler',
      text: args.prompt,
      // confirmSender 留空：wechat 入站本就不挂 confirm（spec §6.3）
    },
    api: args.api,
    rendererFactory: args.deps.rendererFactory,
    orchestrator: args.deps.orchestrator,
    logger: args.deps.logger,
    contextToken,
  })
}
