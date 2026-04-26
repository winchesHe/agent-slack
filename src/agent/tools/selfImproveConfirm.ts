import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { tool } from 'ai'
import { z } from 'zod'
import type { Logger } from '@/logger/logger.ts'
import type { WorkspacePaths } from '@/workspace/paths.ts'
import type { ToolContext } from './bash.ts'
import {
  compareRules,
  createSelfImproveGenerator,
  type CandidateRule,
  type SelfImproveGenerator,
} from './selfImprove.generator.ts'
import type { SemanticDedup } from './selfImprove.semanticDedup.ts'

export interface SelfImproveConfirmDeps {
  generator: SelfImproveGenerator
  /** LLM 语义去重（可选；不存在时直接走 generator 纯代码去重） */
  semanticDedup?: SemanticDedup
  paths: WorkspacePaths
  logger: Logger
}

/** 注入到 system.md 的引用段；以标题做幂等去重，不使用 HTML 注释（避免占用 context） */
const SYSTEM_EXPERIENCE_REF_HEADING = '## 经验'
const SYSTEM_EXPERIENCE_REF_BODY = `${SYSTEM_EXPERIENCE_REF_HEADING}

每次执行任务前请先阅读 \`.agent-slack/experience.md\`，吸收历史经验与规则。`

/**
 * self_improve_confirm：接收主 Agent 产出的候选规则，经 generator 去重/排序后，
 * 通过 ctx.confirm 发送到 IM 供用户逐条点击确认；采纳的规则在 onDecision 里追加写入 experience.md。
 */
export function selfImproveConfirmTool(ctx: ToolContext, deps: SelfImproveConfirmDeps) {
  const generator = deps.generator ?? createSelfImproveGenerator()

  return tool({
    description:
      '将你已生成的候选规则（CandidateRule[]）发送到 IM 供用户逐条点击确认。tool 会先做字段校验、再用 LLM 对照 experience.md / system.md 做语义去重（失败降级为 Jaccard 去重），排序后只发送处理后的条目。用户采纳的规则自动追加写入 .agent-slack/experience.md。',
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

      const [existingExperience, existingSystem] = await Promise.all([
        readFileSafe(deps.paths.experienceFile),
        readFileSafe(deps.paths.systemFile),
      ])

      // 语义去重（失败降级到 Jaccard generator）
      let processed: CandidateRule[]
      let dedupMode: 'semantic' | 'generator'
      if (deps.semanticDedup) {
        try {
          const { decisions } = await deps.semanticDedup.process({
            rules,
            existingExperience,
            existingSystem,
          })
          const keepIds = new Set(decisions.filter((d) => d.action === 'keep').map((d) => d.id))
          const kept = rules.filter((r) => keepIds.has(r.id))
          processed = [...kept].sort(compareRules)
          dedupMode = 'semantic'
        } catch (err) {
          deps.logger.warn('语义去重失败，降级到 Jaccard generator', { err })
          const existingRules = [existingExperience, existingSystem]
            .filter((s) => s.length > 0)
            .join('\n')
          processed = generator.process(rules, existingRules)
          dedupMode = 'generator'
        }
      } else {
        const existingRules = [existingExperience, existingSystem]
          .filter((s) => s.length > 0)
          .join('\n')
        processed = generator.process(rules, existingRules)
        dedupMode = 'generator'
      }

      if (processed.length === 0) {
        return { sent: 0, skipped: rules.length, reason: 'all_filtered' as const, dedupMode }
      }

      // 一次性幂等：若 system.md 未包含 `## 经验` 标题则注入引用
      try {
        await ensureSystemExperienceRef(deps.paths.systemFile)
      } catch (err) {
        deps.logger.error('注入 system.md experience 引用失败', { err })
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
            await appendAcceptedRuleToExperienceMd(deps.paths.experienceFile, rule)
          } catch (err) {
            deps.logger.error('写入 experience.md 失败', { ruleId, err })
          }
        },
      })

      return {
        sent: processed.length,
        skipped: rules.length - processed.length,
        dedupMode,
      }
    },
  })
}

// ── 写入 experience.md / system.md 引用 辅助 ─────────────

async function readFileSafe(file: string): Promise<string> {
  try {
    return await readFile(file, 'utf8')
  } catch {
    return ''
  }
}

/**
 * 将采纳的规则追加到 experience.md 尾部。
 * - 文件不存在时自动创建
 * - 若文件内已含相同 content（trim 后完全匹配）则跳过，避免重复写入
 * - 条目纯 content，不加 HTML 注释元信息（减少 agent 每次读文件的 context 开销）
 */
async function appendAcceptedRuleToExperienceMd(file: string, rule: CandidateRule): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true })
  const existing = await readFileSafe(file)
  const content = rule.content.trim()

  if (existing.includes(content)) return

  const prefix = existing.length > 0 && !existing.endsWith('\n') ? `${existing}\n` : existing
  const separator = existing.length > 0 ? '\n' : ''
  await writeFile(file, `${prefix}${separator}${content}\n`, 'utf8')
}

/**
 * 在 system.md 顶部注入引用 experience.md 的提示段。
 * 以固定标题 `## 经验` 做幂等去重；system.md 已包含该标题时什么都不做。
 */
async function ensureSystemExperienceRef(file: string): Promise<void> {
  const existing = await readFileSafe(file)
  if (existing.includes(SYSTEM_EXPERIENCE_REF_HEADING)) return
  await mkdir(path.dirname(file), { recursive: true })
  const trailing =
    existing.length === 0 ? '' : existing.startsWith('\n') ? existing : `\n${existing}`
  await writeFile(file, `${SYSTEM_EXPERIENCE_REF_BODY}\n${trailing}`, 'utf8')
}
