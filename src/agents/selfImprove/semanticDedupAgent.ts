/**
 * self_improve 的 LLM 语义去重层。
 *
 * 接收主 Agent 产出的 CandidateRule[] + 现有规则原文（experience.md / system.md），
 * 调一次 LLM 对每条候选给出 keep/drop 判决；失败由调用方降级到 Jaccard generator。
 */

import { generateObject, type LanguageModel } from 'ai'
import { z } from 'zod'
import type { Logger } from '@/logger/logger.ts'
import type { CandidateRule } from './generatorAgent.ts'

export interface SemanticDedupInput {
  rules: CandidateRule[]
  existingExperience: string
  existingSystem: string
}

export interface SemanticDedupDecision {
  id: string
  action: 'keep' | 'drop'
  reason?: string
}

export interface SemanticDedupResult {
  decisions: SemanticDedupDecision[]
}

export interface SemanticDedup {
  process(input: SemanticDedupInput): Promise<SemanticDedupResult>
}

export interface SemanticDedupDeps {
  model: LanguageModel
  logger: Logger
}

const decisionSchema = z.object({
  decisions: z.array(
    z.object({
      id: z.string().min(1),
      action: z.enum(['keep', 'drop']),
      reason: z.string().optional(),
    }),
  ),
})

const SYSTEM_PROMPT = `你是规则去重助手。输入一组候选规则 + 已存在的经验/系统规则原文。
任务：判断每条候选规则是否与已有规则（或组内其他候选）语义重复。
- 同义改写、涵盖相同主题且结论一致 → drop
- 组内两条表达几乎相同 → 只保留一条（其余 drop），并在 reason 标注保留的 id
- 确为新规则 → keep
仅输出 JSON，字段：decisions[{id, action, reason?}]；每条候选必须出现且仅出现一次，不要新增未在输入中的 id。`

function buildUserPrompt(input: SemanticDedupInput): string {
  const rulesBlock = input.rules
    .map(
      (r, i) =>
        `${i + 1}. id=${r.id} category=${r.category} confidence=${r.confidence}\n   content: ${r.content}`,
    )
    .join('\n')
  const exp = input.existingExperience.trim() || '(空)'
  const sys = input.existingSystem.trim() || '(空)'
  return `## 候选规则（共 ${input.rules.length} 条）
${rulesBlock}

## 已有 experience.md
${exp}

## 已有 system.md
${sys}

请对上面每条候选给出 keep/drop 决定。输出必须是 json 对象，严格匹配上面的 json schema。`
}

export function createSemanticDedup(deps: SemanticDedupDeps): SemanticDedup {
  const log = deps.logger.withTag('self-improve:semantic-dedup')

  return {
    async process(input) {
      if (input.rules.length === 0) return { decisions: [] }

      const { object } = await generateObject({
        model: deps.model,
        mode: 'json',
        schema: decisionSchema,
        system: SYSTEM_PROMPT,
        prompt: buildUserPrompt(input),
      })

      const inputIds = new Set(input.rules.map((r) => r.id))
      const decisions: SemanticDedupDecision[] = []
      const seen = new Set<string>()
      for (const d of object.decisions) {
        if (!inputIds.has(d.id)) continue
        if (seen.has(d.id)) continue
        seen.add(d.id)
        const entry: SemanticDedupDecision = { id: d.id, action: d.action }
        if (d.reason !== undefined) entry.reason = d.reason
        decisions.push(entry)
      }
      // 输入里未被 LLM 覆盖的 id 按 keep 处理，避免静默丢规则
      for (const r of input.rules) {
        if (!seen.has(r.id))
          decisions.push({ id: r.id, action: 'keep', reason: 'missing-from-llm-output' })
      }

      log.debug('语义去重完成', {
        input: input.rules.length,
        keep: decisions.filter((d) => d.action === 'keep').length,
        drop: decisions.filter((d) => d.action === 'drop').length,
      })

      return { decisions }
    },
  }
}
