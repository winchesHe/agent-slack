// 守护测试：根目录 *.example.* 必须与 generator(EXAMPLE_PARAMS) 输出字节一致。
//
// 失败时按 AGENTS.md "Env / Config 变更联动规则" 处理：
// - 改了字段但忘记跑 pnpm gen:examples → 跑一次脚本，commit 一起带上
// - 改了 generator 但 example 还停留在旧版 → 同上
// - 历史上漂移过 → 一次性对齐，作为本次 PR 的纯文档/模板修正

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  generateChannelTasksYaml,
  generateConfigYaml,
  generateEnvExample,
  generateSystemMd,
} from './index.ts'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')

function readExample(name: string): string {
  return readFileSync(path.join(repoRoot, name), 'utf8')
}

describe('templates generator → 根目录 *.example.* 字节一致守护测试', () => {
  it('config.example.yaml == generateConfigYaml({ mode: example })', () => {
    expect(generateConfigYaml({ mode: 'example' })).toBe(readExample('config.example.yaml'))
  })

  it('channel-tasks.example.yaml == generateChannelTasksYaml({ mode: example })', () => {
    expect(generateChannelTasksYaml({ mode: 'example' })).toBe(
      readExample('channel-tasks.example.yaml'),
    )
  })

  it('system.example.md == generateSystemMd({ mode: example })', () => {
    expect(generateSystemMd({ mode: 'example' })).toBe(readExample('system.example.md'))
  })

  it('.env.example == generateEnvExample()', () => {
    expect(generateEnvExample()).toBe(readExample('.env.example'))
  })
})
