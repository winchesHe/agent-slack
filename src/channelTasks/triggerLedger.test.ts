import { beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  createChannelTaskTriggerLedger,
  triggerKey,
  type ChannelTaskTriggerRecord,
} from './triggerLedger.ts'

let cwd: string

beforeEach(() => {
  cwd = mkdtempSync(path.join(tmpdir(), 'channel-task-ledger-'))
})

function record(overrides: Partial<ChannelTaskTriggerRecord> = {}): ChannelTaskTriggerRecord {
  return {
    schemaVersion: 1,
    ruleId: 'rule-1',
    channelId: 'C1',
    messageTs: '1000.0001',
    threadTs: '1000.0001',
    actorType: 'user',
    actorId: 'U1',
    triggeredAt: '2026-04-26T00:00:00.000Z',
    sessionId: 'slack:C1:1000.0001',
    ...overrides,
  }
}

describe('ChannelTaskTriggerLedger', () => {
  it('缺失文件时返回空记录', async () => {
    const ledger = createChannelTaskTriggerLedger(path.join(cwd, 'channel-tasks', 'triggers.jsonl'))
    await expect(ledger.load()).resolves.toEqual([])
  })

  it('recordIfNew 对同 rule/channel/message 去重', async () => {
    const ledger = createChannelTaskTriggerLedger(path.join(cwd, 'channel-tasks', 'triggers.jsonl'))
    const first = record()

    await expect(ledger.recordIfNew(first)).resolves.toBe(true)
    await expect(ledger.recordIfNew(first)).resolves.toBe(false)
    await expect(ledger.hasTriggered(first)).resolves.toBe(true)
    await expect(ledger.load()).resolves.toEqual([first])
  })

  it('同一消息命中不同规则时分别记录', async () => {
    const ledger = createChannelTaskTriggerLedger(path.join(cwd, 'channel-tasks', 'triggers.jsonl'))

    await expect(ledger.recordIfNew(record())).resolves.toBe(true)
    await expect(ledger.recordIfNew(record({ ruleId: 'rule-2' }))).resolves.toBe(true)

    const records = await ledger.load()
    expect(records.map((item) => triggerKey(item))).toEqual([
      'rule-1:C1:1000.0001',
      'rule-2:C1:1000.0001',
    ])
  })

  it('损坏 jsonl 记录会显式报错', async () => {
    const file = path.join(cwd, 'channel-tasks', 'triggers.jsonl')
    await mkdir(path.dirname(file), { recursive: true })
    await writeFile(file, '{"schemaVersion":1,"ruleId":"missing-fields"}\n', 'utf8')
    const ledger = createChannelTaskTriggerLedger(file)

    await expect(ledger.load()).rejects.toThrow(/非法 channel task trigger record/)
  })
})
