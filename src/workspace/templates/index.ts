// 模板 generator 集中入口（**单一权威**）。
//
// 模板源在仓库 examples/ 目录；本目录的 generator 函数只负责读取/选择/参数化。
// 详见 AGENTS.md "Env / Config 变更联动规则"：
//   1. 修改 examples/* 里对应文件
//   2. 视需要更新 ConfigSchema / ChannelTasksConfigSchema
//   3. 跑 pnpm test（templates.test.ts 守护 generator 行为）
//   4. 视字段是否常用，决定是否进 dashboard 表单
//
// examples/ 文件 → generator 映射：
//   .env.example                ← generateEnvExample()
//   config.example.yaml         ← generateConfigYaml({ mode: 'example' })
//   channel-tasks.example.yaml  ← generateChannelTasksYaml({ mode: 'example' })
//   system.example.md           ← generateSystemMd({ mode: 'example' })
//   system.workspace.md         ← generateSystemMd({ mode: 'workspace' })

export {
  generateConfigYaml,
  type ConfigYamlProvider,
  type GenerateConfigYamlArgs,
} from './config.ts'
export {
  generateEnvExample,
  generateEnvLocal,
  GITIGNORE_BLOCK,
  type GenerateEnvLocalArgs,
  type SlackEnvCreds,
} from './env.ts'
export { generateChannelTasksYaml, type GenerateChannelTasksYamlArgs } from './channelTasks.ts'
export { generateSystemMd, type GenerateSystemMdArgs } from './system.ts'
