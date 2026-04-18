import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { WorkspacePaths } from '@/workspace/paths.ts'

export interface MemoryStore {
  save(args: { category: string; slug: string; content: string }): Promise<string>
}

export function createMemoryStore(paths: WorkspacePaths): MemoryStore {
  return {
    async save({ category, slug, content }) {
      await mkdir(paths.memoryDir, { recursive: true })
      const safeSlug = slug.replace(/[^\w.-]/g, '_')
      const file = path.join(paths.memoryDir, `${category}-${safeSlug}.md`)
      const body = `---\ncategory: ${category}\ncreatedAt: ${new Date().toISOString()}\n---\n\n${content}\n`
      await writeFile(file, body)
      return file
    },
  }
}
