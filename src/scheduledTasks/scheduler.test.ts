import { describe, expect, it, vi } from 'vitest'
import {
  createScheduledTaskScheduler,
  type CronFactory,
  type CronJobLike,
} from './scheduler.ts'
import type { ScheduledTaskRule } from './config.ts'
import type { ScheduledTaskRunner } from './runner.ts'

function stubLogger() {
  const noop = () => {}
  return {
    debug: noop,
    info: noop,
    warn: noop,
    error: noop,
    withTag: () => stubLogger(),
  } as never
}

function rule(id: string, cron = '0 9 * * *'): ScheduledTaskRule {
  return {
    id,
    enabled: true,
    cron,
    prompt: 'p',
    target: { im: 'slack', channelId: 'C0123456789' },
  } as ScheduledTaskRule
}

function makeRunner(overrides: Partial<ScheduledTaskRunner> = {}): ScheduledTaskRunner {
  return {
    runOnce: vi.fn(async () => undefined),
    skip: vi.fn(async () => undefined),
    ...overrides,
  } as ScheduledTaskRunner
}

/** 注入式 cron 工厂：记录回调；测试代码主动调 trigger(taskId) 模拟到点。 */
function makeMockCronFactory() {
  const callbacks = new Map<string, () => void>()
  const stopMocks = new Map<string, ReturnType<typeof vi.fn>>()
  const factory: CronFactory = (cronExpression, _tz, callback) => {
    // 用 cron 表达式作为 key（测试里每条 rule 配不同 cron）
    callbacks.set(cronExpression, callback)
    const stop = vi.fn()
    stopMocks.set(cronExpression, stop)
    return { stop } as CronJobLike
  }
  return {
    factory,
    /** 触发某条规则的 cron 回调（用 cron 表达式定位） */
    trigger(cronExpression: string) {
      const cb = callbacks.get(cronExpression)
      if (!cb) throw new Error(`未注册的 cron: ${cronExpression}`)
      cb()
    },
    stopMocks,
    callbacks,
  }
}

