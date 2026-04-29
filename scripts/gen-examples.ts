// 把 generator 输出写到根目录 *.example.* 文件。
// 修改 src/workspace/templates/* 后跑：pnpm gen:examples
// 守护测试 src/workspace/templates/templates.test.ts 验证字节一致。

import { writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  generateChannelTasksYaml,
  generateConfigYaml,
  generateEnvExample,
  generateSystemMd,
} from '../src/workspace/templates/index.ts'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const targets: Array<{ file: string; content: string }> = [
  { file: 'config.example.yaml', content: generateConfigYaml({ mode: 'example' }) },
  { file: 'channel-tasks.example.yaml', content: generateChannelTasksYaml({ mode: 'example' }) },
  { file: 'system.example.md', content: generateSystemMd({ mode: 'example' }) },
  { file: '.env.example', content: generateEnvExample() },
]

for (const { file, content } of targets) {
  const full = path.join(repoRoot, file)
  writeFileSync(full, content, 'utf8')
  process.stdout.write(`wrote ${file} (${content.length} bytes)\n`)
}
