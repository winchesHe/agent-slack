import { mkdir, readFile, writeFile, appendFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import type { CoreMessage } from 'ai'
import type { WorkspacePaths } from '@/workspace/paths.ts'
import { slackSessionDir } from '@/workspace/paths.ts'
import type { StepUsage } from '@/core/usage.ts'

export interface SessionMeta {
  schemaVersion: 1
  imProvider: 'slack'
  channelId: string
  channelName: string
  threadTs: string
  imUserId: string
  agentName: string
  createdAt: string
  updatedAt: string
  status: 'idle' | 'running' | 'stopped' | 'error'
  usage: {
    inputTokens: number
    outputTokens: number
    cachedInputTokens: number
    totalCostUSD: number
    stepCount: number
  }
}

export interface Session {
  id: string
  dir: string
  meta: SessionMeta
}

export interface GetOrCreateArgs {
  imProvider: 'slack'
  channelId: string
  channelName: string
  threadTs: string
  imUserId: string
  agentName?: string
}

export interface SessionStore {
  getOrCreate(args: GetOrCreateArgs): Promise<Session>
  getMeta(id: string): Promise<SessionMeta | undefined>
  loadMessages(id: string): Promise<CoreMessage[]>
  appendMessage(id: string, msg: CoreMessage): Promise<void>
  accumulateUsage(id: string, step: StepUsage): Promise<void>
  accumulateCost(id: string, usd: number): Promise<void>
  setStatus(id: string, status: SessionMeta['status']): Promise<void>
}

export function createSessionStore(paths: WorkspacePaths): SessionStore {
  const dirs = new Map<string, string>()

  const resolveDir = (id: string): string => {
    const d = dirs.get(id)
    if (!d) throw new Error(`session not loaded: ${id}`)
    return d
  }

  const readMeta = async (dir: string): Promise<SessionMeta> =>
    JSON.parse(await readFile(path.join(dir, 'meta.json'), 'utf8')) as SessionMeta

  const writeMeta = async (dir: string, meta: SessionMeta): Promise<void> => {
    meta.updatedAt = new Date().toISOString()
    await writeFile(path.join(dir, 'meta.json'), JSON.stringify(meta, null, 2))
  }

  return {
    async getMeta(id) {
      const d = dirs.get(id)
      if (!d) return undefined
      return readMeta(d)
    },

    async getOrCreate(args) {
      const id = `${args.imProvider}:${args.channelId}:${args.threadTs}`
      const existingDir = dirs.get(id)
      if (existingDir) return { id, dir: existingDir, meta: await readMeta(existingDir) }

      const dir = slackSessionDir(paths, args.channelName, args.channelId, args.threadTs)
      if (existsSync(path.join(dir, 'meta.json'))) {
        dirs.set(id, dir)
        return { id, dir, meta: await readMeta(dir) }
      }

      await mkdir(dir, { recursive: true })
      const meta: SessionMeta = {
        schemaVersion: 1,
        imProvider: args.imProvider,
        channelId: args.channelId,
        channelName: args.channelName,
        threadTs: args.threadTs,
        imUserId: args.imUserId,
        agentName: args.agentName ?? 'default',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        status: 'idle',
        usage: {
          inputTokens: 0,
          outputTokens: 0,
          cachedInputTokens: 0,
          totalCostUSD: 0,
          stepCount: 0,
        },
      }
      await writeMeta(dir, meta)
      await writeFile(path.join(dir, 'messages.jsonl'), '')
      dirs.set(id, dir)
      return { id, dir, meta }
    },

    async loadMessages(id) {
      const raw = await readFile(path.join(resolveDir(id), 'messages.jsonl'), 'utf8')
      return raw
        .split('\n')
        .filter((l) => l.length > 0)
        .map((l) => JSON.parse(l) as CoreMessage)
    },

    async appendMessage(id, msg) {
      await appendFile(path.join(resolveDir(id), 'messages.jsonl'), JSON.stringify(msg) + '\n')
    },

    async accumulateUsage(id, step) {
      const dir = resolveDir(id)
      const meta = await readMeta(dir)
      meta.usage.inputTokens += step.inputTokens
      meta.usage.outputTokens += step.outputTokens
      meta.usage.cachedInputTokens += step.cachedInputTokens ?? 0
      meta.usage.stepCount += 1
      await writeMeta(dir, meta)
    },

    async accumulateCost(id, usd) {
      const dir = resolveDir(id)
      const meta = await readMeta(dir)
      // 成本改为事件级单独累加，避免按 modelUsage 循环时重复计费。
      meta.usage.totalCostUSD += usd
      await writeMeta(dir, meta)
    },

    async setStatus(id, status) {
      const dir = resolveDir(id)
      const meta = await readMeta(dir)
      meta.status = status
      await writeMeta(dir, meta)
    },
  }
}