describe('createScheduledTaskScheduler', () => {
  it('start() 注册 cron 回调；触发后调 runner.runOnce + trigger=cron', async () => {
    const mock = makeMockCronFactory()
    const runner = makeRunner()
    const scheduler = createScheduledTaskScheduler({
      rules: [rule('a', '0 9 * * *')],
      runner,
      logger: stubLogger(),
      cronFactory: mock.factory,
    })
    scheduler.start()
    expect(mock.callbacks.size).toBe(1)
    mock.trigger('0 9 * * *')
    // 回调内部异步链需要 flush microtask
    await Promise.resolve()
    expect(runner.runOnce).toHaveBeenCalledTimes(1)
    const [calledRule, trigger] = (runner.runOnce as ReturnType<typeof vi.fn>).mock.calls[0]!
    expect((calledRule as ScheduledTaskRule).id).toBe('a')
    expect(trigger).toBe('cron')
  })

  it('start() 幂等：重复 start 不重复注册回调', () => {
    const mock = makeMockCronFactory()
    const scheduler = createScheduledTaskScheduler({
      rules: [rule('a', '0 9 * * *')],
      runner: makeRunner(),
      logger: stubLogger(),
      cronFactory: mock.factory,
    })
    scheduler.start()
    scheduler.start()
    expect(mock.callbacks.size).toBe(1)
  })

  it('stop() 调用所有 job.stop()，后续即便触发也无回调可调', () => {
    const mock = makeMockCronFactory()
    const scheduler = createScheduledTaskScheduler({
      rules: [rule('a', '0 9 * * *')],
      runner: makeRunner(),
      logger: stubLogger(),
      cronFactory: mock.factory,
    })
    scheduler.start()
    scheduler.stop()
    expect(mock.stopMocks.get('0 9 * * *')).toHaveBeenCalledTimes(1)
  })

  it('disabled 的 rule 不注册', () => {
    const mock = makeMockCronFactory()
    const scheduler = createScheduledTaskScheduler({
      rules: [{ ...rule('a'), enabled: false } as ScheduledTaskRule],
      runner: makeRunner(),
      logger: stubLogger(),
      cronFactory: mock.factory,
    })
    scheduler.start()
    expect(mock.callbacks.size).toBe(0)
  })

  it('in-flight：runOnce 未完成时再次触发 → runner.skip，runOnce 不重入', async () => {
    let resolveRun: (() => void) | undefined
    const runner = makeRunner({
      runOnce: vi.fn(
        () =>
          new Promise<void>((res) => {
            resolveRun = res
          }),
      ),
    })
    const mock = makeMockCronFactory()
    const scheduler = createScheduledTaskScheduler({
      rules: [rule('a', '0 9 * * *')],
      runner,
      logger: stubLogger(),
      cronFactory: mock.factory,
    })
    scheduler.start()

    // 第一次触发：runOnce 挂起
    mock.trigger('0 9 * * *')
    await Promise.resolve()
    expect(runner.runOnce).toHaveBeenCalledTimes(1)

    // 第二次触发：应 skip
    mock.trigger('0 9 * * *')
    await Promise.resolve()
    expect(runner.runOnce).toHaveBeenCalledTimes(1)
    expect(runner.skip).toHaveBeenCalledTimes(1)
    expect((runner.skip as ReturnType<typeof vi.fn>).mock.calls[0]![1]).toBe('in-flight')

    // 释放 → 下次触发恢复
    resolveRun?.()
    await new Promise((r) => setTimeout(r, 0))
    mock.trigger('0 9 * * *')
    await Promise.resolve()
    expect(runner.runOnce).toHaveBeenCalledTimes(2)
  })

  it('多 task 独立 in-flight：A 阻塞不影响 B', async () => {
    let resolveA: (() => void) | undefined
    const runner: ScheduledTaskRunner = {
      runOnce: vi.fn(async (r) => {
        if ((r as ScheduledTaskRule).id === 'a') {
          await new Promise<void>((res) => {
            resolveA = res
          })
        }
      }),
      skip: vi.fn(async () => undefined),
    } as ScheduledTaskRunner
    const mock = makeMockCronFactory()
    const scheduler = createScheduledTaskScheduler({
      rules: [rule('a', '0 9 * * *'), rule('b', '0 10 * * *')],
      runner,
      logger: stubLogger(),
      cronFactory: mock.factory,
    })
    scheduler.start()
    mock.trigger('0 9 * * *')
    mock.trigger('0 10 * * *')
    // 让 B 的 runOnce + finally 全部 flush（settle Promise 微任务链需多次 yield）
    await new Promise((r) => setTimeout(r, 0))
    // A 还 pending，B 应已结束（runner.runOnce 内 await b 无阻塞）
    expect(runner.runOnce).toHaveBeenCalledTimes(2)
    // A 再触发应被 skip；B 再触发应正常
    mock.trigger('0 9 * * *')
    mock.trigger('0 10 * * *')
    await new Promise((r) => setTimeout(r, 0))
    expect(runner.skip).toHaveBeenCalledTimes(1) // 只有 A 被 skip
    expect(runner.runOnce).toHaveBeenCalledTimes(3) // B 又跑一次
    resolveA?.()
  })

  it('timezone：rule.timezone 优先，否则用本机时区', () => {
    const mock = makeMockCronFactory()
    const tzCaptured: string[] = []
    const factory: CronFactory = (cron, tz, cb) => {
      tzCaptured.push(tz)
      return mock.factory(cron, tz, cb)
    }
    const localTz = Intl.DateTimeFormat().resolvedOptions().timeZone
    const scheduler = createScheduledTaskScheduler({
      rules: [
        rule('a', '0 9 * * *'),
        { ...rule('b', '0 10 * * *'), timezone: 'Asia/Shanghai' } as ScheduledTaskRule,
      ],
      runner: makeRunner(),
      logger: stubLogger(),
      cronFactory: factory,
    })
    scheduler.start()
    expect(tzCaptured).toEqual([localTz, 'Asia/Shanghai'])
  })
})
