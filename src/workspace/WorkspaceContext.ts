import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import YAML from 'yaml'
import { parseConfig, type WorkspaceConfig } from './config.ts'
import { resolveWorkspacePaths, type WorkspacePaths } from './paths.ts'
import { loadSkills } from './SkillLoader.ts'
import type { Logger } from '@/logger/logger.ts'

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

export async function loadWorkspaceContext(cwd: string, logger: Logger): Promise<WorkspaceContext> {
  const paths = resolveWorkspacePaths(cwd)
  const config = existsSync(paths.configFile)
    ? parseConfig(YAML.parse(await readFile(paths.configFile, 'utf8')))
    : parseConfig({})

  const baseSystemPrompt = existsSync(paths.systemFile)
    ? await readFile(paths.systemFile, 'utf8')
    : ''

  const skills = await loadSkills(paths.skillsDir, config.skills.enabled, logger)
  const systemPrompt = composeSystemPrompt(baseSystemPrompt, skills)

  return { cwd, paths, config, systemPrompt, skills }
}

function composeSystemPrompt(base: string, skills: Skill[]): string {
  if (skills.length === 0) {
    return base
  }

  const skillsSection = ['## Available Skills', '']
    .concat(
      skills.map((skill) => {
        const parts = [`### ${skill.name}`, `**Description:** ${skill.description}`]
        if (skill.whenToUse) {
          parts.push(`**When to use:** ${skill.whenToUse}`)
        }
        parts.push('', skill.content, '')
        return parts.join('\n')
      }),
    )
    .join('\n')

  return base ? `${base}\n\n${skillsSection}` : skillsSection
}
