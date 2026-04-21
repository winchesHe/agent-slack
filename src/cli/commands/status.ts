// status 命令：打印 workspace 配置、skills、最近 session 摘要
import { consola } from 'consola'
import { existsSync } from 'node:fs'
import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { loadWorkspaceContext } from '@/workspace/WorkspaceContext.ts'
import { createLogger } from '@/logger/logger.ts'
import { createRedactor } from '@/logger/redactor.ts'
import type { SessionMeta } from '@/store/SessionStore.ts'

export async function statusCommand(opts: { cwd: string }): Promise<void> {
  const logger = createLogger({ level: 'warn', redactor: createRedactor([]) })
  const ctx = await loadWorkspaceContext(opts.cwd, logger)

  const skillLine =
    ctx.skills.length > 0
      ? `${ctx.skills.length} — ${ctx.skills.map((s) => s.name).join(', ')}`
      : '0'

  consola.box(
    [
      `Workspace: ${opts.cwd}`,
      `Agent:     ${ctx.config.agent.name} / ${ctx.config.agent.model}`,
      `Skills:    ${skillLine}`,
    ].join('\n'),
  )

  const slackDir = path.join(ctx.paths.sessionsDir, 'slack')
  if (!existsSync(slackDir)) {
    consola.info('暂无 Slack session')
    return
  }

  const dirs = await readdir(slackDir)
  const metas: Array<SessionMeta & { dir: string }> = []
  for (const d of dirs) {
    const metaFile = path.join(slackDir, d, 'meta.json')
    if (!existsSync(metaFile)) continue
    try {
      const m = JSON.parse(await readFile(metaFile, 'utf8')) as SessionMeta
      metas.push({ ...m, dir: d })
    } catch {
      // 损坏的 meta.json 跳过，不阻塞 status 输出
    }
  }
  metas.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))

  const top = metas.slice(0, 5)
  if (top.length === 0) {
    consola.info('暂无 Slack session')
    return
  }
  consola.log('\n最近 session:')
  for (const m of top) {
    consola.log(
      `  #${m.channelName} (${m.channelId}) · ${m.updatedAt} · ${m.usage.stepCount} steps · $${m.usage.totalCostUSD.toFixed(4)}`,
    )
  }
}
