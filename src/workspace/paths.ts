import path from 'node:path'
import os from 'node:os'

export interface WorkspacePaths {
  cwd: string
  root: string
  configFile: string
  channelTasksFile: string
  systemFile: string
  experienceFile: string
  channelTasksDir: string
  channelTaskTriggersFile: string
  sessionsDir: string
  memoryDir: string
  skillsDir: string
  logsDir: string
  daemonDir: string
  daemonFile: string
  daemonPidFile: string
  daemonLockFile: string
  dashboardFile: string
  globalRoot: string
  globalEnv: string
  globalConfig: string
}

export function resolveWorkspacePaths(cwd: string): WorkspacePaths {
  const root = path.join(cwd, '.agent-slack')
  const globalRoot = path.join(os.homedir(), '.agent-slack')
  const daemonDir = path.join(root, 'daemon')
  return {
    cwd,
    root,
    configFile: path.join(root, 'config.yaml'),
    channelTasksFile: path.join(root, 'channel-tasks.yaml'),
    systemFile: path.join(root, 'system.md'),
    experienceFile: path.join(root, 'experience.md'),
    channelTasksDir: path.join(root, 'channel-tasks'),
    channelTaskTriggersFile: path.join(root, 'channel-tasks', 'triggers.jsonl'),
    sessionsDir: path.join(root, 'sessions'),
    memoryDir: path.join(root, 'memory'),
    skillsDir: path.join(root, 'skills'),
    logsDir: path.join(root, 'logs'),
    daemonDir,
    daemonFile: path.join(daemonDir, 'daemon.json'),
    daemonPidFile: path.join(daemonDir, 'daemon.pid'),
    daemonLockFile: path.join(daemonDir, 'daemon.lock'),
    dashboardFile: path.join(daemonDir, 'dashboard.json'),
    globalRoot,
    globalEnv: path.join(globalRoot, '.env'),
    globalConfig: path.join(globalRoot, 'global.yaml'),
  }
}

/**
 * 将一个字段安全地用于文件名 / 目录名片段。
 * 仅替换 OS / 路径不合法字符与空白；中文 / 数字 / 其他可读字符保留。
 */
const FS_SEGMENT_SANITIZE_RE = /[\/\\:*?"<>|\s]/g
export function sanitizeFsSegment(input: string): string {
  return input.replace(FS_SEGMENT_SANITIZE_RE, '_')
}

export function slackSessionDir(
  paths: WorkspacePaths,
  channelName: string,
  channelId: string,
  threadTs: string,
): string {
  const safe = sanitizeFsSegment(channelName)
  return path.join(paths.sessionsDir, 'slack', `${safe}.${channelId}.${threadTs}`)
}
