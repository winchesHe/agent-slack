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

## 架构 / 贡献

详见 [docs/superpowers/specs/2026-04-17-agent-slack-architecture-design.md](docs/superpowers/specs/2026-04-17-agent-slack-architecture-design.md)。

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

## Storage Conventions (file-based, no DB)

- Session：`<cwd>/.agent-slack/sessions/slack/<channelName>.<channelId>.<threadTs>/{meta.json,messages.jsonl}`
- Memory：`<cwd>/.agent-slack/memory/<userName>-<userId>.md`（按用户单文件，frontmatter 仅 `updatedAt` + markdown 正文；`save_memory(content)` 覆盖写，userName/userId 由 Orchestrator 注入 ToolContext）
- `messages.jsonl`：append-only，每行一个 AI SDK `ModelMessage`。
- 同 session 必须经 `SessionRunQueue` 串行写；不同 session 并行。
- 聚合查询走 scan + 内存处理；不加索引层，除非二期显式引入只读 SQLite。

## Slack Rendering Constraints

- 消息 edit 节流 ≥ 2.5s（Slack API rate limit）；`text_delta` 在 IM 侧 buffer + debounce。
- 所有 Slack API 调用经 `safeRender` 包装：失败 `logger.warn`，不抛出、不传播到 Orchestrator。
- 长回复用 `markdown-to-slack-blocks` 分块；toolbar（workspace label + tool history）仅首条消息显示。
- Reaction 协议：`👀` ack / `✅` done / `❌` error / `🛑` 用户 abort（触发 `AbortRegistry.abort`）/ `⏳` 队列等待。
- `done` 事件后追加 cost/usage context block；数据来源 AI SDK `providerMetadata.litellm.cost` 和 `usage`。

## Agent Event System

9 种 `AgentExecutionEvent`，不增不删（改动需先改 design doc §2.2）：

`text_delta | reasoning_delta | tool_input_delta | tool_call_start | tool_call_end | step_start | step_finish | done | error`

- Orchestrator 同步 emit 不限速；IM adapter 负责渲染节流/批合并。
- `AbortRegistry` key = Slack `messageTs`；AI SDK `streamText({ abortSignal })` 原生支持。

## Workflows

### File modification
read → edit → run related `*.test.ts` → `pnpm lint`

### Adding a new IM adapter
1. 复用 `src/types/im-adapter.ts` 的 `IMAdapter` 接口
2. 新建 `src/im/<name>/`，实现 adapter + sink + renderer
3. 在 `application.ts` 按 config 装配；不在 adapter 外引入该 IM 的依赖

### Adding a new agent provider
1. 复用 `src/types/agent-executor.ts` 的 `AgentExecutor` 接口
2. 新建 `src/agent/<name>/`
3. 必须映射全部 9 种 `AgentExecutionEvent`（不适用的也要合理 yield 空或忽略，不得新增 event）
4. 在 registry 注册，`config.yaml` 切换