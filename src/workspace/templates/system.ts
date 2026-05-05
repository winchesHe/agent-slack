// system.md 模板生成器（**单一权威**）。
//
// 模板正文源在 examples/system.md；example/workspace 两种 mode 共享同一份正文，
// example mode 仅在前面拼接引导段（提示用户复制到 workspace 并按需修改）。

import { SYSTEM_BODY } from './_assets.ts'

export interface GenerateSystemMdArgs {
  mode: 'example' | 'workspace'
}

const EXAMPLE_INTRO = `<!-- 仓库示例：复制到 .agent-slack/system.md 后按你的项目和团队习惯增删字段。 -->

`

export function generateSystemMd(args: GenerateSystemMdArgs): string {
  return args.mode === 'example' ? EXAMPLE_INTRO + SYSTEM_BODY : SYSTEM_BODY
}
