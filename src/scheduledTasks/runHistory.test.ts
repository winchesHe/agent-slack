import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { appendScheduledTaskRun } from './runHistory.ts'
import type { ScheduledTaskRunRecord } from './types.ts'

function fakeRecord(id: string, status: ScheduledTaskRunRecord['status']): ScheduledTaskRunRecord {
  return {
    runId: `t:${id}:${status}`,
    taskId: id,
    trigger: 'cron',
    status,
    startedAt: '2026-05-11T00:00:00.000Z',
    target: { im: 'slack', channelId: 'C0000000001' },
  }
}

describe('appendScheduledTaskRun', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'scheduled-history-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('创建不存在的目录并写入第一条', async () => {
    const file = path.join(dir, 'nested', 'sub', 'history.jsonl')
    await appendScheduledTaskRun(file, fakeRecord('a', 'started'))
    const text = readFileSync(file, 'utf8')
    expect(text.endsWith('\n')).toBe(true)
    const parsed = JSON.parse(text.trim())
    expect(parsed.taskId).toBe('a')
    expect(parsed.status).toBe('started')
  })

  it('追加多条不覆盖', async () => {
    const file = path.join(dir, 'history.jsonl')
    await appendScheduledTaskRun(file, fakeRecord('a', 'started'))
    await appendScheduledTaskRun(file, fakeRecord('a', 'success'))
    const lines = readFileSync(file, 'utf8').trim().split('\n')
    expect(lines).toHaveLength(2)
    expect(JSON.parse(lines[0]!).status).toBe('started')
    expect(JSON.parse(lines[1]!).status).toBe('success')
  })

  it('并发 50 条 append 不丢行、不交错（每行仍是合法 JSON）', async () => {
    const file = path.join(dir, 'history.jsonl')
    const promises: Promise<void>[] = []
    for (let i = 0; i < 50; i++) {
      promises.push(appendScheduledTaskRun(file, fakeRecord(`t${i}`, 'started')))
    }
    await Promise.all(promises)
    const lines = readFileSync(file, 'utf8').trim().split('\n')
    expect(lines).toHaveLength(50)
    const ids = new Set<string>()
    for (const line of lines) {
      const r = JSON.parse(line)
      expect(typeof r.taskId).toBe('string')
      ids.add(r.taskId)
    }
    expect(ids.size).toBe(50)
  })

  it('不同文件的并发互不阻塞（用同一 module-scoped 串行化机制时不应卡死）', async () => {
    const fileA = path.join(dir, 'a.jsonl')
    const fileB = path.join(dir, 'b.jsonl')
    await Promise.all([
      appendScheduledTaskRun(fileA, fakeRecord('a', 'started')),
      appendScheduledTaskRun(fileB, fakeRecord('b', 'started')),
      appendScheduledTaskRun(fileA, fakeRecord('a', 'success')),
      appendScheduledTaskRun(fileB, fakeRecord('b', 'success')),
    ])
    expect(readFileSync(fileA, 'utf8').trim().split('\n')).toHaveLength(2)
    expect(readFileSync(fileB, 'utf8').trim().split('\n')).toHaveLength(2)
  })
})
