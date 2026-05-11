import { describe, expect, it, vi } from 'vitest'
import { createScheduledTaskRunner } from './runner.ts'
import type { ScheduledTaskRule } from './config.ts'
import type { ScheduledTaskRunRecord } from './types.ts'

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

function slackRule(overrides: Partial<ScheduledTaskRule> = {}): ScheduledTaskRule {
  return {
    id: 't1',
    enabled: true,
    cron: '0 9 * * *',
    prompt: 'hi',
    target: { im: 'slack', channelId: 'C0123456789' },
    ...overrides,
  } as ScheduledTaskRule
}

function wechatRule(overrides: Partial<ScheduledTaskRule> = {}): ScheduledTaskRule {
  return {
    id: 'w1',
    enabled: true,
    cron: '0 9 * * *',
    prompt: 'hi',
    target: { im: 'wechat', to: 'oABC@im.wechat' },
    ...overrides,
  } as ScheduledTaskRule
}

function makeHistory() {
  const records: ScheduledTaskRunRecord[] = []
  return {
    records,
    append: vi.fn(async (r: ScheduledTaskRunRecord) => {
      records.push(r)
    }),
  }
}

describe('runner.runOnce', () => {
  it('slack target → 调 slackHook，不调 wechatHook', async () => {
    const slackHook = { run: vi.fn(async () => undefined) }
    const wechatHook = { run: vi.fn(async () => undefined) }
    const history = makeHistory()
    const runner = createScheduledTaskRunner({
      slackHook,
      wechatHook,
      history,
      logger: stubLogger(),
    })
    await runner.runOnce(slackRule(), 'cron')
    expect(slackHook.run).toHaveBeenCalledWith({
      taskId: 't1',
      channelId: 'C0123456789',
      prompt: 'hi',
    })
    expect(wechatHook.run).not.toHaveBeenCalled()
  })

  it('wechat target → 调 wechatHook', async () => {
    const slackHook = { run: vi.fn(async () => undefined) }
    const wechatHook = { run: vi.fn(async () => undefined) }
    const history = makeHistory()
    const runner = createScheduledTaskRunner({
      slackHook,
      wechatHook,
      history,
      logger: stubLogger(),
    })
    await runner.runOnce(wechatRule(), 'cron')
    expect(wechatHook.run).toHaveBeenCalledWith({
      taskId: 'w1',
      to: 'oABC@im.wechat',
      prompt: 'hi',
    })
    expect(slackHook.run).not.toHaveBeenCalled()
  })

  it('hook 未注入（adapter 未启用）→ history failed + error=adapter-not-enabled', async () => {
    const history = makeHistory()
    const runner = createScheduledTaskRunner({
      history,
      logger: stubLogger(),
    })
    await runner.runOnce(slackRule(), 'cron')
    expect(history.records).toHaveLength(2)
    expect(history.records[0]!.status).toBe('started')
    expect(history.records[1]!.status).toBe('failed')
    expect(history.records[1]!.error).toBe('adapter-not-enabled')
    // started + failed 共享 runId
    expect(history.records[0]!.runId).toBe(history.records[1]!.runId)
  })

  it('成功路径：history 序列 started → success，共享 runId，endedAt/durationMs 仅在终态行', async () => {
    const slackHook = { run: vi.fn(async () => undefined) }
    const history = makeHistory()
    const runner = createScheduledTaskRunner({
      slackHook,
      history,
      logger: stubLogger(),
    })
    await runner.runOnce(slackRule(), 'cron')
    expect(history.records).toHaveLength(2)
    const [started, success] = history.records
    expect(started!.status).toBe('started')
    expect(started!.endedAt).toBeUndefined()
    expect(started!.durationMs).toBeUndefined()
    expect(success!.status).toBe('success')
    expect(success!.endedAt).toBeDefined()
    expect(success!.durationMs).toBeGreaterThanOrEqual(0)
    expect(started!.runId).toBe(success!.runId)
  })

  it('hook 抛错 → history failed + error=message，不二次外发', async () => {
    const slackHook = {
      run: vi.fn(async () => {
        throw new Error('agent failed')
      }),
    }
    const history = makeHistory()
    const runner = createScheduledTaskRunner({
      slackHook,
      history,
      logger: stubLogger(),
    })
    await expect(runner.runOnce(slackRule(), 'cron')).resolves.toBeUndefined()
    expect(history.records).toHaveLength(2)
    expect(history.records[1]!.status).toBe('failed')
    expect(history.records[1]!.error).toContain('agent failed')
  })

  it('trigger 标签 manual 透传到 history', async () => {
    const slackHook = { run: vi.fn(async () => undefined) }
    const history = makeHistory()
    const runner = createScheduledTaskRunner({
      slackHook,
      history,
      logger: stubLogger(),
    })
    await runner.runOnce(slackRule(), 'manual')
    expect(history.records[0]!.trigger).toBe('manual')
    expect(history.records[1]!.trigger).toBe('manual')
  })

  it('skip：runner.skip(rule) → history 单行 skipped + skippedReason=in-flight + trigger=cron', async () => {
    const history = makeHistory()
    const runner = createScheduledTaskRunner({
      slackHook: { run: vi.fn(async () => undefined) },
      history,
      logger: stubLogger(),
    })
    await runner.skip(slackRule(), 'in-flight')
    expect(history.records).toHaveLength(1)
    expect(history.records[0]!.status).toBe('skipped')
    expect(history.records[0]!.skippedReason).toBe('in-flight')
    expect(history.records[0]!.trigger).toBe('cron')
  })

  it('target 字段透传到 history record（slack 和 wechat 都验证）', async () => {
    const history = makeHistory()
    const runner = createScheduledTaskRunner({
      slackHook: { run: vi.fn(async () => undefined) },
      wechatHook: { run: vi.fn(async () => undefined) },
      history,
      logger: stubLogger(),
    })
    await runner.runOnce(slackRule(), 'cron')
    expect(history.records[0]!.target).toEqual({ im: 'slack', channelId: 'C0123456789' })
    history.records.length = 0
    await runner.runOnce(wechatRule(), 'cron')
    expect(history.records[0]!.target).toEqual({ im: 'wechat', to: 'oABC@im.wechat' })
  })
})
