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

  // 只将 skill 的元数据（名称、描述、触发条件、文件路径）注入 system prompt，
  // 引导 Agent 按需通过 bash cat 读取完整内容，避免全量加载占用上下文窗口。
  const skillsSection = [
    '## Available Skills',
    '',
    '以下是可用的 skills 索引。需要使用某个 skill 时，用 `bash cat <source>` 读取其完整内容后再执行。',
    '',
  ]
    .concat(
      skills.map((skill) => {
        const parts = [`### ${skill.name}`, `**Description:** ${skill.description}`]
        if (skill.whenToUse) {
          parts.push(`**When to use:** ${skill.whenToUse}`)
        }
        parts.push(`**Source:** ${skill.source}`)
        parts.push('')
        return parts.join('\n')
      }),
    )
    .join('\n')

  return base ? `${base}\n\n${skillsSection}` : skillsSection
}
