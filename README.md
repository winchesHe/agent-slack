# agent-slack

绑定当前目录为 workspace 的 Slack agent 服务。

## 安装

```bash
pnpm install     # 源码方式：进入本仓库
pnpm build       # 生成 bin/agent-slack.js
pnpm link --global   # 或直接 node bin/agent-slack.js
```

## 快速开始

```bash
cd your-project/
agent-slack onboard         # 交互式配置 Slack/LiteLLM 凭证，生成 .agent-slack/
agent-slack doctor          # 验证环境与凭证
agent-slack start           # 启动（前台阻塞）
```

在 Slack 里 `@agent-slack 你好` 即可开始对话。

## 目录

```
<your-project>/.agent-slack/
├── config.yaml        # agent / model / skills 配置（可选，缺失则用默认值）
├── system.md          # system prompt（可选）
├── .env.local         # 凭证（git ignore）
├── sessions/slack/    # 对话历史（JSONL）
├── memory/            # 长期记忆（Markdown）
├── skills/            # SKILL.md 增强
└── logs/              # 日志（JSON lines）
```

## 命令

| 命令 | 说明 |
| --- | --- |
| `agent-slack onboard` | 交互式初始化当前目录（询问 Slack 三件套 + LiteLLM 并当场校验） |
| `agent-slack start` | 启动服务（前台阻塞，Ctrl+C 优雅退出） |
| `agent-slack status` | 打印 workspace 配置 + skills + 最近 session 摘要 |
| `agent-slack doctor` | 环境自检（Node / 目录 / 凭证 / Slack auth / LiteLLM /models / 模型可用 / skills） |

所有命令支持 `--cwd <dir>` 显式指定 workspace 目录。

---

## Project Structure

```
src/
  application.ts          # DI root: createApplication()
  index.ts                # dev 入口（pnpm dev）
  types/                  # interface 先行（AgentExecutor/IMAdapter/EventSink/...）
  agent/
    ai-sdk/               # 一期唯一 AgentExecutor 实现
  im/
    slack/                # 一期唯一 IMAdapter 实现
  orchestrator/           # ConversationOrchestrator + SessionRunQueue + AbortRegistry
  store/                  # SessionStore / MemoryStore（文件系统）
  workspace/              # WorkspaceContext 加载（config.yaml + system.md + skills/）
  skills/                 # SKILL.md loader（gray-matter）
  logger/                 # consola + redactor
bin/cli.ts                # agent-slack CLI 入口（onboard/start/status/doctor）
tests/                    # 跨模块集成测试
docs/superpowers/specs/   # 架构决策文档（design doc）
```
