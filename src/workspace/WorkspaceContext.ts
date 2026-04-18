import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import YAML from 'yaml'
import { parseConfig, type WorkspaceConfig } from './config.ts'
import { resolveWorkspacePaths, type WorkspacePaths } from './paths.ts'

export interface Skill {
  name: string
  description: string
  whenToUse?: string
  content: string
  source: string
}

export interface WorkspaceContext {
  cwd: string
  paths: WorkspacePaths
  config: WorkspaceConfig
  systemPrompt: string
  skills: Skill[]
}

export async function loadWorkspaceContext(cwd: string): Promise<WorkspaceContext> {
  const paths = resolveWorkspacePaths(cwd)
  const config = existsSync(paths.configFile)
    ? parseConfig(YAML.parse(await readFile(paths.configFile, 'utf8')))
    : parseConfig({})
  const systemPrompt = existsSync(paths.systemFile) ? await readFile(paths.systemFile, 'utf8') : ''
  return { cwd, paths, config, systemPrompt, skills: [] }
}
