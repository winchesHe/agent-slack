export type ScheduledTaskTarget =
  | { im: 'slack'; channelId: string }
  | { im: 'wechat'; to: string }

export type ScheduledTaskTrigger = 'cron' | 'manual'
export type ScheduledTaskStatus = 'started' | 'success' | 'failed' | 'skipped'

export interface ScheduledTaskRunRecord {
  runId: string
  taskId: string
  trigger: ScheduledTaskTrigger
  status: ScheduledTaskStatus
  startedAt: string
  endedAt?: string
  durationMs?: number
  target: ScheduledTaskTarget
  skippedReason?: 'in-flight'
  error?: string
  finalSummary?: string
}
