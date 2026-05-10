import fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { resolveWorkspacePaths } from '@/workspace/paths.ts'
import { cleanupSlackSessionForThread } from './scenario-utils.ts'

describe('cleanupSlackSessionForThread', () => {
  let workspaceDir: string
  let slackSessionsDir: string

  beforeEach(async () => {
    workspaceDir = await fs.mkdtemp(path.join(tmpdir(), 'scenario-utils-test-'))
    slackSessionsDir = path.join(resolveWorkspacePaths(workspaceDir).sessionsDir, 'slack')
    await fs.mkdir(slackSessionsDir, { recursive: true })
    delete process.env.SLACK_E2E_KEEP_SESSION
  })

  afterEach(async () => {
    delete process.env.SLACK_E2E_KEEP_SESSION
    await fs.rm(workspaceDir, { recursive: true, force: true })
  })

  it('删除指定 thread 对应的 session 目录', async () => {
    const threadTs = '1700000000.000100'
    const sessionDir = path.join(slackSessionsDir, `general.C123.${threadTs}`)
    await fs.mkdir(sessionDir, { recursive: true })
    await fs.writeFile(path.join(sessionDir, 'messages.jsonl'), '{}\n', 'utf8')

    await cleanupSlackSessionForThread(threadTs, { workspaceDir })

    await expect(fs.stat(sessionDir)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('threadTs 为 undefined 时直接返回（不抛错）', async () => {
    await expect(
      cleanupSlackSessionForThread(undefined, { workspaceDir }),
    ).resolves.toBeUndefined()
  })

  it('找不到 session 目录时不抛错', async () => {
    await expect(
      cleanupSlackSessionForThread('1700000000.999999', { workspaceDir }),
    ).resolves.toBeUndefined()
  })

  it('SLACK_E2E_KEEP_SESSION=1 时跳过清理', async () => {
    const threadTs = '1700000000.000200'
    const sessionDir = path.join(slackSessionsDir, `general.C123.${threadTs}`)
    await fs.mkdir(sessionDir, { recursive: true })

    process.env.SLACK_E2E_KEEP_SESSION = '1'
    await cleanupSlackSessionForThread(threadTs, { workspaceDir })

    await expect(fs.stat(sessionDir)).resolves.toBeDefined()
  })

  it('SLACK_E2E_KEEP_SESSION=true / yes / on 都跳过', async () => {
    const setup = async (suffix: string) => {
      const threadTs = `1700000000.0003${suffix}`
      const sessionDir = path.join(slackSessionsDir, `general.C123.${threadTs}`)
      await fs.mkdir(sessionDir, { recursive: true })
      return { threadTs, sessionDir }
    }

    for (const value of ['true', 'yes', 'on', 'TRUE']) {
      const { threadTs, sessionDir } = await setup(value.length.toString())
      process.env.SLACK_E2E_KEEP_SESSION = value
      await cleanupSlackSessionForThread(threadTs, { workspaceDir })
      await expect(fs.stat(sessionDir)).resolves.toBeDefined()
    }
  })

  it('SLACK_E2E_KEEP_SESSION=0 / 空 / 其他值时仍然清理', async () => {
    const setup = async (label: string) => {
      const threadTs = `1700000000.000${label}`
      const sessionDir = path.join(slackSessionsDir, `general.C123.${threadTs}`)
      await fs.mkdir(sessionDir, { recursive: true })
      return { threadTs, sessionDir }
    }

    for (const value of ['0', '', 'false', 'no']) {
      const { threadTs, sessionDir } = await setup(`4${value || 'x'}`)
      if (value === '') {
        delete process.env.SLACK_E2E_KEEP_SESSION
      } else {
        process.env.SLACK_E2E_KEEP_SESSION = value
      }
      await cleanupSlackSessionForThread(threadTs, { workspaceDir })
      await expect(fs.stat(sessionDir)).rejects.toMatchObject({ code: 'ENOENT' })
    }
  })
})
