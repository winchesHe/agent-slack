import { tool } from 'ai'
import { z } from 'zod'
import type { MemoryStore } from '@/store/MemoryStore.ts'
import type { ToolContext } from './bash.ts'

export function saveMemoryTool(ctx: ToolContext, deps: { memoryStore: MemoryStore }) {
  return tool({
    description:
      '保存当前用户的长期记忆（覆盖写入；合并由你负责）。调用前如已有旧 memory，先用 bash 读取再合并整体传入。内容为 Markdown，不含 frontmatter（工具自动加）。',
    parameters: z.object({
      content: z.string().min(1),
    }),
    async execute({ content }) {
      if (!ctx.currentUser) {
        throw new Error('save_memory 不可用：缺少 currentUser（wiring 问题，不要重试）')
      }
      const file = await deps.memoryStore.save({
        userName: ctx.currentUser.userName,
        userId: ctx.currentUser.userId,
        content,
      })
      return { savedTo: file }
    },
  })
}
