// Telegram IMAdapter（outbound-only）：
// - start()：调一次 getMe 探活；失败仅 warn，不阻塞 daemon（spec §3 / §6 PM 决策 Q9）
// - stop()：no-op（无 long-poll、无 socket）
// - 不实现 inbound：bot 不接收用户消息
//
// 暴露 scheduledHook 给 daemon runner / CLI 调用（与 SlackAdapterHandle / WechatAdapterHandle 同形态）。

import type { IMAdapter, ImProvider } from '@/im/IMAdapter.ts'
import type { Logger } from '@/logger/logger.ts'
import type { ConversationOrchestrator } from '@/orchestrator/ConversationOrchestrator.ts'
import type { TelegramApi } from './TelegramApi.ts'
import type { TelegramRenderer } from './TelegramRenderer.ts'
import { runScheduledTelegramSession } from './scheduled.ts'

export interface TelegramAdapterDeps {
  api: TelegramApi
  orchestrator: ConversationOrchestrator
  rendererFactory: () => TelegramRenderer
  logger: Logger
}

export interface TelegramScheduledHookArgs {
  taskId: string
  to: string
  prompt: string
}

export interface TelegramScheduledHook {
  run: (args: TelegramScheduledHookArgs) => Promise<void>
}

export interface TelegramAdapterHandle {
  adapter: IMAdapter
  scheduledHook: TelegramScheduledHook
}

export function createTelegramAdapter(deps: TelegramAdapterDeps): TelegramAdapterHandle {
  const log = deps.logger.withTag('telegram')
  let started = false

  const adapter: IMAdapter = {
    id: 'telegram' as ImProvider,

    async start() {
      // 幂等：避免 createApplication 装配期已 start 后 daemon.start() 又调一次
      if (started) return
      started = true
      try {
        const me = await deps.api.getMe()
        log.info('Telegram adapter 已就绪', {
          botUsername: me.username ?? '(unknown)',
          botId: me.id,
        })
      } catch (err) {
        log.warn(
          'Telegram getMe 失败：daemon 仍继续启动；scheduled 触发时会再失败一次以暴露真因',
          { err },
        )
      }
    },

    async stop() {
      // 无 long-poll / socket / 后台任务，没有需要关闭的资源
    },
  }

  const scheduledHook: TelegramScheduledHook = {
    async run(args) {
      await runScheduledTelegramSession({
        taskId: args.taskId,
        to: args.to,
        prompt: args.prompt,
        api: deps.api,
        deps: {
          orchestrator: deps.orchestrator,
          rendererFactory: deps.rendererFactory,
          logger: deps.logger,
        },
      })
    },
  }

  return { adapter, scheduledHook }
}
