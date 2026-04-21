// workspace 级 env 加载：统一规则，供 createApplication / doctor / 其他 CLI 入口使用。
//
// 加载顺序（先加载的优先，dotenv 默认不覆盖已存在的 env）：
//   1. <workspaceDir>/.agent-slack/.env.local   （onboard 写入的位置，工作区私有）
//   2. <workspaceDir>/.env                       （历史兼容 / 用户项目根）
//   3. ~/.agent-slack/.env                       （全局默认）
//
// 之所以用显式调用而非 `import 'dotenv/config'`：后者只会加载 process.cwd()/.env，
// 与 onboard 写入路径 `.agent-slack/.env.local` 不匹配，导致 SLACK_BOT_TOKEN 等变量在
// `agent-slack start` 时读不到。
import dotenv from 'dotenv'
import path from 'node:path'
import os from 'node:os'

export interface LoadWorkspaceEnvArgs {
  workspaceDir: string
}

export function loadWorkspaceEnv(args: LoadWorkspaceEnvArgs): void {
  const candidates = [
    path.join(args.workspaceDir, '.agent-slack', '.env.local'),
    path.join(args.workspaceDir, '.env'),
    path.join(os.homedir(), '.agent-slack', '.env'),
  ]
  for (const file of candidates) {
    dotenv.config({ path: file, override: false })
  }
}
