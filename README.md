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

## 配置示例

仓库内置了可复制的本地配置示例：

| 示例文件 | 复制到 | 说明 |
| --- | --- | --- |
| `config.example.yaml` | `.agent-slack/config.yaml` | agent / provider / model / maxSteps / context / skills / daemon |
| `channel-tasks.example.yaml` | `.agent-slack/channel-tasks.yaml` | Slack 频道任务监听规则 |
| `system.example.md` | `.agent-slack/system.md` | workspace system prompt |
| `.env.example` | `.agent-slack/.env.local` | Slack / provider 凭证、debug、live E2E env |

这些文件只包含占位符，不包含真实凭证。`.agent-slack/.env.local`、session、logs、channel task ledger 仍应保持 git ignore。

## 目录

```
<your-project>/.agent-slack/
├── config.yaml        # agent / model / skills 配置（可选，缺失则用默认值）
├── channel-tasks.yaml # 频道任务监听配置（可选，缺失则关闭）
├── system.md          # system prompt（可选）
├── .env.local         # 凭证（git ignore）
├── channel-tasks/     # 频道任务触发 ledger（JSONL，git ignore）
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
    autoCompact:
      enabled: true             # 达到预算阈值时自动压缩上下文，然后继续本轮回复
      triggerRatio: 0.8         # boundary 后候选视图达到预算 80% 时触发
      maxFailures: 2            # 同 session 连续失败 2 次后自动熔断
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

## Slack 频道任务监听（可选）

默认只有 `@agent-slack` 会触发对话。如果需要“监听某个频道里指定用户或 bot 的消息，并自动在该消息 thread 中执行任务”，可以创建 `.agent-slack/channel-tasks.yaml`。文件缺失时功能关闭；保存后需要重启 `agent-slack start` 或 daemon 才生效。

推荐通过 dashboard 管理：

```bash
agent-slack dashboard
```

打开 `Channel Tasks` tab 后，可以生成带中文注释的模板、编辑 raw YAML、保存前做 schema 校验、删除配置。Dashboard 会原样保存 YAML，不会重排或删除中文注释。

最小示例：

```yaml
version: 1
enabled: true
rules:
  - id: daily-watch
    enabled: true
    channelIds: [C0123456789]
    source:
      includeUserMessages: true
      includeBotMessages: false
      userIds: [U0123456789]
      botIds: []
      appIds: []
    message:
      includeRootMessages: true
      includeThreadReplies: false
      allowSubtypes: [none]
      requireText: true
      ignoreAgentMentions: true
    task:
      prompt: |
        请阅读触发消息，判断是否需要处理，并给出简洁结论。
      includeOriginalMessage: true
      includePermalink: true
    reply:
      inThread: true
    dedupe:
      enabled: true
```

字段说明：

- `userIds`、`botIds`、`appIds` 都是 allowlist。`includeBotMessages` 控制是否处理“由 bot 发送”的 `bot_message`；`ignoreAgentMentions` 控制文本里 @当前 agent 时是否跳过，避免和 `app_mention` 重复。
- 某些 Slack bot 消息可能带 `bot_id/app_id` 但没有 `subtype`；只要规则允许 `bot_message` 且 `botIds/appIds` 命中，运行时仍会按 bot 来源处理。
- `reply.inThread` 当前固定为 `true`：根消息会创建 thread，thread 回复会沿用原 thread。
- 运行时触发记录保存在 `.agent-slack/channel-tasks/triggers.jsonl`，用于 Slack 重试去重和审计，建议 git ignore。

Slack App 需要额外开启事件订阅和 scope：

| 能力 | Slack 配置 |
| --- | --- |
| 监听公开频道消息 | Event Subscriptions: `message.channels`；Bot Token Scope: `channels:history` |
| 监听私有频道消息（可选） | Event Subscriptions: `message.groups`；Bot Token Scope: `groups:history` |
| 回复 thread / reaction | 继续使用 `chat:write` / `reactions:write` |
| 解析用户名称 | 继续使用 `users:read` |

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
