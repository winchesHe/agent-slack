// config.yaml 模板生成器（**单一权威**）。
//
// 模板源在 examples/config.example.yaml；本文件只负责：
// 1. example mode：原样返回 examples/config.example.yaml。
// 2. workspace mode：去掉示例引导注释，并把 model/provider 替换为 onboard 选择值。
//
// 添加新字段时改 examples/config.example.yaml + ConfigSchema +
// dashboard 表单元数据（见 AGENTS.md "Env / Config 变更联动规则"）。

import { CONFIG_EXAMPLE, stripExampleLeadingComments } from './_assets.ts'

export type ConfigYamlProvider = 'litellm' | 'anthropic' | 'openai-responses'

export interface GenerateConfigYamlArgs {
  mode: 'example' | 'workspace'
  model?: string
  provider?: ConfigYamlProvider
}

const DEFAULT_PROVIDER: ConfigYamlProvider = 'litellm'
const DEFAULT_MODEL = 'gpt-5.4'

export function generateConfigYaml(args: GenerateConfigYamlArgs): string {
  if (args.mode === 'example') return CONFIG_EXAMPLE

  const provider = args.provider ?? DEFAULT_PROVIDER
  const model = args.model ?? DEFAULT_MODEL

  // 仅替换第一处出现的 `provider:` 与 `model:`（位于 agent: 块）。
  // examples/config.example.yaml 的字段顺序保证 agent.provider 在 im.provider 之前出现。
  return stripExampleLeadingComments(CONFIG_EXAMPLE)
    .replace(/^(\s*provider:\s*)\S+/m, `$1${provider}`)
    .replace(/^(\s*model:\s*)\S+/m, `$1${model}`)
}
