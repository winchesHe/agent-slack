import { readFile, writeFile, mkdir, unlink, chmod } from 'node:fs/promises'
import path from 'node:path'
import type { WechatCredentials } from './WechatApi.ts'

export interface CredentialsStore {
  load(filePath: string): Promise<WechatCredentials | undefined>
  save(filePath: string, creds: WechatCredentials): Promise<void>
  clear(filePath: string): Promise<void>
}

export function createCredentialsStore(): CredentialsStore {
  return {
    async load(filePath) {
      try {
        const raw = await readFile(filePath, 'utf8')
        const parsed = JSON.parse(raw) as Partial<WechatCredentials>
        if (!parsed.token || !parsed.baseUrl) return undefined
        return {
          token: parsed.token,
          baseUrl: parsed.baseUrl,
          botId: parsed.botId ?? '',
          userId: parsed.userId ?? '',
        }
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined
        throw err
      }
    },

    async save(filePath, creds) {
      await mkdir(path.dirname(filePath), { recursive: true })
      await writeFile(filePath, JSON.stringify(creds, null, 2), 'utf8')
      // Windows / 非 POSIX FS 上 chmod 0600 会静默忽略或报错；按 CowAgent 设计兜底
      try {
        await chmod(filePath, 0o600)
      } catch {
        // 忽略
      }
    },

    async clear(filePath) {
      try {
        await unlink(filePath)
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
      }
    },
  }
}
