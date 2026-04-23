import { tool } from 'ai'
import { z } from 'zod'
import type { ToolContext } from './bash.ts'
import type { SelfImproveCollector } from './selfImprove.collector.ts'
import { AGENTS_RULE_WRITING_GUIDE } from './selfImprove.constants.ts'

export interface SelfImproveCollectDeps {
  collector: SelfImproveCollector
}

/**
 * self_improve_collect：收集 session / memory / 现有规则，并返回 AGENTS_RULE_WRITING_GUIDE。
 * 不做 LLM 推理，只做 IO 聚合。主 Agent 基于返回数据 + guide 在自己的 assistant 回合里生成候选规则 JSON，
 * 再调 self_improve_confirm 做后处理 + 发送。
 */
export function selfImproveCollectTool(_ctx: ToolContext, deps: SelfImproveCollectDeps) {
  return tool({
    description:
      '收集当前工作区 session 历史 / memory / 现有规则，返回摘要与 AGENTS.md 编写指南。返回后你需要基于数据自行提炼候选规则 JSON，再调用 self_improve_confirm 发送确认。',
    parameters: z.object({
      scope: z
        .union([z.literal('--all'), z.number().int().positive()])
        .optional()
        .describe(
          '分析范围：--all=扫描全部历史 session（默认）；数字=最近 N 天。' +
            '用户说"最近经验"时传 7；指定天数时传对应数字；说"全部"或未指定时默认 --all。',
        ),
      focus: z
        .string()
        .optional()
        .describe('聚焦主题提示（仅透传到返回值的 focus 字段，供你自行参考）'),
    }),
    async execute({ scope, focus }) {
      const data = await deps.collector.collect(scope ?? '--all')
      return {
        ...data,
        guide: AGENTS_RULE_WRITING_GUIDE,
        focus: focus ?? null,
      }
    },
  })
}
