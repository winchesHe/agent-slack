// daemon.json / pid / lock 读写与 stale 检测
// 所有文件均位于 paths.daemonDir 下，属于运行态，不入 git
import { existsSync } from 'node:fs'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { WorkspacePaths } from '@/workspace/paths.ts'

export interface DaemonMeta {
  pid: number
  port: number
  host: string
  url: string
  dashboardUrl: string
  startedAt: string
  version: string
  cwd: string
  mode: 'embedded' | 'headless'
}

export async function ensureDaemonDir(paths: WorkspacePaths): Promise<void> {
  await mkdir(paths.daemonDir, { recursive: true })
}

export async function readDaemonMeta(paths: WorkspacePaths): Promise<DaemonMeta | null> {
  if (!existsSync(paths.daemonFile)) return null
  try {
    const raw = await readFile(paths.daemonFile, 'utf8')
    return JSON.parse(raw) as DaemonMeta
  } catch {
    return null
  }
}

export async function writeDaemonMeta(paths: WorkspacePaths, meta: DaemonMeta): Promise<void> {
  await ensureDaemonDir(paths)
  await writeFile(paths.daemonFile, JSON.stringify(meta, null, 2), 'utf8')
  await writeFile(paths.daemonPidFile, String(meta.pid), 'utf8')
}

export async function clearDaemonMeta(paths: WorkspacePaths): Promise<void> {
  for (const f of [paths.daemonFile, paths.daemonPidFile, paths.daemonLockFile]) {
    if (existsSync(f)) await rm(f, { force: true })
  }
}

// dashboard.json 读写与清理
export interface DashboardMeta {
  pid: number
  port: number
  host: string
  url: string
  startedAt: string
  cwd: string
}

export async function readDashboardMeta(paths: WorkspacePaths): Promise<DashboardMeta | null> {
  if (!existsSync(paths.dashboardFile)) return null
  try {
    const raw = await readFile(paths.dashboardFile, 'utf8')
    return JSON.parse(raw) as DashboardMeta
  } catch {
    return null
  }
}

export async function writeDashboardMeta(
  paths: WorkspacePaths,
  meta: DashboardMeta,
): Promise<void> {
  await ensureDaemonDir(paths)
  await writeFile(paths.dashboardFile, JSON.stringify(meta, null, 2), 'utf8')
}

export async function clearDashboardMeta(paths: WorkspacePaths): Promise<void> {
  if (existsSync(paths.dashboardFile)) await rm(paths.dashboardFile, { force: true })
}

// 判断 pid 对应进程是否还活着（kill 0 不发信号只检查）
export function isProcessAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    // ESRCH: 不存在；EPERM: 存在但无权限，也算活着
    const code = (err as NodeJS.ErrnoException).code
    return code === 'EPERM'
  }
}

export type DaemonStatus =
  | { state: 'running'; meta: DaemonMeta }
  | { state: 'stale'; meta: DaemonMeta } // meta 文件在，但进程已死
  | { state: 'offline' } // 无 meta 文件

export async function readDaemonStatus(paths: WorkspacePaths): Promise<DaemonStatus> {
  const meta = await readDaemonMeta(paths)
  if (!meta) return { state: 'offline' }
  if (!isProcessAlive(meta.pid)) return { state: 'stale', meta }
  return { state: 'running', meta }
}

// 获取 daemon log 文件路径（按当天）
export function daemonDailyLogFile(paths: WorkspacePaths, date = new Date()): string {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return path.join(paths.logsDir, `daemon-${y}-${m}-${d}.log`)
}
