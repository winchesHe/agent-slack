// Dashboard API：从 workspace 文件系统读取 context / sessions / skills / memory / logs / config / usage / 运行态
// 所有方法只做只读聚合，不修改任何文件；失败用空对象或空数组兜底，避免一个分区异常拖垮整个 dashboard。

import { readdir, readFile, stat, writeFile, unlink, mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import YAML from 'yaml'
import { resolveWorkspacePaths, type WorkspacePaths } from '@/workspace/paths.ts'
import { parseConfig, DEFAULT_CONFIG, type WorkspaceConfig } from '@/workspace/config.ts'
import { loadSkills } from '@/workspace/SkillLoader.ts'
import type { Skill } from '@/workspace/WorkspaceContext.ts'
import type { Logger } from '@/logger/logger.ts'
import type { SessionMeta } from '@/store/SessionStore.ts'
import { validateSlack } from '@/cli/validators.ts'

export interface DashboardEnvStatus {
  hasSlackBotToken: boolean
  hasSlackSigningSecret: boolean
  hasSlackAppToken: boolean
  hasLitellmBaseUrl: boolean
  hasLitellmApiKey: boolean
  hasAnthropicApiKey: boolean
  logLevel: string | undefined
}

export interface DashboardOverview {
  cwd: string
  paths: WorkspacePaths
  config: WorkspaceConfig
  configFileExists: boolean
  systemFileExists: boolean
  skillCount: number
  sessionCount: number
  runningSessionCount: number
  usage: {
    inputTokens: number
    outputTokens: number
    cachedInputTokens: number
    totalCostUSD: number
    stepCount: number
  }
  recentErrorCount: number
  env: DashboardEnvStatus
  generatedAt: string
  recentSessions: SessionListItem[]
  healthSummary: {
    nodeOk: boolean
    nodeVersion: string
    configExists: boolean
    systemExists: boolean
    slackEnvOk: boolean
    litellmEnvOk: boolean
  }
  recentEvents: Array<{
    ts: string
    kind: 'session' | 'error'
    text: string
    sessionId?: string
  }>
  memorySummary: {
    count: number
    totalSize: number
    latestFile: string | null
    latestMtime: string | null
  }
}

export interface SessionListItem extends SessionMeta {
  // 目录名做 id，避免与 SessionStore 的内部 id 耦合
  id: string
  dir: string
  messageCount: number
}

export interface SkillListItem {
  name: string
  description: string
  whenToUse?: string
  source: string
}

export interface MemoryListItem {
  file: string
  size: number
  mtime: string
}

export interface LogFileItem {
  file: string
  size: number
  mtime: string
}

export interface HealthResult {
  nodeVersion: string
  nodeOk: boolean
  rootExists: boolean
  configExists: boolean
  systemExists: boolean
  env: DashboardEnvStatus
  slackAuth?: { ok: boolean; reason?: string }
  litellm?: { ok: boolean; modelAvailable?: boolean; sample?: string[]; reason?: string }
}

export function createDashboardApi(cwd: string, logger: Logger) {
  const paths = resolveWorkspacePaths(cwd)
  const log = logger.withTag('dashboard')

  const readConfig = async (): Promise<WorkspaceConfig> => {
    if (!existsSync(paths.configFile)) return DEFAULT_CONFIG
    try {
      return parseConfig(YAML.parse(await readFile(paths.configFile, 'utf8')))
    } catch (err) {
      log.warn('解析 config.yaml 失败，回退默认配置', err)
      return DEFAULT_CONFIG
    }
  }

  const envStatus = (): DashboardEnvStatus => ({
    hasSlackBotToken: Boolean(process.env.SLACK_BOT_TOKEN),
    hasSlackSigningSecret: Boolean(process.env.SLACK_SIGNING_SECRET),
    hasSlackAppToken: Boolean(process.env.SLACK_APP_TOKEN),
    hasLitellmBaseUrl: Boolean(process.env.LITELLM_BASE_URL),
    hasLitellmApiKey: Boolean(process.env.LITELLM_API_KEY),
    hasAnthropicApiKey: Boolean(process.env.ANTHROPIC_API_KEY),
    logLevel: process.env.LOG_LEVEL,
  })

  const listSessions = async (): Promise<SessionListItem[]> => {
    const slackDir = path.join(paths.sessionsDir, 'slack')
    if (!existsSync(slackDir)) return []
    const dirs = await readdir(slackDir)
    const items: SessionListItem[] = []
    for (const d of dirs) {
      const sessionDir = path.join(slackDir, d)
      const metaFile = path.join(sessionDir, 'meta.json')
      const messagesFile = path.join(sessionDir, 'messages.jsonl')
      if (!existsSync(metaFile)) continue
      try {
        const meta = JSON.parse(await readFile(metaFile, 'utf8')) as SessionMeta
        let messageCount = 0
        if (existsSync(messagesFile)) {
          const raw = await readFile(messagesFile, 'utf8')
          messageCount = raw.split('\n').filter((l) => l.length > 0).length
        }
        items.push({ ...meta, id: d, dir: sessionDir, messageCount })
      } catch {
        // 损坏 meta 静默跳过
      }
    }
    items.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    return items
  }

  const listSkillsInternal = async (): Promise<Skill[]> => {
    const cfg = await readConfig()
    return loadSkills(paths.skillsDir, cfg.skills.enabled, logger)
  }

  const listMemory = async (): Promise<MemoryListItem[]> => {
    if (!existsSync(paths.memoryDir)) return []
    const files = await readdir(paths.memoryDir)
    const items: MemoryListItem[] = []
    for (const f of files) {
      if (!f.endsWith('.md')) continue
      const full = path.join(paths.memoryDir, f)
      const s = await stat(full)
      items.push({ file: f, size: s.size, mtime: s.mtime.toISOString() })
    }
    items.sort((a, b) => b.mtime.localeCompare(a.mtime))
    return items
  }

  const listLogs = async (): Promise<LogFileItem[]> => {
    if (!existsSync(paths.logsDir)) return []
    const files = await readdir(paths.logsDir)
    const items: LogFileItem[] = []
    for (const f of files) {
      const full = path.join(paths.logsDir, f)
      try {
        const s = await stat(full)
        if (!s.isFile()) continue
        items.push({ file: f, size: s.size, mtime: s.mtime.toISOString() })
      } catch {
        // 跳过无法 stat 的条目
      }
    }
    items.sort((a, b) => b.mtime.localeCompare(a.mtime))
    return items
  }

  const countRecentErrors = async (): Promise<number> => {
    const files = await listLogs()
    let count = 0
    for (const f of files.slice(0, 3)) {
      try {
        const raw = await readFile(path.join(paths.logsDir, f.file), 'utf8')
        count += raw
          .split('\n')
          .filter((l) => /\b(error|ERROR|"level":\s*"error")\b/.test(l)).length
      } catch {
        // 忽略
      }
    }
    return count
  }

  return {
    paths,

    async overview(): Promise<DashboardOverview> {
      const config = await readConfig()
      const sessions = await listSessions()
      const skills = await listSkillsInternal().catch(() => [])
      const recentErrorCount = await countRecentErrors().catch(() => 0)
      const memoryList = await listMemory().catch(() => [])

      const usage = sessions.reduce(
        (acc, s) => ({
          inputTokens: acc.inputTokens + s.usage.inputTokens,
          outputTokens: acc.outputTokens + s.usage.outputTokens,
          cachedInputTokens: acc.cachedInputTokens + s.usage.cachedInputTokens,
          totalCostUSD: acc.totalCostUSD + s.usage.totalCostUSD,
          stepCount: acc.stepCount + s.usage.stepCount,
        }),
        { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, totalCostUSD: 0, stepCount: 0 },
      )

      // 最近活跃 session Top 5（listSessions 已按 updatedAt 倒序）
      const recentSessions = sessions.slice(0, 5)

      // Health 摘要（只看本地可判定的维度，避免同步发 Slack / LiteLLM 请求拖慢 overview）
      const nodeMajor = Number(process.versions.node.split('.')[0])
      const env = envStatus()
      const healthSummary = {
        nodeOk: nodeMajor >= 22,
        nodeVersion: process.versions.node,
        configExists: existsSync(paths.configFile),
        systemExists: existsSync(paths.systemFile),
        slackEnvOk: env.hasSlackBotToken && env.hasSlackSigningSecret && env.hasSlackAppToken,
        litellmEnvOk: env.hasLitellmBaseUrl && env.hasLitellmApiKey,
      }

      // 最近事件 Timeline：session 更新 + 最近日志里的 error 行，合并最多 10 条
      const events: DashboardOverview['recentEvents'] = []
      for (const s of sessions.slice(0, 10)) {
        events.push({
          ts: s.updatedAt,
          kind: 'session',
          text: `${s.status} · #${s.channelName} · ${s.threadTs} (${s.messageCount} msgs)`,
          sessionId: s.id,
        })
      }
      try {
        const logFiles = await listLogs()
        for (const f of logFiles.slice(0, 2)) {
          const raw = await readFile(path.join(paths.logsDir, f.file), 'utf8').catch(() => '')
          const lines = raw.split('\n').filter((l) => /\b(error|ERROR)\b/.test(l))
          for (const line of lines.slice(-5)) {
            // 尝试从 "[ISO] [level] ..." 行首解析 ts
            const m = line.match(/^\[([^\]]+)\]/)
            const ts = m ? (m[1] ?? f.mtime) : f.mtime
            events.push({ ts, kind: 'error', text: line.slice(0, 200) })
          }
        }
      } catch {
        // 日志目录异常忽略
      }
      events.sort((a, b) => b.ts.localeCompare(a.ts))
      const recentEvents = events.slice(0, 10)

      const memorySummary = {
        count: memoryList.length,
        totalSize: memoryList.reduce((n, m) => n + m.size, 0),
        latestFile: memoryList[0]?.file ?? null,
        latestMtime: memoryList[0]?.mtime ?? null,
      }

      return {
        cwd,
        paths,
        config,
        configFileExists: existsSync(paths.configFile),
        systemFileExists: existsSync(paths.systemFile),
        skillCount: skills.length,
        sessionCount: sessions.length,
        runningSessionCount: sessions.filter((s) => s.status === 'running').length,
        usage,
        recentErrorCount,
        env,
        generatedAt: new Date().toISOString(),
        recentSessions,
        healthSummary,
        recentEvents,
        memorySummary,
      }
    },

    async config(): Promise<{ parsed: WorkspaceConfig; raw: string | null; exists: boolean }> {
      const exists = existsSync(paths.configFile)
      const raw = exists ? await readFile(paths.configFile, 'utf8') : null
      return { parsed: await readConfig(), raw, exists }
    },

    async systemPrompt(): Promise<{ exists: boolean; content: string }> {
      if (!existsSync(paths.systemFile)) return { exists: false, content: '' }
      return { exists: true, content: await readFile(paths.systemFile, 'utf8') }
    },

    async skills(): Promise<SkillListItem[]> {
      const skills = await listSkillsInternal()
      return skills.map((s) => {
        const item: SkillListItem = {
          name: s.name,
          description: s.description,
          source: s.source,
        }
        if (s.whenToUse !== undefined) item.whenToUse = s.whenToUse
        return item
      })
    },

    async skillDetail(name: string): Promise<Skill | null> {
      const skills = await listSkillsInternal()
      return skills.find((s) => s.name === name) ?? null
    },

    async sessions(): Promise<SessionListItem[]> {
      return listSessions()
    },

    async sessionMessages(
      id: string,
      offset: number,
      limit: number,
    ): Promise<{ total: number; offset: number; limit: number; messages: unknown[] } | null> {
      const dir = path.join(paths.sessionsDir, 'slack', id)
      const messagesFile = path.join(dir, 'messages.jsonl')
      if (!existsSync(messagesFile)) return null
      const raw = await readFile(messagesFile, 'utf8')
      const all = raw.split('\n').filter((l) => l.length > 0)
      const slice = all.slice(offset, offset + limit).map((l) => {
        try {
          return JSON.parse(l) as unknown
        } catch {
          return { _parseError: true, raw: l }
        }
      })
      return { total: all.length, offset, limit, messages: slice }
    },

    async memory(): Promise<MemoryListItem[]> {
      return listMemory()
    },

    async memoryDetail(file: string): Promise<{ file: string; content: string } | null> {
      // 防路径穿越：只允许直接位于 memoryDir 下的 .md 文件
      if (file.includes('/') || file.includes('\\') || !file.endsWith('.md')) return null
      const full = path.join(paths.memoryDir, file)
      if (!existsSync(full)) return null
      return { file, content: await readFile(full, 'utf8') }
    },

    async logs(): Promise<LogFileItem[]> {
      return listLogs()
    },

    async logTail(file: string, tail: number): Promise<{ file: string; lines: string[] } | null> {
      if (file.includes('/') || file.includes('\\')) return null
      const full = path.join(paths.logsDir, file)
      if (!existsSync(full)) return null
      const raw = await readFile(full, 'utf8')
      const lines = raw.split('\n')
      return { file, lines: lines.slice(-tail) }
    },

    async health(): Promise<HealthResult> {
      const nodeMajor = Number(process.versions.node.split('.')[0])
      const config = await readConfig()

      const result: HealthResult = {
        nodeVersion: process.versions.node,
        nodeOk: nodeMajor >= 22,
        rootExists: existsSync(paths.root),
        configExists: existsSync(paths.configFile),
        systemExists: existsSync(paths.systemFile),
        env: envStatus(),
      }

      const slackToken = process.env.SLACK_BOT_TOKEN
      if (slackToken) {
        try {
          result.slackAuth = await validateSlack({ botToken: slackToken })
        } catch (err) {
          result.slackAuth = { ok: false, reason: err instanceof Error ? err.message : String(err) }
        }
      }

      const litellmUrl = process.env.LITELLM_BASE_URL
      const litellmKey = process.env.LITELLM_API_KEY
      if (litellmUrl && litellmKey) {
        try {
          const res = await fetch(`${litellmUrl.replace(/\/$/, '')}/models`, {
            headers: { Authorization: `Bearer ${litellmKey}` },
          })
          if (!res.ok) throw new Error(`HTTP ${res.status}`)
          const data = (await res.json()) as { data?: Array<{ id?: string }> }
          const ids = (data.data ?? []).map((m) => m.id).filter((v): v is string => Boolean(v))
          result.litellm = {
            ok: true,
            modelAvailable: ids.includes(config.agent.model),
            sample: ids.slice(0, 10),
          }
        } catch (err) {
          result.litellm = { ok: false, reason: err instanceof Error ? err.message : String(err) }
        }
      }

      return result
    },

    // daemon 预留：后续由 daemon 写状态文件 / 暴露本地 socket 后，这里读其状态返回
    async daemon(): Promise<{ status: 'unknown'; note: string }> {
      return {
        status: 'unknown',
        note: 'daemon 模块尚未接入。后续由 daemon 写 .agent-slack/daemon/state.json 后在此聚合。',
      }
    },

    // --- 写操作：Config / System Prompt 的新增/编辑/删除 ---
    // Dashboard 默认绑定 127.0.0.1，写操作不做鉴权。

    async updateConfig(rawYaml: string): Promise<{ parsed: WorkspaceConfig; raw: string }> {
      // 先做解析 + schema 校验，通过后再落盘，避免写入无法被主程序解析的 config
      const parsed = parseConfig(YAML.parse(rawYaml))
      await mkdir(paths.root, { recursive: true })
      await writeFile(paths.configFile, rawYaml, 'utf8')
      return { parsed, raw: rawYaml }
    },

    async deleteConfig(): Promise<{ deleted: boolean }> {
      if (!existsSync(paths.configFile)) return { deleted: false }
      await unlink(paths.configFile)
      return { deleted: true }
    },

    async updateSystemPrompt(content: string): Promise<{ content: string }> {
      await mkdir(paths.root, { recursive: true })
      await writeFile(paths.systemFile, content, 'utf8')
      return { content }
    },

    async deleteSystemPrompt(): Promise<{ deleted: boolean }> {
      if (!existsSync(paths.systemFile)) return { deleted: false }
      await unlink(paths.systemFile)
      return { deleted: true }
    },
  }
}

export type DashboardApi = ReturnType<typeof createDashboardApi>
