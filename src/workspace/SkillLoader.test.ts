import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { writeFileSync, mkdirSync, rmSync } from 'node:fs'
import path from 'node:path'
import { loadSkills } from './SkillLoader.ts'
import type { Logger } from '@/logger/logger.ts'

let skillsDir: string

// 测试用 logger stub
const stubLogger: Logger = {
  withTag: () => stubLogger,
  trace: () => {},
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
}

beforeEach(() => {
  // 使用 repo-local 临时目录而非 /tmp，避免权限问题并保持测试可见性
  const timestamp = Date.now()
  const random = Math.random().toString(36).slice(2, 8)
  const testTmpBase = path.join(process.cwd(), 'memory/.test-tmp')
  skillsDir = path.join(testTmpBase, `skills-${timestamp}-${random}`)
  mkdirSync(skillsDir, { recursive: true })
})

afterEach(() => {
  if (skillsDir) {
    rmSync(skillsDir, { recursive: true, force: true })
  }
})

describe('loadSkills', () => {
  it('加载并按字母序排序', async () => {
    mkdirSync(path.join(skillsDir, 'z-skill'))
    writeFileSync(
      path.join(skillsDir, 'z-skill/SKILL.md'),
      '---\nname: z-skill\ndescription: Z skill\n---\nZ content',
    )

    mkdirSync(path.join(skillsDir, 'a-skill'))
    writeFileSync(
      path.join(skillsDir, 'a-skill/SKILL.md'),
      '---\nname: a-skill\ndescription: A skill\n---\nA content',
    )

    const skills = await loadSkills(skillsDir, ['*'], stubLogger)
    expect(skills).toHaveLength(2)
    expect(skills[0]!.name).toBe('a-skill')
    expect(skills[1]!.name).toBe('z-skill')
    expect(skills[0]!.content).toBe('A content')
  })

  it('enabled 白名单过滤', async () => {
    mkdirSync(path.join(skillsDir, 'tone'))
    writeFileSync(
      path.join(skillsDir, 'tone/SKILL.md'),
      '---\nname: tone\ndescription: tone skill\n---\nTone content',
    )

    mkdirSync(path.join(skillsDir, 'code'))
    writeFileSync(
      path.join(skillsDir, 'code/SKILL.md'),
      '---\nname: code\ndescription: code skill\n---\nCode content',
    )

    const skills = await loadSkills(skillsDir, ['tone'], stubLogger)
    expect(skills).toHaveLength(1)
    expect(skills[0]!.name).toBe('tone')
  })

  it('坏 frontmatter 跳过不抛', async () => {
    mkdirSync(path.join(skillsDir, 'bad'))
    writeFileSync(path.join(skillsDir, 'bad/SKILL.md'), '---\ninvalid yaml: [[[[\n---\nContent')

    mkdirSync(path.join(skillsDir, 'good'))
    writeFileSync(
      path.join(skillsDir, 'good/SKILL.md'),
      '---\nname: good\ndescription: Good skill\n---\nGood content',
    )

    const skills = await loadSkills(skillsDir, ['*'], stubLogger)
    expect(skills).toHaveLength(1)
    expect(skills[0]!.name).toBe('good')
  })

  it('缺少必需字段跳过', async () => {
    mkdirSync(path.join(skillsDir, 'missing-name'))
    writeFileSync(
      path.join(skillsDir, 'missing-name/SKILL.md'),
      '---\ndescription: Missing name\n---\nContent',
    )

    mkdirSync(path.join(skillsDir, 'valid'))
    writeFileSync(
      path.join(skillsDir, 'valid/SKILL.md'),
      '---\nname: valid\ndescription: Valid skill\n---\nValid content',
    )

    const skills = await loadSkills(skillsDir, ['*'], stubLogger)
    expect(skills).toHaveLength(1)
    expect(skills[0]!.name).toBe('valid')
  })

  it('skillsDir 不存在返回空', async () => {
    const nonExistent = path.join(process.cwd(), 'non-existent-skills-dir-test')
    const skills = await loadSkills(nonExistent, ['*'], stubLogger)
    expect(skills).toEqual([])
  })

  it('包含 whenToUse 字段', async () => {
    mkdirSync(path.join(skillsDir, 'with-when'))
    writeFileSync(
      path.join(skillsDir, 'with-when/SKILL.md'),
      '---\nname: with-when\ndescription: Skill with whenToUse\nwhenToUse: When you need X\n---\nContent',
    )

    const skills = await loadSkills(skillsDir, ['*'], stubLogger)
    expect(skills).toHaveLength(1)
    expect(skills[0]!.whenToUse).toBe('When you need X')
  })

  it('无 SKILL.md 的目录被跳过', async () => {
    mkdirSync(path.join(skillsDir, 'empty-dir'))
    // 不创建 SKILL.md

    mkdirSync(path.join(skillsDir, 'valid'))
    writeFileSync(
      path.join(skillsDir, 'valid/SKILL.md'),
      '---\nname: valid\ndescription: Valid skill\n---\nValid content',
    )

    const skills = await loadSkills(skillsDir, ['*'], stubLogger)
    expect(skills).toHaveLength(1)
    expect(skills[0]!.name).toBe('valid')
  })
})
