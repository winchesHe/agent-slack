import { tool } from 'ai'
import { z } from 'zod'
import type { MemoryStore } from '@/store/MemoryStore.ts'

export function saveMemoryTool(deps: { memoryStore: MemoryStore }) {
  return tool({
    description:
      '保存跨会话长期记忆（分类 + slug）。内容为 Markdown，不含 frontmatter（工具自动加）。',
    parameters: z.object({
      category: z.enum(['user', 'feedback', 'project', 'reference']),
      slug: z.string().min(1).max(64),
      content: z.string().min(1),
    }),
    async execute({ category, slug, content }) {
      const file = await deps.memoryStore.save({ category, slug, content })
      return { savedTo: file }
    },
  })
}
