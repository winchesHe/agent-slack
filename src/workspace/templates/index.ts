// 模板 generator 集中入口（**单一权威**）。
//
// 参考 AGENTS.md "Env / Config 变更联动规则"。新增/修改字段时：
//   1. 改这里 + ConfigSchema / ChannelTasksConfigSchema
//   2. 跑 pnpm gen:examples（重写根目录 *.example.*）
//   3. 跑守护测试 src/workspace/templates/templates.test.ts 确认字节一致
//   4. 视字段是否常用，决定是否进 dashboard 表单
//
// 根目录 example 文件位置（守护测试断言字节一致）：
//   .env.example                ← generateEnvExample()
//   config.example.yaml         ← generateConfigYaml({ mode: 'example' })
//   channel-tasks.example.yaml  ← generateChannelTasksYaml({ mode: 'example' })
//   system.example.md           ← generateSystemMd({ mode: 'example' })

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
