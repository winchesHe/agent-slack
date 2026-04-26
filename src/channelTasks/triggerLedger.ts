import { existsSync } from 'node:fs'
import { appendFile, mkdir, readFile } from 'node:fs/promises'
import path from 'node:path'

export interface ChannelTaskTriggerKey {
  ruleId: string
  channelId: string
  messageTs: string
}

export interface ChannelTaskTriggerRecord extends ChannelTaskTriggerKey {
  schemaVersion: 1
  threadTs: string
  actorType: 'user' | 'bot'
  actorId: string
  triggeredAt: string
  sessionId: string
}

export interface ChannelTaskTriggerLedger {
  load(): Promise<ChannelTaskTriggerRecord[]>
  hasTriggered(key: ChannelTaskTriggerKey): Promise<boolean>
  append(record: ChannelTaskTriggerRecord): Promise<void>
  recordIfNew(record: ChannelTaskTriggerRecord): Promise<boolean>
}

export function createChannelTaskTriggerLedger(triggersFile: string): ChannelTaskTriggerLedger {
  return {
    async load() {
      return loadTriggerRecords(triggersFile)
    },

    async hasTriggered(key) {
      const records = await loadTriggerRecords(triggersFile)
      const expected = triggerKey(key)
      return records.some((record) => triggerKey(record) === expected)
    },

    async append(record) {
      await mkdir(path.dirname(triggersFile), { recursive: true })
      await appendFile(triggersFile, `${JSON.stringify(record)}\n`, 'utf8')
    },

    async recordIfNew(record) {
      if (await this.hasTriggered(record)) return false
      await this.append(record)
      return true
    },
  }
}

export function triggerKey(key: ChannelTaskTriggerKey): string {
  return `${key.ruleId}:${key.channelId}:${key.messageTs}`
}

async function loadTriggerRecords(triggersFile: string): Promise<ChannelTaskTriggerRecord[]> {
  if (!existsSync(triggersFile)) return []
  const raw = await readFile(triggersFile, 'utf8')
  if (raw.trim().length === 0) return []

  return raw
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => {
      const parsed = JSON.parse(line) as unknown
      if (!isTriggerRecord(parsed)) {
        throw new Error(`非法 channel task trigger record: ${line}`)
      }
      return parsed
    })
}

function isTriggerRecord(value: unknown): value is ChannelTaskTriggerRecord {
  if (!isRecord(value)) return false
  return (
    value.schemaVersion === 1 &&
    typeof value.ruleId === 'string' &&
    typeof value.channelId === 'string' &&
    typeof value.messageTs === 'string' &&
    typeof value.threadTs === 'string' &&
    (value.actorType === 'user' || value.actorType === 'bot') &&
    typeof value.actorId === 'string' &&
    typeof value.triggeredAt === 'string' &&
    typeof value.sessionId === 'string'
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}
