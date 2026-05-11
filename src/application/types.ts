import type { IMAdapter } from '@/im/IMAdapter.ts'
import type { AbortRegistry } from '@/orchestrator/AbortRegistry.ts'
import type {
  ScheduledTaskRunner,
  ScheduledTaskScheduler,
} from '@/scheduledTasks/index.ts'

export interface Application {
  start(): Promise<void>
  stop(): Promise<void>
  adapters: IMAdapter[]
  abortRegistry: AbortRegistry<string>
  /**
   * 仅在 .agent-slack/scheduled-tasks.yaml 存在且顶层 enabled:true 时构造。
   * - daemon 模式：scheduler 在 start() 内启动，stop() 内停止
   * - CLI 模式：仅用 runner 手动跑（不启 scheduler）
   */
  scheduledTasks?: {
    runner: ScheduledTaskRunner
    scheduler?: ScheduledTaskScheduler
  }
}
