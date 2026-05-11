// 微信 context_token 持久化 store（spec §6.4 长期方案前置落地）。
//
// 行为：
// - 启动时一次性加载（不存在或损坏 → 空 store，daemon 仍能起）
// - 入站消息处理时调 save(peerUserId, token) → 内存立即生效 + 异步落盘（原子 write+rename）
// - scheduled 路径起跑时调 get(peerUserId) → 缺失返回 undefined，调用方应抛 MissingContextTokenError
// - 同进程内按"全文件锁链"串行化 save，避免半截 JSON

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'

export interface ContextTokenStore {
  get(peerUserId: string): string | undefined
  save(peerUserId: string, token: string): Promise<void>
}

export async function createContextTokenStore(file: string): Promise<ContextTokenStore> {
  const memory = new Map<string, string>()

  // 1. 初始加载：文件不存在 / 损坏 → 内存留空，不阻塞 daemon
  try {
    const raw = await readFile(file, 'utf8')
    const parsed = JSON.parse(raw) as Record<string, unknown>
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      for (const [k, v] of Object.entries(parsed)) {
        if (typeof v === 'string') memory.set(k, v)
      }
    }
  } catch {
    // ENOENT / SyntaxError 一律视为空 store
  }

  // 同进程内串行化 save：原子 write+rename 仍需避免并发覆盖中间状态
  let writeChain: Promise<void> = Promise.resolve()

  async function persist(): Promise<void> {
    await mkdir(path.dirname(file), { recursive: true })
    const snapshot: Record<string, string> = {}
    for (const [k, v] of memory) snapshot[k] = v
    const tmp = `${file}.tmp.${process.pid}.${Date.now()}`
    await writeFile(tmp, JSON.stringify(snapshot, null, 2), 'utf8')
    await rename(tmp, file)
  }

  return {
    get(peerUserId) {
      return memory.get(peerUserId)
    },
    save(peerUserId, token) {
      memory.set(peerUserId, token)
      const next = writeChain.then(persist)
      writeChain = next.catch(() => {
        // 链不因单次写入失败永久卡死后续 save；调用方仍能拿到原始错误
      })
      return next
    },
  }
}
