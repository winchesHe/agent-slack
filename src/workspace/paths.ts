import path from 'node:path'
import os from 'node:os'

export interface WorkspacePaths {
  cwd: string
  root: string
  configFile: string
  systemFile: string
  sessionsDir: string
  memoryDir: string
  skillsDir: string
  logsDir: string
  globalRoot: string
  globalEnv: string
  globalConfig: string
}

export function resolveWorkspacePaths(cwd: string): WorkspacePaths {
  const root = path.join(cwd, '.agent-slack')
  const globalRoot = path.join(os.homedir(), '.agent-slack')
  return {
    cwd,
    root,
    configFile: path.join(root, 'config.yaml'),
    systemFile: path.join(root, 'system.md'),
    sessionsDir: path.join(root, 'sessions'),
    memoryDir: path.join(root, 'memory'),
    skillsDir: path.join(root, 'skills'),
    logsDir: path.join(root, 'logs'),
    globalRoot,
    globalEnv: path.join(globalRoot, '.env'),
    globalConfig: path.join(globalRoot, 'global.yaml'),
  }
}

export function slackSessionDir(
  paths: WorkspacePaths,
  channelName: string,
  channelId: string,
  threadTs: string,
): string {
  const safe = channelName.replace(/[^\w.-]/g, '_')
  return path.join(paths.sessionsDir, 'slack', `${safe}.${channelId}.${threadTs}`)
}
