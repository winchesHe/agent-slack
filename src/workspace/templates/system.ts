// system.md 模板生成器（**单一权威**）。
//
// 模板源在 examples/system.example.md（人类参考版）和 examples/system.workspace.md
// （onboard 实际写入版）；本文件只做选择，不内联模板正文。

import { SYSTEM_EXAMPLE, SYSTEM_WORKSPACE } from './_assets.ts'

export interface GenerateSystemMdArgs {
  mode: 'example' | 'workspace'
}

export function generateSystemMd(args: GenerateSystemMdArgs): string {
  return args.mode === 'example' ? SYSTEM_EXAMPLE : SYSTEM_WORKSPACE
}
