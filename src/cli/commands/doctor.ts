// doctor 命令：环境自检（Node 版本 / 目录结构 / 凭证 / 模型 / skills）
import { consola } from 'consola'
import 'dotenv/config'
import { existsSync } from 'node:fs'
import { resolveWorkspacePaths } from '@/workspace/paths.ts'
import { loadWorkspaceContext } from '@/workspace/WorkspaceContext.ts'
import { createLogger } from '@/logger/logger.ts'
import { createRedactor } from '@/logger/redactor.ts'
import { validateLiteLLM, validateSlack } from '../validators.ts'

export async function doctorCommand(opts: { cwd: string }): Promise<void> {
  let failures = 0
  const check = (label: string, ok: boolean, hint?: string): void => {
    const fn = ok ? consola.success : consola.error
    fn(`${label}: ${ok ? 'OK' : 'FAIL'}${hint ? ` — ${hint}` : ''}`)
    if (!ok) failures++
  }

  // 1. Node 版本
  const nodeMajor = Number(process.versions.node.split('.')[0])
  check('Node >= 22', nodeMajor >= 22, `当前 ${process.versions.node}`)

  // 2. 目录结构
  const paths = resolveWorkspacePaths(opts.cwd)
  check('.agent-slack 存在', existsSync(paths.root), paths.root)
  check('config.yaml 存在', existsSync(paths.configFile))
  check('system.md 存在', existsSync(paths.systemFile))

  // 3. 凭证（从 workspace 下 .env.local / 环境变量取）
  const slackToken = process.env.SLACK_BOT_TOKEN
  const litellmUrl = process.env.LITELLM_BASE_URL
  const litellmKey = process.env.LITELLM_API_KEY
  check('SLACK_BOT_TOKEN 非空', Boolean(slackToken))
  check('LITELLM_BASE_URL 非空', Boolean(litellmUrl))
  check('LITELLM_API_KEY 非空', Boolean(litellmKey))

  if (slackToken) {
    const r = await validateSlack({ botToken: slackToken })
    check('Slack auth.test', r.ok, r.ok ? undefined : r.reason)
  }

  // 4. LiteLLM 连通性 + 模型可达（/models 同时承担两件事）
  if (litellmUrl && litellmKey && existsSync(paths.configFile)) {
    try {
      const logger = createLogger({
        level: 'warn',
        redactor: createRedactor([litellmKey]),
      })
      const ctx = await loadWorkspaceContext(opts.cwd, logger)
      const res = await fetch(`${litellmUrl.replace(/\/$/, '')}/models`, {
        headers: { Authorization: `Bearer ${litellmKey}` },
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = (await res.json()) as { data?: Array<{ id?: string }> }
      const available = (data.data ?? []).map((m) => m.id).filter((id): id is string => Boolean(id))
      const modelName = ctx.config.agent.model
      const sample = available.slice(0, 5).join(', ') + (available.length > 5 ? '…' : '')
      check(`模型 ${modelName} 可用`, available.includes(modelName), `可用: ${sample}`)
    } catch (err) {
      check('LiteLLM /models', false, err instanceof Error ? err.message : String(err))
    }
  }

  // 5. Skills 加载
  if (existsSync(paths.configFile)) {
    try {
      const logger = createLogger({ level: 'warn', redactor: createRedactor([]) })
      const ctx = await loadWorkspaceContext(opts.cwd, logger)
      check(`skills 加载 (${ctx.skills.length} 个)`, true)
    } catch (err) {
      check('skills 加载', false, err instanceof Error ? err.message : String(err))
    }
  }

  if (failures > 0) {
    consola.error(`doctor 发现 ${failures} 个问题`)
    process.exit(1)
  }
  consola.success('全部检查通过')
}
