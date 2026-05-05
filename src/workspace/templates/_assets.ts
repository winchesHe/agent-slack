// 模板资产加载器（**单一权威**）。
//
// 所有模板内容在仓库 examples/ 目录下，作为人类可读的纯文本文件维护。
// 本模块在导入时一次性把它们读到内存，generator 复用这些字符串，避免运行时重复 fs。
//
// 路径解析策略：
// - dev / vitest：import.meta.url 指向源码 .ts，向上找仓库根的 examples/。
// - bundle 后：import.meta.url 指向 bin/agent-slack.mjs，向上找包根的 examples/。
//   （examples/ 通过 package.json "files" 字段随 npm 包发布。）

import { readFileSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

function findExamplesDir(): URL {
  let dir = new URL('./', import.meta.url)
  for (let i = 0; i < 12; i++) {
    try {
      statSync(fileURLToPath(new URL('examples/.env.example', dir)))
      return new URL('examples/', dir)
    } catch {
      // 继续向上
    }
    const parent = new URL('../', dir)
    if (parent.href === dir.href) break
    dir = parent
  }
  throw new Error(
    'agent-slack: 找不到 examples/ 目录（应位于仓库根或安装包根）；请检查 package.json "files" 是否包含 "examples"。',
  )
}

const EXAMPLES_DIR = findExamplesDir()

function load(name: string): string {
  return readFileSync(fileURLToPath(new URL(name, EXAMPLES_DIR)), 'utf8')
}

export const ENV_EXAMPLE: string = load('.env.example')
export const CONFIG_EXAMPLE: string = load('config.example.yaml')
export const CHANNEL_TASKS_EXAMPLE: string = load('channel-tasks.example.yaml')
export const SYSTEM_EXAMPLE: string = load('system.example.md')
export const SYSTEM_WORKSPACE: string = load('system.workspace.md')

// 去掉 example 文件开头的引导注释（连续的 # 行 + 紧随其后的空行），
// 用于把 example 模板转成 workspace 写入版本。
export function stripExampleLeadingComments(text: string): string {
  const lines = text.split('\n')
  let i = 0
  while (i < lines.length) {
    const line = lines[i] ?? ''
    if (!line.startsWith('#') && line !== '') break
    i++
  }
  return lines.slice(i).join('\n')
}
