import { appendFile, mkdir } from 'node:fs/promises'
import path from 'node:path'
import type { ScheduledTaskRunRecord } from './types.ts'

// 单进程内按文件串行化：避免多 Promise 同时调 fs.appendFile 写出半行交错。
// 不同文件互不阻塞；同一文件的 N 个 append 在内存里依次接龙。
const lastByFile = new Map<string, Promise<void>>()

async function doAppend(file: string, record: ScheduledTaskRunRecord): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true })
  await appendFile(file, `${JSON.stringify(record)}\n`, 'utf8')
}

export function appendScheduledTaskRun(
  file: string,
  record: ScheduledTaskRunRecord,
): Promise<void> {
  const prev = lastByFile.get(file) ?? Promise.resolve()
  const next = prev.then(() => doAppend(file, record))
  lastByFile.set(
    file,
    next.catch(() => {
      // 节点链不因单次写入失败永久卡住后续 append；调用方仍能拿到原始错误。
    }),
  )
  return next
}
