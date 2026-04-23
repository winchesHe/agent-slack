import { readFile, readdir } from 'node:fs/promises'
import path from 'node:path'
import type { WorkspacePaths } from '@/workspace/paths.ts'
import type { Logger } from '@/logger/logger.ts'

// ── 数据接口 ──────────────────────────────────────────

export interface SessionSummary {
  sessionId: string
  channelName: string
  messageCount: number
  hasErrors: boolean
  /** toolName → 调用次数 */
  toolUsage: Record<string, number>
  createdAt: string
  updatedAt: string
  /** 关键信号摘要：错误行、最后若干条 assistant 文本摘要 */
  highlights: string[]
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

export type CollectorScope = 'all' | 'recent'

export interface SelfImproveCollector {
  collect(scope: CollectorScope): Promise<CollectedData>
}

export interface SelfImproveCollectorDeps {
  paths: WorkspacePaths
  logger: Logger
}

// ── 常量 ──────────────────────────────────────────────

/** scope='recent' 的时间窗口：7 天 */
const RECENT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000

/** 每个 session 最多保留的 highlights 条数，控制 token */
const MAX_HIGHLIGHTS_PER_SESSION = 6
/** 截取 assistant 文本摘要的字符上限 */
const ASSISTANT_SUMMARY_MAX_CHARS = 300
/** 保留的最后 assistant 消息数 */
const LAST_ASSISTANT_COUNT = 3

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
  const cutoff = scope === 'recent' ? now - RECENT_WINDOW_MS : 0

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
  const { messageCount, hasErrors, toolUsage, highlights } =
    analyzeMessages(messagesRaw)

  return {
    sessionId,
    channelName: meta.channelName ?? 'unknown',
    messageCount,
    hasErrors,
    toolUsage,
    createdAt: meta.createdAt ?? '',
    updatedAt,
    highlights,
  }
}

interface MessageAnalysis {
  messageCount: number
  hasErrors: boolean
  toolUsage: Record<string, number>
  highlights: string[]
}

/**
 * 从 messages.jsonl 文本中提取关键信号。
 * 导出以便在单测或其他 tool 中直接复用（无副作用、无 IO）。
 */
export function analyzeMessages(jsonl: string): MessageAnalysis {
  const toolUsage: Record<string, number> = {}
  let messageCount = 0
  let hasErrors = false
  const errorLines: string[] = []
  const assistantTexts: string[] = []

  if (!jsonl) {
    return { messageCount: 0, hasErrors: false, toolUsage: {}, highlights: [] }
  }

  // 粗粒度错误信号：jsonl 文本里是否出现错误标记
  hasErrors =
    jsonl.includes('[error:') ||
    jsonl.includes('"isError":true') ||
    jsonl.includes('"isError": true')

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

    if (role === 'assistant') {
      if (typeof content === 'string') {
        if (content.trim()) assistantTexts.push(content.slice(0, ASSISTANT_SUMMARY_MAX_CHARS))
      } else if (Array.isArray(content)) {
        for (const part of content) {
          if (!isRecord(part)) continue
          if (part.type === 'tool-call' && typeof part.toolName === 'string') {
            toolUsage[part.toolName] = (toolUsage[part.toolName] ?? 0) + 1
          }
          if (part.type === 'text' && typeof part.text === 'string' && part.text.trim()) {
            assistantTexts.push(part.text.slice(0, ASSISTANT_SUMMARY_MAX_CHARS))
          }
        }
      }
    } else if (role === 'tool') {
      if (Array.isArray(content)) {
        for (const part of content) {
          if (!isRecord(part)) continue
          if (typeof part.toolName === 'string') {
            toolUsage[part.toolName] = (toolUsage[part.toolName] ?? 0) + 1
          }
          // tool 结果里含错误文本
          const result = part.result
          if (typeof result === 'string' && result.includes('[error:')) {
            errorLines.push(truncate(result, ASSISTANT_SUMMARY_MAX_CHARS))
          }
        }
      }
    } else if (role === 'user') {
      // 一期不提取用户消息正文；仅用于 messageCount
    }
  }

  const highlights: string[] = []
  // 错误信号优先
  for (const e of errorLines.slice(0, MAX_HIGHLIGHTS_PER_SESSION)) {
    highlights.push(`❌ ${e}`)
  }
  // 最后 LAST_ASSISTANT_COUNT 条 assistant 文本
  const tail = assistantTexts.slice(-LAST_ASSISTANT_COUNT)
  for (const t of tail) {
    if (highlights.length >= MAX_HIGHLIGHTS_PER_SESSION) break
    highlights.push(`🤖 ${t}`)
  }

  return { messageCount, hasErrors, toolUsage, highlights }
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
