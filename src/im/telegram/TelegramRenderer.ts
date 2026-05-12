// Telegram 文本渲染器：累积 agent 流式事件 → flush 时把 markdown 转 HTML 再按 4000 字符切片。
//
// HTML parse_mode（spec §3）：相比 MarkdownV2 转义少一个量级（仅 < > &），且兼容大部分 markdown
// 视觉需求。失败降级（plain text 重发）由 EventSink 触发，Renderer 只负责"产 HTML chunks"。
//
// markdown 子集覆盖（与 scheduled tasks 实际产出对齐）：
//   - 标题 `# ` / `## ` / `### `      → <b>...</b>
//   - 引用 `> xxx`                    → <blockquote>...</blockquote>
//   - 无序列表 `- x` / `* x` / `+ x`  → `• x`
//   - 有序列表 `1. x` / `2) x`         → `1. x`（保留编号）
//   - 行内强调 `**...**` / `__...__`  → <b>
//   - 行内斜体 `*...*` / `_..._`      → <i>
//   - 行内代码 `` `code` ``           → <code>
//   - 链接 `[text](url)`              → <a href="url">text</a>
//   - 三反引号代码块                   → <pre>...</pre>
//   - 表格（含分隔符）                  → 结构化列表（每行 = 加粗标题 + 描述 + 🔗 链接）
//   - 其它字符 escape <>&

import type { AgentExecutionEvent } from '@/core/events.ts'
import type { Logger } from '@/logger/logger.ts'

export interface TelegramRendererDeps {
  logger: Logger
}

export interface TelegramRenderer {
  onEvent(event: AgentExecutionEvent): void
  /** finalize 时取出待发送的 HTML chunks（每片 ≤ TEXT_CHUNK_LIMIT 字符） */
  flush(): string[]
  /**
   * 当前 progress 快照 HTML（给 EventSink 实时编辑同一条消息用）。
   * 格式：工具历史 + reasoning tail + 最新 status，多行 plain text + escapeHtml。
   * 无任何状态时回退起始消息文案，保证编辑总能进行。
   */
  currentProgressHtml(): string
  readonly STARTING_MESSAGE: string
}

// Telegram sendMessage 单条上限 4096；留 96 字符余量给末尾换行 / pre 闭合等
const TEXT_CHUNK_LIMIT = 4000
const STARTING_MESSAGE = '⏳ 任务执行中...'

// progress 行长度上限（避免 reasoning 段塞爆 4096 限制；超出截断尾部）
const PROGRESS_LINE_LIMIT = 600

