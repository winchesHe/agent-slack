import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { tool } from 'ai'
import { z } from 'zod'
import type { Logger } from '@/logger/logger.ts'
import type { WorkspacePaths } from '@/workspace/paths.ts'
import type { ToolContext } from './bash.ts'
import {
  createSelfImproveGenerator,
  type CandidateRule,
  type SelfImproveGenerator,
} from './selfImprove.generator.ts'

export interface SelfImproveConfirmDeps {
  generator: SelfImproveGenerator
  paths: WorkspacePaths
  logger: Logger
}

/** self_improve 写入 system.md 时使用的固定标题；不存在时自动创建 */
const SELF_IMPROVE_SECTION_HEADING = '## 由 self_improve 产生的规则'

/**
 * self_improve_confirm：接收主 Agent 产出的候选规则，经 generator 去重/排序后，
 * 通过 ctx.confirm 发送到 IM 供用户逐条点击确认；采纳的规则在 onDecision 里追加写入 system.md。
 */
export function selfImproveConfirmTool(ctx: ToolContext, deps: SelfImproveConfirmDeps) {
  const generator = deps.generator ?? createSelfImproveGenerator()

  return tool({
    description:
      '将你已生成的候选规则（CandidateRule[]）发送到 IM 供用户逐条点击确认。tool 会先做字段校验 / 与现有规则去重 / 组内去重 / 排序，只发送处理后的条目。用户采纳的规则自动追加写入 .agent-slack/system.md。',
    parameters: z.object({
      rules: z
        .array(
          z.object({
            id: z.string().min(1),
            content: z.string().min(1),
            category: z.string(),
            confidence: z.enum(['high', 'medium']),
            evidence: z.string(),
          }),
        )
        .min(1),
    }),
    async execute({ rules }) {
      if (!ctx.confirm) {
        ctx.logger.warn('self_improve_confirm 被调用但无 IM 确认通道', {
          ruleCount: rules.length,
        })
        return {
          sent: 0,
          skipped: rules.length,
          reason: 'no_confirm_channel' as const,
        }
      }

      const existingRules = await readFileSafe(deps.paths.systemFile)
      const processed: CandidateRule[] = generator.process(rules, existingRules)

      if (processed.length === 0) {
        return { sent: 0, skipped: rules.length, reason: 'all_filtered' as const }
      }

      const ruleById = new Map(processed.map((r) => [r.id, r]))

      await ctx.confirm.send({
        items: processed.map((r, i) => ({
          id: r.id,
          body: `*📝 候选规则 (${i + 1}/${processed.length})*\n分类：\`${r.category}\` · 置信度：${r.confidence === 'high' ? '🟢' : '🟡'} ${r.confidence}\n\n> ${r.content}`,
          context: `📎 *证据*：${r.evidence}`,
        })),
        namespace: 'self_improve',
        labels: { accept: '✅ 采纳', reject: '❌ 跳过' },
        onDecision: async (ruleId, decision) => {
          if (decision !== 'accept') return
          const rule = ruleById.get(ruleId)
          if (!rule) return
          try {
            await appendAcceptedRuleToSystemMd(deps.paths.systemFile, rule)
          } catch (err) {
            deps.logger.error('写入 system.md 失败', { ruleId, err })
          }
        },
      })

      return {
        sent: processed.length,
        skipped: rules.length - processed.length,
      }
    },
  })
}

// ── 写入 system.md 辅助 ─────────────────────────────

async function readFileSafe(file: string): Promise<string> {
  try {
    return await readFile(file, 'utf8')
  } catch {
    return ''
  }
}

/**
 * 将采纳的规则追加到 system.md 的 `## 由 self_improve 产生的规则` 标题下。
 * - 文件不存在 / 标题不存在时自动创建
 * - 若段内已含相同 content（完全匹配）则跳过，避免重复写入
 */
async function appendAcceptedRuleToSystemMd(file: string, rule: CandidateRule): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true })
  const existing = await readFileSafe(file)
  const entry = buildRuleEntry(rule)

  // 完全匹配去重
  if (existing.includes(entry.trim())) return

  let next: string
  if (existing.includes(SELF_IMPROVE_SECTION_HEADING)) {
    next = insertIntoSection(existing, SELF_IMPROVE_SECTION_HEADING, entry)
  } else {
    const prefix = existing.length > 0 && !existing.endsWith('\n') ? `${existing}\n` : existing
    next = `${prefix}\n${SELF_IMPROVE_SECTION_HEADING}\n${entry}`
  }
  await writeFile(file, next, 'utf8')
}

function buildRuleEntry(rule: CandidateRule): string {
  const timestamp = new Date().toISOString()
  return `\n<!-- self_improve: ${rule.id} · ${rule.category} · ${rule.confidence} · ${timestamp} -->\n${rule.content.trim()}\n`
}

/** 把 entry 追加到指定标题的 section 末尾（下一个同级/更高级标题之前） */
function insertIntoSection(md: string, heading: string, entry: string): string {
  const lines = md.split('\n')
  const start = lines.findIndex((l) => l.trim() === heading)
  if (start === -1) return `${md}\n${heading}\n${entry}`

  // 找下一个 `#`/`##` 标题作为 section 结束边界
  let end = lines.length
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i] ?? ''
    if (/^#{1,2}\s/.test(line)) {
      end = i
      break
    }
  }
  const before = lines.slice(0, end).join('\n').replace(/\s+$/, '')
  const after = lines.slice(end).join('\n')
  const glue = after.length > 0 ? `\n\n${after}` : '\n'
  return `${before}\n${entry}${glue}`
}
