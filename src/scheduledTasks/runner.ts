// 定时任务运行器：按 rule.target.im 路由到 slackHook / wechatHook，
// 包裹 try/catch + history 写入（started → success/failed），不二次外发错误（已渲染到目标会话）。
//
// 调用方：scheduler（cron 触发）或 CLI（manual 触发）。

import type { Logger } from '@/logger/logger.ts'
import type { ScheduledTaskRule } from './config.ts'
import type {
  ScheduledTaskRunRecord,
  ScheduledTaskStatus,
  ScheduledTaskTarget,
  ScheduledTaskTrigger,
} from './types.ts'

export interface ScheduledTaskHistory {
  append: (record: ScheduledTaskRunRecord) => Promise<void>
}

export interface SlackScheduledHookLike {
  run: (args: { taskId: string; channelId: string; prompt: string }) => Promise<void>
}

export interface WechatScheduledHookLike {
  run: (args: { taskId: string; to: string; prompt: string }) => Promise<void>
}

export interface CreateScheduledTaskRunnerDeps {
  slackHook?: SlackScheduledHookLike
  wechatHook?: WechatScheduledHookLike
  history: ScheduledTaskHistory
  logger: Logger
}

export interface ScheduledTaskRunner {
  runOnce: (rule: ScheduledTaskRule, trigger: ScheduledTaskTrigger) => Promise<void>
  /** scheduler in-flight 时调用：写一行 skipped，无 started 配对 */
  skip: (rule: ScheduledTaskRule, reason: 'in-flight') => Promise<void>
}

function buildTarget(rule: ScheduledTaskRule): ScheduledTaskTarget {
  if (rule.target.im === 'slack') {
    return { im: 'slack', channelId: rule.target.channelId }
  }
  return { im: 'wechat', to: rule.target.to }
}

function makeRunId(taskId: string, startedAt: string, trigger: ScheduledTaskTrigger): string {
  return `${taskId}:${startedAt}:${trigger}`
}

export function createScheduledTaskRunner(
  deps: CreateScheduledTaskRunnerDeps,
): ScheduledTaskRunner {
  const log = deps.logger.withTag('scheduledTasks:runner')

  async function append(record: ScheduledTaskRunRecord): Promise<void> {
    try {
      await deps.history.append(record)
    } catch (err) {
      log.warn('history.append 失败（忽略）', { err, runId: record.runId, status: record.status })
    }
  }

  return {
    async runOnce(rule, trigger) {
      const startedAt = new Date().toISOString()
      const startedAtMs = Date.now()
      const runId = makeRunId(rule.id, startedAt, trigger)
      const target = buildTarget(rule)

      await append({
        runId,
        taskId: rule.id,
        trigger,
        status: 'started',
        startedAt,
        target,
      })

      const finishWith = async (
        status: ScheduledTaskStatus,
        extras?: { error?: string; finalSummary?: string },
      ): Promise<void> => {
        const endedAt = new Date().toISOString()
        const durationMs = Date.now() - startedAtMs
        await append({
          runId,
          taskId: rule.id,
          trigger,
          status,
          startedAt,
          endedAt,
          durationMs,
          target,
          ...(extras?.error ? { error: extras.error } : {}),
          ...(extras?.finalSummary ? { finalSummary: extras.finalSummary } : {}),
        })
      }

      // 路由 hook
      if (rule.target.im === 'slack') {
        if (!deps.slackHook) {
          log.warn('slack adapter 未启用，跳过', { taskId: rule.id })
          await finishWith('failed', { error: 'adapter-not-enabled' })
          return
        }
        try {
          await deps.slackHook.run({
            taskId: rule.id,
            channelId: rule.target.channelId,
            prompt: rule.prompt,
          })
          await finishWith('success')
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          log.error('slack scheduled hook 执行失败', { taskId: rule.id, err })
          await finishWith('failed', { error: msg })
        }
        return
      }

      if (rule.target.im === 'wechat') {
        if (!deps.wechatHook) {
          log.warn('wechat adapter 未启用，跳过', { taskId: rule.id })
          await finishWith('failed', { error: 'adapter-not-enabled' })
          return
        }
        try {
          await deps.wechatHook.run({
            taskId: rule.id,
            to: rule.target.to,
            prompt: rule.prompt,
          })
          await finishWith('success')
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          log.error('wechat scheduled hook 执行失败', { taskId: rule.id, err })
          await finishWith('failed', { error: msg })
        }
      }
    },

    async skip(rule, reason) {
      const startedAt = new Date().toISOString()
      // scheduler 的 in-flight skip 永远来自 cron 触发；manual 调用不会撞 in-flight（每次新进程）。
      const trigger: ScheduledTaskTrigger = 'cron'
      const runId = makeRunId(rule.id, startedAt, trigger)
      await append({
        runId,
        taskId: rule.id,
        trigger,
        status: 'skipped',
        startedAt,
        target: buildTarget(rule),
        skippedReason: reason,
      })
    },
  }
}
