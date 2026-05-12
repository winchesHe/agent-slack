// 定时任务的 Telegram 入口：纯函数，无凭证 preflight（telegram outbound 是无状态的）。
//
// daemon 与 CLI 都调它（CLI 不需要 prepareForManualRun，因为 telegram 没有扫码 / token 切换）。
//
// 流程（spec §5.2）：
// 1. 构造 InboundMessage：channelId/channelName/threadTs 都 = chatId（per-chat 单会话）；userName='scheduler'
// 2. 装 TelegramEventSink → 调 orchestrator.handle

import type { Logger } from '@/logger/logger.ts'
import type { ConversationOrchestrator } from '@/orchestrator/ConversationOrchestrator.ts'
import type { TelegramApi } from './TelegramApi.ts'
import type { TelegramRenderer } from './TelegramRenderer.ts'
import { createTelegramEventSink } from './TelegramEventSink.ts'

export interface RunScheduledTelegramArgs {
  taskId: string
  /** 数字 chat_id 字符串形式 */
  to: string
  prompt: string
  api: TelegramApi
  deps: {
    orchestrator: ConversationOrchestrator
    rendererFactory: () => TelegramRenderer
    logger: Logger
    /** 注入用以保证 messageTs 确定性（默认 Date.now） */
    nowMs?: () => number
  }
}

export async function runScheduledTelegramSession(args: RunScheduledTelegramArgs): Promise<void> {
  const now = args.deps.nowMs?.() ?? Date.now()
  const messageTs = `scheduled-${args.taskId}-${now}`

  const sink = createTelegramEventSink({
    api: args.api,
    renderer: args.deps.rendererFactory(),
    chatId: args.to,
    logger: args.deps.logger,
  })

  await args.deps.orchestrator.handle(
    {
      imProvider: 'telegram',
      channelId: args.to,
      channelName: args.to,
      threadTs: args.to,
      messageTs,
      userId: 'scheduler',
      userName: 'scheduler',
      text: args.prompt,
      // confirmSender 留空：telegram outbound 不挂 confirm
    },
    sink,
  )
}
