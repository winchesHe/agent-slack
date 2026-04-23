import { readFile, readdir } from 'node:fs/promises'
import path from 'node:path'
import type { WorkspacePaths } from '@/workspace/paths.ts'
import type { Logger } from '@/logger/logger.ts'

// ── 数据接口 ──────────────────────────────────────────

/** 一次 API round：user 消息 + 对应 assistant / tool 产出（借鉴 Claude Code compact 的 round 分组思路） */
export interface SessionRound {
  /** 用户消息正文（可能被截断） */
  userMessage: string
  /** assistant 文本 block 列表（每条可能被截断） */
  assistantTexts: string[]
  /** 工具调用概要；成功调用只记录名称，失败保留错误片段 */
  toolCalls: { name: string; error?: string }[]
}

export interface SessionSummary {
  sessionId: string
  channelName: string
  messageCount: number
  hasErrors: boolean
  /** toolName → 调用次数 */
  toolUsage: Record<string, number>
  createdAt: string
  updatedAt: string
  /** 按 API round 结构化保留的会话内容（可能按 MAX_SESSION_CHARS 从尾部裁剪） */
  rounds: SessionRound[]
}

export interface MemoryEntry {
  fileName: string
  content: string
}

export interface CollectedData {
  sessions: SessionSummary[]
  memories: MemoryEntry[]
  /** 现有 .agent-slack/system.md 内容；不存在则 '' */
  existingRules: string
}

export type CollectorScope = '--all' | number

export interface SelfImproveCollector {
  collect(scope: CollectorScope): Promise<CollectedData>
}

export interface SelfImproveCollectorDeps {
  paths: WorkspacePaths
  logger: Logger
}

// ── 常量 ──────────────────────────────────────────────

const MS_PER_DAY = 24 * 60 * 60 * 1000

/** 单条用户消息最大字符（粘贴长文时裁剪） */
const MAX_USER_MESSAGE_CHARS = 2000
/** 单条 assistant 文本 block 最大字符 */
const MAX_ASSISTANT_TEXT_CHARS = 1000
/** 单条错误文本最大字符 */
const MAX_ERROR_TEXT_CHARS = 500
/** 单个 session 序列化后的字符上限；超出时从最旧的 round 往后丢 */
const MAX_SESSION_CHARS = 12000

// ── 工厂 ──────────────────────────────────────────────

export function createSelfImproveCollector(
  deps: SelfImproveCollectorDeps,
): SelfImproveCollector {
  const log = deps.logger.withTag('self-improve:collector')
  const slackSessionsDir = path.join(deps.paths.sessionsDir, 'slack')

  return {
    async collect(scope) {
      const [sessions, memories, existingRules] = await Promise.all([
        collectSessions(slackSessionsDir, scope, log),
        collectMemories(deps.paths.memoryDir, log),
        readFileSafe(deps.paths.systemFile),
      ])

      return { sessions, memories, existingRules }
    },
  }
}

// ── session 收集 ─────────────────────────────────────

async function collectSessions(
  slackSessionsDir: string,
  scope: CollectorScope,
  log: Logger,
): Promise<SessionSummary[]> {
  let entries: string[]
  try {
    entries = await readdir(slackSessionsDir)
  } catch {
    return []
  }

  const now = Date.now()
  const cutoff = typeof scope === 'number' && scope > 0 ? now - scope * MS_PER_DAY : 0

  const summaries: SessionSummary[] = []
  for (const name of entries) {
    const dir = path.join(slackSessionsDir, name)
    try {
      const summary = await summarizeSession(dir, name, cutoff)
      if (summary) summaries.push(summary)
    } catch (err) {
      log.warn('session 摘要失败，跳过', { dir: name, err })
    }
  }

  // 按 updatedAt 降序
  summaries.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))
  return summaries
}

async function summarizeSession(
  dir: string,
  sessionId: string,
  cutoffMs: number,
): Promise<SessionSummary | undefined> {
  const metaRaw = await readFileSafe(path.join(dir, 'meta.json'))
  if (!metaRaw) return undefined
  let meta: {
    channelName?: string
    createdAt?: string
    updatedAt?: string
  }
  try {
    meta = JSON.parse(metaRaw) as typeof meta
  } catch {
    return undefined
  }
  const updatedAt = meta.updatedAt ?? meta.createdAt ?? ''
  if (cutoffMs > 0) {
    const ts = Date.parse(updatedAt)
    if (!Number.isFinite(ts) || ts < cutoffMs) return undefined
  }

  const messagesRaw = await readFileSafe(path.join(dir, 'messages.jsonl'))
  const { messageCount, hasErrors, toolUsage, rounds } = analyzeMessages(messagesRaw)

  return {
    sessionId,
    channelName: meta.channelName ?? 'unknown',
    messageCount,
    hasErrors,
    toolUsage,
    createdAt: meta.createdAt ?? '',
    updatedAt,
    rounds,
  }
}

interface MessageAnalysis {
  messageCount: number
  hasErrors: boolean
  toolUsage: Record<string, number>
  rounds: SessionRound[]
}

