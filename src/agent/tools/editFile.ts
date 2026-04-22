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
      '对文件做精确字符串替换。old_string 必须在文件中唯一出现；若要替换多处需显式传 replace_all。相比 bash+sed 更可靠：不需要转义正则、跨平台一致、失败有明确反馈。',
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
        throw new Error(`old_string and new_string are identical in ${rel}`)
      }
      const actualOldString = findActualString(original, old_string)
      if (!actualOldString) {
        throw new Error(`old_string not found in ${rel}. 请确认文本完全匹配，必要时补更多上下文。`)
      }
      const count = countOccurrences(original, actualOldString)
      if (count > 1 && !replace_all) {
        throw new Error(
          `old_string not unique in ${rel} (${count} matches). 提供更多上下文让它唯一，或传 replace_all=true。`,
        )
      }
      const actualNewString = preserveQuoteStyle(old_string, actualOldString, new_string)
      const updated = applyEditToFile(
        original,
        actualOldString,
        actualNewString,
        Boolean(replace_all),
      )
      if (updated === original) {
        throw new Error(`edit produced no changes in ${rel}`)
      }
      await writeFile(abs, updated)
      return { path: rel, replaced: replace_all ? count : 1 }
    },
  })
}
