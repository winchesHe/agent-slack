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
| `pnpm e2e:list` / `pnpm e2e <id>` | 手动运行 Slack live E2E（真实发送 Slack 消息） |

所有命令支持 `--cwd <dir>` 显式指定 workspace 目录。

---

## Provider 切换（LiteLLM / Anthropic）

一期支持两种模型 provider，**启动时选定**（运行期不切换）：

| Provider | 底层 | 必填 env | 适用 |
| --- | --- | --- | --- |
| `litellm`（默认） | LiteLLM OpenAI-compatible 网关 | `LITELLM_BASE_URL` / `LITELLM_API_KEY` | 多模型聚合、自建网关 |
| `anthropic` | Anthropic Messages API | `ANTHROPIC_API_KEY`（可选 `ANTHROPIC_BASE_URL`） | 直连 Anthropic / 自建 Claude 网关 |

**行为配置走 `config.yaml`**（方案 A：config 单一权威）：

```yaml
agent:
  name: default
  model: claude-sonnet-4-5      # provider 对应的模型 ID
  provider: anthropic           # litellm | anthropic
  maxSteps: 50
  context:
    maxApproxChars: 120000      # 只限制发给模型的历史视图，不裁剪 messages.jsonl
    keepRecentMessages: 80      # 最多加载最近消息数，避免短消息无限增长
    keepRecentToolResults: 20   # 最近 N 个工具结果保留完整；更旧结果仅在模型视图中压缩
```

**凭证 / URL / debug 走 `.env.local`**：

```dotenv
# Slack（必填）
SLACK_BOT_TOKEN=xoxb-...
SLACK_APP_TOKEN=xapp-...
SLACK_SIGNING_SECRET=...

# LiteLLM（provider=litellm 时必填）
LITELLM_BASE_URL=http://localhost:4000
LITELLM_API_KEY=sk-...

# Anthropic（provider=anthropic 时必填）
ANTHROPIC_API_KEY=sk-ant-...
# ANTHROPIC_BASE_URL=https://api.anthropic.com/v1   # 可选：自建网关

LOG_LEVEL=info

# Slack live E2E（可选；真实发 Slack 消息）
# SLACK_E2E_CHANNEL_ID=C...
# SLACK_E2E_TRIGGER_USER_TOKEN=xoxp-...
# SLACK_E2E_TIMEOUT_MS=120000
# SLACK_E2E_RESULT_PATH=.agent-slack/e2e/result.json
```

**切换步骤**：编辑 `.agent-slack/config.yaml` 的 `agent.provider` + 对应 `agent.model`，补齐 `.env.local` 凭证，重启进程。`agent-slack onboard` 在交互流程中会直接问一次 provider 并把选择写入 config.yaml。

> **不支持**：运行期多 provider 并存 / per-session 切换 / Claude Agent SDK / OpenAI Responses API（后续 spec 评估）。

---

## Project Structure

```
src/
  application.ts          # DI root: createApplication()
  index.ts                # dev 入口（pnpm dev）
  types/                  # interface 先行（AgentExecutor/IMAdapter/EventSink/...）
  agent/
    ai-sdk/               # 一期唯一 AgentExecutor 实现
  agents/                 # compact / selfImprove 等辅助 agent 与 prompts 归口
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