export function createTelegramRenderer(deps: TelegramRendererDeps): TelegramRenderer {
  const log = deps.logger.withTag('telegram:renderer')
  const assistantTexts: string[] = []
  const toolNamesUsed = new Set<string>()
  // progress 实时态（覆盖语义；clear 时重置）
  let latestStatus: string | undefined
  let latestReasoningTail: string | undefined
  let terminalPhase: 'completed' | 'stopped' | 'failed' | undefined
  let failedError: string | undefined

  return {
    STARTING_MESSAGE,

    onEvent(event) {
      switch (event.type) {
        case 'assistant-message':
          if (event.text.trim()) assistantTexts.push(event.text)
          break
        case 'activity-state':
          if (event.state.clear === true) {
            // clear 仅重置实时显示态
            latestStatus = undefined
            latestReasoningTail = undefined
          } else {
            if (event.state.status) latestStatus = event.state.status
            if (event.state.reasoningTail) latestReasoningTail = event.state.reasoningTail
            if (event.state.newToolCalls?.length) {
              // newToolCalls 实际是 toolDisplayLabel(name, args)，例如 'bash(autocli read ...)'。
              // 我们只关心工具名（去掉 `(...)` 后缀），多次调用 bash 只算一次。
              for (const label of event.state.newToolCalls) {
                const bareName = label.replace(/\(.*$/s, '').trim()
                if (bareName) toolNamesUsed.add(bareName)
              }
            }
          }
          break
        case 'lifecycle':
          if (
            event.phase === 'completed' ||
            event.phase === 'stopped' ||
            event.phase === 'failed'
          ) {
            terminalPhase = event.phase
            if (event.phase === 'failed') failedError = event.error.message
          }
          break
        case 'usage-info':
          // telegram 不展示 usage（与 wechat 一致）
          break
      }
    },

    flush() {
      const segments: string[] = []

      // 注意：故意不在 final 输出"🔧 使用了工具"摘要——
      // progress 容器已实时显示过工具列表；final 应该只发实质结果，避免重复信息。

      const fullText = assistantTexts.join('\n\n').trim()
      if (fullText) {
        const html = markdownToHtml(fullText)
        segments.push(...splitText(html, TEXT_CHUNK_LIMIT))
      }

      if (terminalPhase === 'failed' && failedError) {
        const safeError = failedError.split('\n')[0]?.slice(0, 200) ?? '未知错误'
        segments.push(`⚠️ 处理失败：${escapeHtml(safeError)}`)
      }

      if (segments.length === 0) {
        log.warn('flush 时无任何 segment（assistant text 与 tool 调用都为空）')
        segments.push('（本轮无输出）')
      }

      return segments
    },

    currentProgressHtml() {
      const lines: string[] = []
      if (toolNamesUsed.size > 0) {
        const sorted = [...toolNamesUsed].sort()
        lines.push(`🔧 ${escapeHtml(sorted.join(', '))}`)
      }
      if (latestReasoningTail) {
        const trimmed = truncateTail(latestReasoningTail, PROGRESS_LINE_LIMIT)
        lines.push(`💭 ${escapeHtml(trimmed)}`)
      }
      if (latestStatus) {
        const trimmed = truncateTail(latestStatus, PROGRESS_LINE_LIMIT)
        lines.push(`⏳ ${escapeHtml(trimmed)}`)
      }
      if (lines.length === 0) return STARTING_MESSAGE
      return lines.join('\n')
    },
  }
}

/** 取尾部 N 字符（reasoning 文本通常追加，关注尾部最新内容） */
function truncateTail(s: string, limit: number): string {
  if (s.length <= limit) return s
  return '…' + s.slice(s.length - limit + 1)
}

// ─── 工具函数（导出以便测试）────────────────────────────

/** HTML escape（仅 < > & 三个；属性引号不在文本上下文，单独处理） */
export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/** 链接 url escape（属性内还要 escape 引号） */
function escapeAttr(s: string): string {
  return escapeHtml(s).replace(/"/g, '&quot;')
}

/**
 * 把 markdown 子集转为 telegram HTML。
 *
 * 顺序：
 * 1. 按行扫描，识别 ``` 代码块 / 表格连续行
 * 2. 行级 markdown：标题 / 引用 / 无序列表 / 有序列表 → 行结构改写
 * 3. 行内 markdown：链接 / 强调 / 斜体 / 代码（详见 transformInlineRich）
 * 4. 表格转「结构化列表」：每行 = <b>序号. 标题</b> + 其它单元格分行 + URL 单独 <a> 链接
 *    无效表格（缺分隔符 / 单行）回退 <pre>
 */
export function markdownToHtml(text: string): string {
  const lines = text.split('\n')
  const out: string[] = []

  let inCodeBlock = false
  let codeBuffer: string[] = []
  let tableBuffer: string[] = []

  const flushTable = () => {
    if (tableBuffer.length === 0) return
    const list = tableToHtmlList(tableBuffer)
    if (list !== null) {
      out.push(list)
    } else {
      // 不是有效 markdown 表格 → 兜底走 <pre>
      out.push(`<pre>${escapeHtml(tableBuffer.join('\n'))}</pre>`)
    }
    tableBuffer = []
  }
  const flushCode = () => {
    out.push(`<pre>${escapeHtml(codeBuffer.join('\n'))}</pre>`)
    codeBuffer = []
  }

  for (const line of lines) {
    if (line.trimStart().startsWith('```')) {
      flushTable()
      if (inCodeBlock) {
        flushCode()
        inCodeBlock = false
      } else {
        inCodeBlock = true
      }
      continue
    }
    if (inCodeBlock) {
      codeBuffer.push(line)
      continue
    }

    if (line.trimStart().startsWith('|')) {
      tableBuffer.push(line)
      continue
    }
    flushTable()

    out.push(transformInline(line))
  }

  if (inCodeBlock) flushCode()
  flushTable()

  return out.join('\n')
}

const URL_RE = /^https?:\/\/\S+$/

function isUrl(s: string): boolean {
  return URL_RE.test(s.trim())
}

function isSeparatorRow(line: string): boolean {
  return /^\s*\|?[\s\-:|]+\|?\s*$/.test(line) && /-/.test(line)
}

function parseRow(line: string): string[] {
  const inner = line.trim().replace(/^\|/, '').replace(/\|$/, '')
  return inner.split('|').map((c) => c.trim())
}

/**
 * markdown table → 结构化列表 HTML。需 header + separator + ≥1 data 行；否则返回 null（caller 回退 <pre>）。
 * 启发式：
 * - URL 列（整 cell 是 URL）单独提取为 <a> 链接
 * - 第 1 列若是数字编号（'1' / '1.' / '#1' / '1)'）→ 与第 2 列拼成"1. 标题"加粗
 * - 否则第 1 列单独加粗
 * - 其它非链接列单独成行
 */
export function tableToHtmlList(lines: string[]): string | null {
  if (lines.length < 2) return null

  const sepIdx = lines.findIndex(isSeparatorRow)
  if (sepIdx < 1) return null

  const dataRows = lines.slice(sepIdx + 1).filter((l) => l.trim().length > 0)
  if (dataRows.length === 0) return null

  const items = dataRows
    .map((row) => {
      const cells = parseRow(row).filter((c) => c.length > 0)
      if (cells.length === 0) return ''

      const urlIdx = cells.findIndex(isUrl)
      const url = urlIdx >= 0 ? cells[urlIdx] : null
      const textCells = cells.filter((_, i) => i !== urlIdx)

      const parts: string[] = []
      if (textCells.length === 0) {
        // 仅有 URL，直接附下方链接
      } else if (textCells.length === 1) {
        parts.push(`<b>${escapeHtml(textCells[0]!)}</b>`)
      } else if (/^[#＃]?\d+[.、)]?$/.test(textCells[0]!)) {
        const idx = textCells[0]!.replace(/[.、)]$/, '')
        parts.push(`<b>${escapeHtml(idx)}. ${escapeHtml(textCells[1]!)}</b>`)
        for (const rest of textCells.slice(2)) parts.push(escapeHtml(rest))
      } else {
        parts.push(`<b>${escapeHtml(textCells[0]!)}</b>`)
        for (const rest of textCells.slice(1)) parts.push(escapeHtml(rest))
      }

      if (url && url !== '-') {
        parts.push(`🔗 <a href="${escapeAttr(url)}">${escapeHtml(url)}</a>`)
      }

      return parts.join('\n')
    })
    .filter((s) => s.length > 0)

  if (items.length === 0) return null
  return items.join('\n\n')
}

function transformInline(line: string): string {
  const blockquoteMatch = line.match(/^>\s?(.*)$/)
  if (blockquoteMatch) {
    return `<blockquote>${transformInlineRich(blockquoteMatch[1]!)}</blockquote>`
  }

  const titleMatch = line.match(/^(#{1,3})\s+(.+)$/)
  if (titleMatch) {
    return `<b>${transformInlineRich(titleMatch[2]!)}</b>`
  }

  const ulMatch = line.match(/^(\s*)[-*+]\s+(.+)$/)
  if (ulMatch) {
    return `${ulMatch[1]}• ${transformInlineRich(ulMatch[2]!)}`
  }

  const olMatch = line.match(/^(\s*)(\d+)[.)]\s+(.+)$/)
  if (olMatch) {
    return `${olMatch[1]}${olMatch[2]}. ${transformInlineRich(olMatch[3]!)}`
  }

  return transformInlineRich(line)
}

/**
 * 行内 markdown → HTML：链接 + 强调 + 斜体 + 行内代码。
 * 必须先识别 link（链接内不再做 emphasis 替换），再在非 link 片段上做强调/斜体/代码替换。
 */
function transformInlineRich(s: string): string {
  const segments: { kind: 'link' | 'plain'; text: string; href?: string }[] = []
  let last = 0
  const linkRe = /\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g
  let m: RegExpExecArray | null
  while ((m = linkRe.exec(s)) !== null) {
    if (m.index > last) segments.push({ kind: 'plain', text: s.slice(last, m.index) })
    segments.push({ kind: 'link', text: m[1]!, href: m[2]! })
    last = linkRe.lastIndex
  }
  if (last < s.length) segments.push({ kind: 'plain', text: s.slice(last) })

  return segments
    .map((seg) => {
      if (seg.kind === 'link') {
        return `<a href="${escapeAttr(seg.href!)}">${escapeHtml(seg.text)}</a>`
      }
      return applyEmphasis(seg.text)
    })
    .join('')
}

/**
 * 在普通文本（非 link）上做强调/斜体/inline code 替换。
 * 用 SUB() 控制字符做占位符（agent 输出永远不会含；escapeHtml 也不影响），
 * 先把 markdown 切成 token + 占位符，escapeHtml 处理普通文本，再把占位符还原成 HTML 标签。
 */
function applyEmphasis(text: string): string {
  type Tok = { tag: 'b' | 'i' | 'code'; inner: string }
  const tokens: Tok[] = []
  const PH_OPEN = "__TG_EMPH_O_"
  const PH_CLOSE = "_E_TG_EMPH__"
  const sub = (tag: Tok['tag'], inner: string): string => {
    tokens.push({ tag, inner })
    return `${PH_OPEN}${tokens.length - 1}${PH_CLOSE}`
  }
  let working = text

  // 顺序：1) inline code  2) ** / __  3) * / _
  working = working.replace(/`([^`]+)`/g, (_, inner: string) => sub('code', inner))
  working = working.replace(/\*\*([^\s*][^*]*?)\*\*/g, (_, inner: string) => sub('b', inner))
  working = working.replace(/__([^\s_][^_]*?)__/g, (_, inner: string) => sub('b', inner))
  working = working.replace(
    /(?<![A-Za-z0-9_])\*([^\s*][^*]*?)\*(?![A-Za-z0-9_])/g,
    (_, inner: string) => sub('i', inner),
  )
  working = working.replace(
    /(?<![A-Za-z0-9_])_([^\s_][^_]*?)_(?![A-Za-z0-9_])/g,
    (_, inner: string) => sub('i', inner),
  )

  const escaped = escapeHtml(working)
  return escaped.replace(/__TG_EMPH_O_(\d+)_E_TG_EMPH__/g, (_, idxStr: string) => {
    const tok = tokens[Number(idxStr)]!
    return `<${tok.tag}>${escapeHtml(tok.inner)}</${tok.tag}>`
  })
}

/**
 * 三级 fallback 切片：\n\n → \n → 硬切。
 * 硬切按 code point（避免 UTF-16 代理对截断）。
 */
export function splitText(text: string, limit: number): string[] {
  if (text.length <= limit) return [text]
  const chunks: string[] = []
  let rest = text
  while (rest.length > 0) {
    if (rest.length <= limit) {
      chunks.push(rest)
      break
    }
    let cut = rest.lastIndexOf('\n\n', limit)
    if (cut <= 0) cut = rest.lastIndexOf('\n', limit)
    if (cut <= 0) {
      const cps = [...rest]
      let acc = ''
      for (const cp of cps) {
        if (acc.length + cp.length > limit) break
        acc += cp
      }
      chunks.push(acc)
      rest = rest.slice(acc.length).replace(/^\n+/, '')
      continue
    }
    chunks.push(rest.slice(0, cut))
    rest = rest.slice(cut).replace(/^\n+/, '')
  }
  return chunks
}
