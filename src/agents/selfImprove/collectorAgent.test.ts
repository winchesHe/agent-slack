import { describe, expect, it } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { Logger } from '@/logger/logger.ts'
import { resolveWorkspacePaths } from '@/workspace/paths.ts'
import { createSelfImproveCollector } from './collectorAgent.ts'

function logger(): Logger {
  return {
    trace: () => {},
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
    withTag: () => logger(),
  }
}

describe('createSelfImproveCollector', () => {
  it('从公共 agents 目录的 collector 收集 session / memory / existing rules', async () => {
    const cwd = mkdtempSync(path.join(tmpdir(), 'self-improve-collector-'))
    const paths = resolveWorkspacePaths(cwd)
    const sessionDir = path.join(paths.sessionsDir, 'slack', 'general.C1.1000.000')
    await mkdir(sessionDir, { recursive: true })
    await mkdir(paths.memoryDir, { recursive: true })
    await mkdir(path.dirname(paths.experienceFile), { recursive: true })

    await writeFile(
      path.join(sessionDir, 'meta.json'),
      JSON.stringify({
        channelName: 'general',
        createdAt: '2026-04-26T00:00:00.000Z',
        updatedAt: '2026-04-26T00:01:00.000Z',
      }),
      'utf8',
    )
    await writeFile(
      path.join(sessionDir, 'messages.jsonl'),
      [
        JSON.stringify({ role: 'user', content: '请记录经验' }),
        JSON.stringify({ role: 'assistant', content: '已总结规则' }),
        '',
      ].join('\n'),
      'utf8',
    )
    await writeFile(path.join(paths.memoryDir, 'alice.md'), '用户偏好中文回复', 'utf8')
    await writeFile(paths.experienceFile, '- 已有经验规则', 'utf8')
    await writeFile(paths.systemFile, '## 经验\n系统规则', 'utf8')

    const collector = createSelfImproveCollector({ paths, logger: logger() })
    const result = await collector.collect('--all')

    expect(result.sessions).toHaveLength(1)
    expect(result.sessions[0]).toMatchObject({
      sessionId: 'general.C1.1000.000',
      channelName: 'general',
      messageCount: 2,
      rounds: [{ userMessage: '请记录经验', assistantTexts: ['已总结规则'] }],
    })
    expect(result.memories).toEqual([{ fileName: 'alice.md', content: '用户偏好中文回复' }])
    expect(result.existingRules).toContain('已有经验规则')
    expect(result.existingRules).toContain('系统规则')
  })
})
