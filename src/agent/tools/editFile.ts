import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { tool } from 'ai'
import { z } from 'zod'
import type { ToolContext } from './bash.ts'
import {
  applyEditToFile,
  countOccurrences,
  findActualString,
  preserveQuoteStyle,
} from './editFileUtils.ts'

export function editFileTool(ctx: ToolContext) {
  return tool({
    description:
      '对文件做精确字符串替换。old_string 必须在文件中唯一出现；若要替换多处需显式传 replace_all。相比 bash+sed 更可靠：不需要转义正则、跨平台一致、失败有明确反馈。若工具返回 ok=false，表示这是可恢复的校验失败，不是系统异常：先用 bash cat/rg 读取目标附近上下文，再用 2-8 行能唯一定位的 old_string 重试；若本来就要全量替换，再传 replace_all=true。对于 JSX/重复列表项/相似按钮文案，单行 old_string 往往不够，优先包含父节点、条件分支或相邻 2-8 行。',
    parameters: z.object({
      path: z.string(),
      old_string: z.string().min(1),
      new_string: z.string(),
      replace_all: z.boolean().optional(),
    }),
    async execute({ path: rel, old_string, new_string, replace_all }) {
      const abs = path.resolve(ctx.cwd, rel)
      const original = await readFile(abs, 'utf8')
      if (old_string === new_string) {
        return {
          ok: false,
          path: rel,
          error: 'old_string_identical',
          message: `old_string and new_string are identical in ${rel}`,
          suggestion: '请提供实际会产生变化的新内容；不要提交空编辑。',
        }
      }
      const actualOldString = findActualString(original, old_string)
      if (!actualOldString) {
        return {
          ok: false,
          path: rel,
          error: 'old_string_not_found',
          message: `old_string not found in ${rel}. 请确认文本完全匹配，必要时补更多上下文。`,
          suggestion:
            '先用 bash cat/rg 读取目标附近内容，再复制文件中的精确片段；若是引号差异可保留当前写法重试。',
        }
      }
      const count = countOccurrences(original, actualOldString)
      if (count > 1 && !replace_all) {
        return {
          ok: false,
          path: rel,
          error: 'old_string_not_unique',
          message: `old_string not unique in ${rel} (${count} matches). 提供更多上下文让它唯一，或传 replace_all=true。`,
          suggestion:
            '先用 bash cat 读取命中位置附近内容，再把 old_string 扩展为包含父节点/条件分支/相邻 2-8 行的唯一片段；若本来就是全量替换，请改用 replace_all=true。',
          matches: count,
        }
      }
      const actualNewString = preserveQuoteStyle(old_string, actualOldString, new_string)
      const updated = applyEditToFile(
        original,
        actualOldString,
        actualNewString,
        Boolean(replace_all),
      )
      if (updated === original) {
        return {
          ok: false,
          path: rel,
          error: 'edit_produced_no_changes',
          message: `edit produced no changes in ${rel}`,
          suggestion: '请检查 old_string / new_string 是否真的会改变文件内容。',
        }
      }
      await writeFile(abs, updated)
      return { ok: true, path: rel, replaced: replace_all ? count : 1 }
    },
  })
}
