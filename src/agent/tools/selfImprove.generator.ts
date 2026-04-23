/**
 * self_improve 候选规则后处理器。
 *
 * 由 `self_improve_confirm` tool 调用；不调 LLM，不读写文件，纯数据处理。
 * 接收主 Agent 产出的 CandidateRule[] + existingRules 文本，返回去重/排序/过滤后的列表。
 */

export interface CandidateRule {
  /** 唯一 ID；用于 slack confirm action_id 路由 */
  id: string
  /** 规则正文（Markdown 片段，建议 1-3 行） */
  content: string
  /** 分类标签，如 code-standards / guardrails / workflow / behavior */
  category: string
  /** 置信度 */
  confidence: 'high' | 'medium'
  /** 来源证据摘要 */
  evidence: string
}

export interface SelfImproveGenerator {
  /**
   * 过滤并排序候选规则。
   * - 剔除字段缺失 / 内容为空的条目
   * - 剔除与 existingRules 文本相似度较高的条目（Jaccard ≥ JACCARD_THRESHOLD）
   * - 组内两两比较，保留首个相似候选
   * - 按 confidence（high > medium）+ category 稳定排序
   */
  process(rules: CandidateRule[], existingRules: string): CandidateRule[]
}

// 两条规则 Jaccard 相似度超过该阈值视为重复
const JACCARD_THRESHOLD = 0.6

export function createSelfImproveGenerator(): SelfImproveGenerator {
  return {
    process(rules, existingRules) {
      const existingTokenSets = splitExistingRules(existingRules).map(tokenize)

      const survivors: Array<{ rule: CandidateRule; tokens: Set<string> }> = []

      for (const rule of rules) {
        if (!isValidRule(rule)) continue
        const tokens = tokenize(rule.content)
        if (tokens.size === 0) continue

        // 与现有规则查重
        const dupExisting = existingTokenSets.some((et) => jaccard(tokens, et) >= JACCARD_THRESHOLD)
        if (dupExisting) continue

        // 组内查重
        const dupInGroup = survivors.some((s) => jaccard(tokens, s.tokens) >= JACCARD_THRESHOLD)
        if (dupInGroup) continue

        survivors.push({ rule, tokens })
      }

      return survivors.map((s) => s.rule).sort(compareRules)
    },
  }
}

// ── 校验 ─────────────────────────────────────────────

function isValidRule(r: unknown): r is CandidateRule {
  if (typeof r !== 'object' || r === null) return false
  const rr = r as Record<string, unknown>
  return (
    typeof rr.id === 'string' &&
    rr.id.length > 0 &&
    typeof rr.content === 'string' &&
    rr.content.trim().length > 0 &&
    typeof rr.category === 'string' &&
    (rr.confidence === 'high' || rr.confidence === 'medium') &&
    typeof rr.evidence === 'string'
  )
}

// ── 排序 ─────────────────────────────────────────────

function compareRules(a: CandidateRule, b: CandidateRule): number {
  // high 排前
  const byConf = confWeight(a.confidence) - confWeight(b.confidence)
  if (byConf !== 0) return byConf
  // category 字典序
  return a.category.localeCompare(b.category)
}

function confWeight(c: CandidateRule['confidence']): number {
  return c === 'high' ? 0 : 1
}

// ── 文本 / Jaccard 去重 ──────────────────────────────

/** 将 existingRules 原文按常见 Markdown 分隔切片，作为"已有规则"集合 */
function splitExistingRules(md: string): string[] {
  if (!md.trim()) return []
  const lines = md.split('\n')
  const out: string[] = []
  let buf: string[] = []

  const flush = (): void => {
    const chunk = buf.join('\n').trim()
    if (chunk) out.push(chunk)
    buf = []
  }

  for (const raw of lines) {
    const line = raw.trim()
    // Markdown 标题 / 列表项作为分隔边界
    if (line.startsWith('#') || /^[-*+]\s/.test(line)) {
      flush()
      if (!line.startsWith('#')) buf.push(line)
    } else {
      buf.push(line)
    }
  }
  flush()
  return out
}

/** 文本归一化 + 分词（按非字母数字切分，忽略大小写与 Markdown 标点）。导出供单测。 */
export function tokenize(text: string): Set<string> {
  const normalized = text.toLowerCase().replace(/[`*_>#\[\]()~]/g, ' ')
  const tokens = normalized.split(/[^\p{L}\p{N}]+/u).filter((t) => t.length >= 2)
  return new Set(tokens)
}

/** Jaccard 相似度。导出供单测。 */
export function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0
  let inter = 0
  for (const x of a) if (b.has(x)) inter += 1
  const union = a.size + b.size - inter
  return union === 0 ? 0 : inter / union
}
