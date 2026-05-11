// 定时任务的 Wechat 入口：纯函数，不触发 QR 登录。
//
// daemon 模式 / CLI 模式都调它：
// - daemon 通过 WechatAdapterHandle.scheduledHook.run 绑定已 setToken 的 WechatApi；
// - CLI 自己 loadCredentialsOnly + setToken + 直接调本函数。
//
// 流程（spec §5.2 Wechat 路径 + §6.4 风险条目）：
// 1. 构造 InboundMessage：channelId/channelName/threadTs/userId/userName 全 = to（单聊语义）；userName='scheduler'；
//    messageTs 由 nowMs 生成（默认 Date.now()），确定性可注入。
// 2. contextToken: '' —— 定时任务无对方入站消息可锚（filehelper 验证可用，非 filehelper 暂不支持）。
// 3. 调 runWechatSession（与 inbound 共享 sink 构造）。

import type { Logger } from '@/logger/logger.ts'
import type { ConversationOrchestrator } from '@/orchestrator/ConversationOrchestrator.ts'
import type { WechatApi } from './WechatApi.ts'
import type { WechatRenderer } from './WechatRenderer.ts'
import { runWechatSession } from './WechatAdapter.ts'

export interface RunScheduledWechatArgs {
  taskId: string
  to: string
  prompt: string
  api: WechatApi
  deps: {
    orchestrator: ConversationOrchestrator
    rendererFactory: () => WechatRenderer
    logger: Logger
    /** 注入用以保证 messageTs 确定性（默认 Date.now） */
    nowMs?: () => number
  }
}

export async function runScheduledWechatSession(args: RunScheduledWechatArgs): Promise<void> {
  const now = args.deps.nowMs?.() ?? Date.now()
  const messageTs = `scheduled-${args.taskId}-${now}`

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
    // spec §6.4：定时任务无入站消息上下文，contextToken 必然为空；filehelper 经验可用。
    contextToken: '',
  })
}
