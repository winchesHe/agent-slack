import { readdir, readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import matter from 'gray-matter'
import type { Logger } from '@/logger/logger.ts'
import type { Skill } from './WorkspaceContext.ts'

export async function loadSkills(
  skillsDir: string,
  enabled: string[],
  logger: Logger,
): Promise<Skill[]> {
  const log = logger.withTag('SkillLoader')

  if (!existsSync(skillsDir)) {
    log.debug(`skillsDir 不存在: ${skillsDir}`)
    return []
  }

  const entries = await readdir(skillsDir, { withFileTypes: true })
  const skillDirs = entries.filter((e) => e.isDirectory()).map((e) => e.name)

  const skills: Skill[] = []

  for (const dirName of skillDirs) {
    const skillFilePath = join(skillsDir, dirName, 'SKILL.md')
    if (!existsSync(skillFilePath)) {
      continue
    }

    try {
      const raw = await readFile(skillFilePath, 'utf8')
      const parsed = matter(raw)

      const name = extractString(parsed.data, 'name')
      const description = extractString(parsed.data, 'description')

      if (!name || !description) {
        log.warn(`SKILL.md 缺少必需字段 (name/description): ${skillFilePath}`)
        continue
      }

      const whenToUse = extractString(parsed.data, 'whenToUse')

      // 只在 whenToUse 有值时才写入该字段，避免 optional property 类型风险
      const skill: Skill = {
        name,
        description,
        content: parsed.content.trim(),
        source: resolve(skillFilePath),
      }
      if (whenToUse !== undefined) {
        skill.whenToUse = whenToUse
      }

      skills.push(skill)
    } catch (err) {
      log.warn(`解析 SKILL.md 失败: ${skillFilePath}`, err)
    }
  }

  const filtered = applyEnabledFilter(skills, enabled)
  filtered.sort((a, b) => a.name.localeCompare(b.name))

  log.info(`已加载 ${filtered.length} 个 skills`, { count: filtered.length })
  return filtered
}

function extractString(data: unknown, key: string): string | undefined {
  if (typeof data !== 'object' || data === null) return undefined
  const val = (data as Record<string, unknown>)[key]
  return typeof val === 'string' ? val : undefined
}

function applyEnabledFilter(skills: Skill[], enabled: string[]): Skill[] {
  if (enabled.includes('*')) {
    return skills
  }
  return skills.filter((s) => enabled.includes(s.name))
}