/**
 * 从 messages.jsonl 文本中按 API round 提取结构化内容。
 * 借鉴 Claude Code compact 的分组思路：user 消息触发新 round，后续 assistant / tool 归属该 round。
 * 导出以便在单测或其他 tool 中直接复用（无副作用、无 IO）。
 */
export function analyzeMessages(jsonl: string): MessageAnalysis {
  const toolUsage: Record<string, number> = {}
  let messageCount = 0
  let hasErrors = false

  if (!jsonl) {
    return { messageCount: 0, hasErrors: false, toolUsage: {}, rounds: [] }
  }

  // 粗粒度错误信号：jsonl 文本里是否出现错误标记
  hasErrors =
    jsonl.includes('[error:') ||
    jsonl.includes('"isError":true') ||
    jsonl.includes('"isError": true')

  const rounds: SessionRound[] = []
  let current: SessionRound | undefined

  const ensureRound = (): SessionRound => {
    if (!current) {
      current = { userMessage: '', assistantTexts: [], toolCalls: [] }
      rounds.push(current)
    }
    return current
  }

  for (const line of jsonl.split('\n')) {
    if (!line.trim()) continue
    messageCount += 1
    let msg: { role?: string; content?: unknown }
    try {
      msg = JSON.parse(line) as typeof msg
    } catch {
      continue
    }

    const role = msg.role
    const content = msg.content

    if (role === 'user') {
      // user 消息起一个新 round；user content 可能是字符串或数组
      const text = extractUserText(content)
      current = {
        userMessage: truncate(text, MAX_USER_MESSAGE_CHARS),
        assistantTexts: [],
        toolCalls: [],
      }
      rounds.push(current)
    } else if (role === 'assistant') {
      const round = ensureRound()
      if (typeof content === 'string') {
        if (content.trim()) round.assistantTexts.push(truncate(content, MAX_ASSISTANT_TEXT_CHARS))
      } else if (Array.isArray(content)) {
        for (const part of content) {
          if (!isRecord(part)) continue
          if (part.type === 'tool-call' && typeof part.toolName === 'string') {
            toolUsage[part.toolName] = (toolUsage[part.toolName] ?? 0) + 1
            round.toolCalls.push({ name: part.toolName })
          }
          if (part.type === 'text' && typeof part.text === 'string' && part.text.trim()) {
            round.assistantTexts.push(truncate(part.text, MAX_ASSISTANT_TEXT_CHARS))
          }
        }
      }
    } else if (role === 'tool') {
      const round = ensureRound()
      if (Array.isArray(content)) {
        for (const part of content) {
          if (!isRecord(part)) continue
          if (typeof part.toolName === 'string') {
            toolUsage[part.toolName] = (toolUsage[part.toolName] ?? 0) + 1
          }
          const result = part.result
          if (typeof result === 'string' && result.includes('[error:')) {
            const name = typeof part.toolName === 'string' ? part.toolName : 'unknown'
            round.toolCalls.push({ name, error: truncate(result, MAX_ERROR_TEXT_CHARS) })
          }
        }
      }
    }
  }

  return {
    messageCount,
    hasErrors,
    toolUsage,
    rounds: trimRoundsBySessionBudget(rounds, MAX_SESSION_CHARS),
  }
}

function extractUserText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const part of content) {
    if (!isRecord(part)) continue
    if (part.type === 'text' && typeof part.text === 'string') parts.push(part.text)
  }
  return parts.join('\n')
}

/** 从尾部往前累加 rounds 字符数，超过预算则丢弃最旧的 */
function trimRoundsBySessionBudget(rounds: SessionRound[], maxChars: number): SessionRound[] {
  let total = 0
  const kept: SessionRound[] = []
  for (let i = rounds.length - 1; i >= 0; i -= 1) {
    const r = rounds[i]!
    const size =
      r.userMessage.length +
      r.assistantTexts.reduce((s, t) => s + t.length, 0) +
      r.toolCalls.reduce((s, tc) => s + tc.name.length + (tc.error?.length ?? 0), 0)
    if (total + size > maxChars && kept.length > 0) break
    total += size
    kept.unshift(r)
  }
  return kept
}

// ── memory 收集 ──────────────────────────────────────

async function collectMemories(
  memoryDir: string,
  log: Logger,
): Promise<MemoryEntry[]> {
  let entries: string[]
  try {
    entries = await readdir(memoryDir)
  } catch {
    return []
  }

  const out: MemoryEntry[] = []
  for (const name of entries) {
    if (!name.endsWith('.md')) continue
    const content = await readFileSafe(path.join(memoryDir, name))
    if (!content) continue
    out.push({ fileName: name, content })
  }
  if (out.length === 0) log.debug('memory 目录为空', { memoryDir })
  return out
}

// ── 工具函数 ──────────────────────────────────────────

async function readFileSafe(file: string): Promise<string> {
  try {
    return await readFile(file, 'utf8')
  } catch {
    return ''
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + '…' : s
}
