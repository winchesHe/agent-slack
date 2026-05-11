// 定时任务调度器：基于 croner 注册/启停 cron jobs，in-flight 时 skip。
//
// 行为约定：
// - start() 幂等：重复调用不重复注册
// - stop() 取消所有 cron job；in-flight 的 runOnce 不等待（由 daemon 退出路径决定，spec §6.5）
// - 同一 task 正在跑、cron 又到点 → 调 runner.skip 写一行 skipped，不重入
// - 不同 task 互不影响（各自独立 in-flight 状态）
// - timezone 默认本机时区（Intl.DateTimeFormat().resolvedOptions().timeZone）

import { Cron } from 'croner'
import type { Logger } from '@/logger/logger.ts'
import type { ScheduledTaskRule } from './config.ts'
import type { ScheduledTaskRunner } from './runner.ts'

export interface ScheduledTaskScheduler {
  start: () => void
  stop: () => void
}

/** 抽象一个最小 cron job 句柄，便于测试时注入。 */
export interface CronJobLike {
  stop: () => void
}

/** 工厂签名：传入 cron 表达式 / 时区 / 回调，返回可 stop 的 job 句柄。 */
export type CronFactory = (
  cronExpression: string,
  timezone: string,
  callback: () => void,
) => CronJobLike

const defaultCronFactory: CronFactory = (cron, timezone, callback) =>
  new Cron(cron, { timezone }, callback)

export interface CreateScheduledTaskSchedulerDeps {
  rules: ScheduledTaskRule[]
  runner: ScheduledTaskRunner
  logger: Logger
  /** 测试注入；省略时使用 croner 真实调度。 */
  cronFactory?: CronFactory
}

function defaultTimezone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone
}

export function createScheduledTaskScheduler(
  deps: CreateScheduledTaskSchedulerDeps,
): ScheduledTaskScheduler {
  const log = deps.logger.withTag('scheduledTasks:scheduler')
  const factory = deps.cronFactory ?? defaultCronFactory
  const inFlight = new Map<string, Promise<void>>()
  const jobs: CronJobLike[] = []
  let started = false

  return {
    start() {
      if (started) {
        log.debug('scheduler.start() 已启动，跳过重复调用')
        return
      }
      started = true
      for (const rule of deps.rules) {
        if (!rule.enabled) continue
        const tz = rule.timezone ?? defaultTimezone()
        try {
          const job = factory(rule.cron, tz, () => {
              // 异步回调内做 in-flight 判断；croner 不会等回调完成才进入下次触发，
              // 因此 inFlight Map 是真正的并发守卫。
              if (inFlight.has(rule.id)) {
                // 由 runner 写 skipped（fire-and-forget，错误已在 runner.append 内部 warn）
                void deps.runner.skip(rule, 'in-flight').catch((err) => {
                  log.warn('runner.skip 失败', { err, taskId: rule.id })
                })
                return
              }
              const p = deps.runner
                .runOnce(rule, 'cron')
                .catch((err) => {
                  // runner.runOnce 内部已 catch 所有 hook 错误；进到这里通常是 history 写失败之类，
                  // log warn 即可，不向 croner 抛回（croner 会 logger 抛一个）
                  log.warn('runner.runOnce 异常（runner 兜底应已记录）', { err, taskId: rule.id })
                })
                .finally(() => {
                  inFlight.delete(rule.id)
                })
              inFlight.set(rule.id, p)
            },
          )
          jobs.push(job)
          log.info('注册定时任务', { taskId: rule.id, cron: rule.cron, timezone: tz })
        } catch (err) {
          // 注册时报错（如 timezone 非法）→ 让 daemon 启动阶段就崩，符合"早失败"约定。
          log.error('定时任务注册失败', { taskId: rule.id, err })
          throw err
        }
      }
    },

    stop() {
      for (const job of jobs) {
        try {
          job.stop()
        } catch (err) {
          log.warn('停止 cron job 失败', { err })
        }
      }
      jobs.length = 0
      started = false
    },
  }
}
