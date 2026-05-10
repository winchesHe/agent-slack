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

/**
 * Spec §4.2：旧 yaml 的 `im.provider: slack` → `im.enabled: [slack]` 迁移。
 * 仅做 in-memory 改写，不写回磁盘；下次用户主动编辑 yaml 时会自然落到新形态。
 *
 * 不放进 zod schema 兼容层（避免新代码长期挂着旧字段名），
 * 也不放进 planUpgradeYaml（那是纯追加式、不改写已有 key）。
 */
export function migrateLegacyImProvider(raw: unknown): unknown {
  if (typeof raw !== 'object' || raw === null) return raw
  const obj = raw as Record<string, unknown>
  const im = obj.im
  if (typeof im !== 'object' || im === null) return raw
  const imObj = im as Record<string, unknown>
  if (typeof imObj.provider === 'string' && !Array.isArray(imObj.enabled)) {
    imObj.enabled = [imObj.provider]
    delete imObj.provider
  }
  return raw
}

export async function loadWorkspaceContext(cwd: string, logger: Logger): Promise<WorkspaceContext> {
  const paths = resolveWorkspacePaths(cwd)
  const config = existsSync(paths.configFile)
    ? parseConfig(migrateLegacyImProvider(YAML.parse(await readFile(paths.configFile, 'utf8'))))
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
