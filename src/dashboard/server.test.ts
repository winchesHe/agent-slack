import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, rmSync } from 'node:fs'
import path from 'node:path'
import { startDashboardServer } from './server.ts'
import type { Logger } from '@/logger/logger.ts'

let workspaceDir: string

const stubLogger: Logger = {
  withTag: () => stubLogger,
  trace: () => {},
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
}

beforeEach(() => {
  const timestamp = Date.now()
  const random = Math.random().toString(36).slice(2, 8)
  const testTmpBase = path.join(process.cwd(), 'memory/.test-tmp')
  workspaceDir = path.join(testTmpBase, `dashboard-${timestamp}-${random}`)
  mkdirSync(workspaceDir, { recursive: true })
})

afterEach(() => {
  if (workspaceDir) {
    rmSync(workspaceDir, { recursive: true, force: true })
  }
})

describe('startDashboardServer', () => {
  it('活跃 SSE 连接存在时，stop 仍能在短时间内完成并关闭流', async () => {
    const server = await startDashboardServer({
      cwd: workspaceDir,
      host: '127.0.0.1',
      port: 0,
      logger: stubLogger,
    })

    let stopped = false
    try {
      const response = await fetch(`${server.url}/api/stream`)
      expect(response.ok).toBe(true)
      expect(response.body).toBeTruthy()

      const reader = response.body!.getReader()
      const firstChunk = await reader.read()
      expect(firstChunk.done).toBe(false)

      await expect(
        Promise.race([
          server.stop().then(() => {
            stopped = true
          }),
          new Promise<never>((_, reject) => {
            setTimeout(() => reject(new Error('stop timeout')), 1500)
          }),
        ]),
      ).resolves.toBeUndefined()

      const closedChunk = await Promise.race([
        reader.read(),
        new Promise<never>((_, reject) => {
          setTimeout(() => reject(new Error('stream did not close')), 1000)
        }),
      ])
      expect(closedChunk.done).toBe(true)
    } finally {
      if (!stopped) {
        await server.stop().catch(() => {})
      }
    }
  })
})
