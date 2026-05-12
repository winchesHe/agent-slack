import path from 'node:path'
import os from 'node:os'

export interface WorkspacePaths {
  cwd: string
  root: string
  configFile: string
  channelTasksFile: string
  scheduledTasksFile: string
  scheduledTasksLogFile: string
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
  wechatDir: string
  wechatCredentialsFile: string
  wechatContextTokensFile: string
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
    scheduledTasksFile: path.join(root, 'scheduled-tasks.yaml'),
    scheduledTasksLogFile: path.join(root, 'logs', 'scheduled-tasks.jsonl'),
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
    wechatDir: path.join(root, 'wechat'),
    wechatCredentialsFile: path.join(root, 'wechat', 'credentials.json'),
    wechatContextTokensFile: path.join(root, 'wechat', 'context-tokens.json'),
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

/**
 * 微信单聊会话目录。微信单聊语义下 channelId/threadTs 都等同 from_user_id，
 * 这里取 userName / userId 即可（CowAgent 同设计）。
 */
export function wechatSessionDir(
  paths: WorkspacePaths,
  userName: string,
  userId: string,
): string {
  const safe = sanitizeFsSegment(userName)
  return path.join(paths.sessionsDir, 'wechat', `${safe}.${userId}`)
}

/**
 * Telegram per-chat 会话目录。outbound-only 场景下 channelId/threadTs/channelName 都等同 chatId。
 */
export function telegramSessionDir(paths: WorkspacePaths, chatId: string): string {
  const safe = sanitizeFsSegment(chatId)
  return path.join(paths.sessionsDir, 'telegram', safe)
}
