import { mkdir, writeFile, access } from 'node:fs/promises'
import path from 'node:path'
import type { WorkspacePaths } from '@/workspace/paths.ts'
import { sanitizeFsSegment } from '@/workspace/paths.ts'

export interface MemoryStore {
  /** 以用户为主键返回 memory 文件绝对路径（不保证存在）。 */
  pathFor(userName: string, userId: string): string
  /** 目标 memory 文件是否存在。 */
  exists(userName: string, userId: string): Promise<boolean>
  /** 覆盖写入 memory（由主 agent 负责合并语义）；返回写入的绝对路径。 */
  save(args: { userName: string; userId: string; content: string }): Promise<string>
}

function filenameFor(userName: string, userId: string): string {
  return `${sanitizeFsSegment(userName)}-${sanitizeFsSegment(userId)}.md`
}

export function createMemoryStore(paths: WorkspacePaths): MemoryStore {
  const pathFor = (userName: string, userId: string): string =>
    path.join(paths.memoryDir, filenameFor(userName, userId))

  return {
    pathFor,

    async exists(userName, userId) {
      try {
        await access(pathFor(userName, userId))
        return true
      } catch {
        return false
      }
    },

    async save({ userName, userId, content }) {
      await mkdir(paths.memoryDir, { recursive: true })
      const file = pathFor(userName, userId)
      const body = `---\nupdatedAt: ${new Date().toISOString()}\n---\n\n${content}\n`
      await writeFile(file, body)
      return file
    },
  }
}
