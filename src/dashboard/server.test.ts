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

  it('Channel Tasks API 支持模板生成、保存校验和删除', async () => {
    const server = await startDashboardServer({
      cwd: workspaceDir,
      host: '127.0.0.1',
      port: 0,
      logger: stubLogger,
    })

    try {
      const initial = (await (await fetch(`${server.url}/api/channel-tasks`)).json()) as {
        exists: boolean
        parsed: { enabled: boolean; rules: unknown[] }
        validation: { ok: boolean }
      }
      expect(initial.exists).toBe(false)
      expect(initial.parsed.enabled).toBe(false)
      expect(initial.parsed.rules).toEqual([])
      expect(initial.validation.ok).toBe(true)

      const templateResp = await fetch(`${server.url}/api/channel-tasks/template`, {
        method: 'POST',
      })
      expect(templateResp.ok).toBe(true)
      const template = (await templateResp.json()) as { raw: string; created: boolean }
      expect(template.created).toBe(true)
      expect(template.raw).toContain('Slack 频道任务监听配置')

      const duplicateTemplateResp = await fetch(`${server.url}/api/channel-tasks/template`, {
        method: 'POST',
      })
      expect(duplicateTemplateResp.status).toBe(409)

      const invalidResp = await fetch(`${server.url}/api/channel-tasks`, {
        method: 'PUT',
        headers: { 'content-type': 'text/plain' },
        body: 'version: 1\nenabled: true\nrules:\n  - id: bad\n    task:\n      prompt: ""\n',
      })
      expect(invalidResp.status).toBe(400)

      const validYaml = [
        'version: 1',
        'enabled: true',
        'rules:',
        '  - id: rule-1',
        '    channelIds: [C1]',
        '    source:',
        '      userIds: [U1]',
        '    task:',
        '      prompt: 处理消息',
        '',
      ].join('\n')
      const saveResp = await fetch(`${server.url}/api/channel-tasks`, {
        method: 'PUT',
        headers: { 'content-type': 'text/plain' },
        body: validYaml,
      })
      expect(saveResp.ok).toBe(true)
      const saved = (await saveResp.json()) as {
        parsed: { enabled: boolean; rules: Array<{ id: string }> }
        raw: string
      }
      expect(saved.raw).toBe(validYaml)
      expect(saved.parsed.enabled).toBe(true)
      expect(saved.parsed.rules[0]?.id).toBe('rule-1')

      const loaded = (await (await fetch(`${server.url}/api/channel-tasks`)).json()) as {
        exists: boolean
        parsed: { enabled: boolean; rules: Array<{ id: string }> }
        validation: { ok: boolean }
      }
      expect(loaded.exists).toBe(true)
      expect(loaded.validation.ok).toBe(true)
      expect(loaded.parsed.rules[0]?.id).toBe('rule-1')

      const deleteResp = await fetch(`${server.url}/api/channel-tasks`, { method: 'DELETE' })
      expect(deleteResp.ok).toBe(true)
      const deleted = (await deleteResp.json()) as { deleted: boolean }
      expect(deleted.deleted).toBe(true)
    } finally {
      await server.stop().catch(() => {})
    }
  })
})
