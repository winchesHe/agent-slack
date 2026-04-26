# agent-slack 架构设计文档

**日期**：2026-04-17
**状态**：已确认，待 spec review
**局部替换**：§2.2 `AgentExecutionEvent` / `EventSink` 定义、§2.3 节流策略、§4 数据流 SlackEventSink → SlackRenderer 段、§4.1 Cost 路径、§4.2 Abort 路径、§6.2 Agent Errors 行、§7.1 M2 里程碑描述 均被 [`2026-04-19-slack-render-flow-redesign.md`](./2026-04-19-slack-render-flow-redesign.md) 覆盖；本文件保留为**历史基线**，以新 spec 为准
**增量设计**：Slack 频道普通消息 / bot 消息自动触发任务见 [`2026-04-26-slack-channel-task-listener-design.md`](./2026-04-26-slack-channel-task-listener-design.md)

## 1. 项目目标

构建一个可扩展的 agent 服务平台，**一期实现** codex 类型的 agent 通过 slack 提供服务，架构预留**多 agent / 多 IM** 的扩展能力。

### 一期目标

- **Agent 基座**：Vercel AI SDK + LiteLLM（统一模型层代理）
- **IM 入口**：Slack（socket mode，@mention 触发；本期新增 @mention command router，首个 command 为 `compact`；频道任务监听见独立增量 spec）
- **Workspace 模式**：进程启动时绑定 `cwd`，所有数据落在 `<cwd>/.agent-slack/`
- **运行方式**：`pnpm dev`（开发，dogfooding agent-slack 仓库本身）和 `agent-slack` CLI（分发给其他项目使用）
- **交互丰富度**：thinking、tool-use、cost/token 展示齐全
- **日志系统**：consola + redactor + 文件落盘，方便 debug

### 二期扩展点（一期不做实现，但架构预留）

- 多 agent provider
- 多 IM 适配：Telegram 等
- 多 workspace 切换、memory 全文检索

---

## 2. 核心抽象（Interface 先行）

### 2.1 分层

```
┌────────────────────────────────────────────────────────┐
│  Entry Layer      src/index.ts   |  bin/cli.ts         │
│  (dev server)        (CLI: onboard/start/status/doctor) │
├────────────────────────────────────────────────────────┤
│  Application      createApplication()                   │
│  (DI Container)   装配所有依赖，无全局单例              │
├────────────────────────────────────────────────────────┤
│  IM Layer           Agent Layer         Workspace Layer │
│  ┌─────────────┐   ┌───────────────┐   ┌─────────────┐ │
│  │ IMAdapter   │←─→│ AgentExecutor │←─→│ Workspace   │ │
│  │  └─ Slack   │   │  └─ AiSdk     │   │  Context    │ │
│  │  (telegram  │   │  (cli adapter │   │  (cwd-based)│ │
│  │   预留)     │   │   预留)       │   │             │ │
│  └─────────────┘   └───────────────┘   └─────────────┘ │
├────────────────────────────────────────────────────────┤
│  Core Services                                          │
│  ConversationOrchestrator | SkillLoader                 │
│  SessionStore | MemoryStore | Logger | AbortRegistry    │
├────────────────────────────────────────────────────────┤
│  Persistence    Filesystem (JSON / JSONL / Markdown)    │
└────────────────────────────────────────────────────────┘
```

### 2.2 Interface 定义

```ts
// 1. Agent 执行器
interface AgentExecutor {
  execute(req: AgentExecutionRequest): AsyncGenerator<AgentExecutionEvent>
  drain(): Promise<void>
}

// ⚠️ 已被 2026-04-19 spec 替换为粗粒度 4 类事件。
// 当前权威定义见 [`2026-04-19-slack-render-flow-redesign.md`](./2026-04-19-slack-render-flow-redesign.md) §2。
// 摘要：AgentExecutionEvent = activity-state | assistant-message | usage-info | lifecycle。
// 下列旧定义**仅作历史参考**，实装不再遵循。
type AgentExecutionEvent_LEGACY =
  | { type: 'text_delta'; text: string }
  | { type: 'reasoning_delta'; text: string }
  | { type: 'tool_input_delta'; toolCallId: string; toolName: string; partial: string }
  | { type: 'tool_call_start'; toolCallId: string; toolName: string; input: unknown }
  | { type: 'tool_call_end'; toolCallId: string; toolName: string; output: unknown; isError: boolean }
  | { type: 'step_start' }
  | { type: 'step_finish'; usage?: StepUsage_LEGACY }
  | { type: 'done'; finalText: string; totalUsage: TotalUsage_LEGACY }
  | { type: 'error'; error: Error }

interface StepUsage_LEGACY { /* 被 SessionUsageInfo 替换，见新 spec §2 */ }
interface TotalUsage_LEGACY { /* 被 SessionUsageInfo 替换，见新 spec §2 */ }

// 2. IM 适配器
interface IMAdapter {
  id: 'slack' | 'telegram'
  start(): Promise<void>
  stop(): Promise<void>
}

// 3. 会话编排器（关键粘合层）
interface ConversationOrchestrator {
  handle(input: InboundMessage, sink: EventSink): Promise<void>
}

// 3.1 InboundMessage 携带 userName（IM adapter 解析）
interface InboundMessage {
  // ...原有字段
  userId: string
  userName: string    // Slack users.info → real_name ?? name，回退 userId
}

// 3.2 ToolContext（per-handle 注入）
interface ToolContext {
  cwd: string
  logger: Logger
  currentUser?: { userName: string; userId: string }
}

// 3.3 Orchestrator 依赖（tools 改为 per-handle 动态构建）
interface ConversationOrchestratorDeps {
  toolsBuilder: (ctx: ToolContext) => ToolSet    // 替代成品 tools
  executorFactory: (tools: ToolSet) => AgentExecutor  // per-handle 新建
  sessionStore: SessionStore
  memoryStore: MemoryStore
  systemPrompt: string
  logger: Logger
}

// 4. 事件 sink（IM adapter 提供给 orchestrator）
// ⚠️ 已被 2026-04-19 spec 替换为无独立 fail() 的粗粒度接口，
// 当前权威定义见新 spec §5（SlackEventSink）。摘要：
//   interface SlackEventSink {
//     onEvent(event: AgentExecutionEvent): Promise<void>
//     finalize(): Promise<void>
//     readonly terminalPhase: 'completed' | 'stopped' | 'failed' | undefined
//   }
// orchestrator 兜底异常走新 spec §8.3 的 emitSyntheticFailed helper。

// 5. Workspace 上下文（启动时一次性构建，只读传递）
interface WorkspaceContext {
  cwd: string
  configDir: string            // <cwd>/.agent-slack
  config: WorkspaceConfig
  systemPrompt: string         // system.md 内容
  skills: Skill[]
}

interface Skill {
  name: string
  description: string
  whenToUse?: string
  content: string
  source: string
}
```

### 2.3 关键设计决策

- **Agent 和 IM 抽象从第 1 天就有**，但一期只实现 `AiSdkExecutor` 和 `SlackAdapter` 各一份。
- **所有依赖通过 `createApplication()` 注入**，禁止全局单例。
- **`AgentExecutionEvent` 是 IM 无关的抽象事件**，IM adapter 负责翻译成各自的 UI 更新。
- ~~**`EventSink` 的节流/批处理在 IM 侧**（Slack ≥ 2.5s debounce）~~ → 改为**基于 `ActivityState` 快照的 key diff 幂等去重**，不再用时间窗 debounce；详见新 spec §2.1 / §6.3。
- **持久化在 Orchestrator 层**——IM 只管协议，Executor 只管执行，落盘是编排职责。

---

## 3. 数据模型与存储布局

### 3.1 workspace = 进程启动时的 cwd

一个进程服务一个 workspace。想同时服务多项目？启动多个进程、配多套 slack app。**一期不做 workspace 切换**。

### 3.2 目录布局（全 Files，无 DB）

```
<cwd>/.agent-slack/
  config.yaml                          # workspace 配置
  system.md                            # 独立 system prompt
  sessions/
    slack/
      <channelName>.<channelId>.<threadTs>/
        meta.json                      # { imUserId, agentName, status, usage 累计, ... }
        messages.jsonl                 # append-only，每行一个 AI SDK ModelMessage
  memory/
    <userName>-<userId>.md             # 按用户单文件，frontmatter(updatedAt) + markdown
  skills/
    <skill-name>/
      SKILL.md                         # frontmatter + markdown
  logs/
    YYYY-MM-DD.log                     # JSON lines，按天滚动

~/.agent-slack/                        # 全局级（可选）
  .env                                 # 凭证（可被 workspace 级覆盖）
  global.yaml                          # 默认值（可被 workspace 级覆盖）
```

### 3.3 配置加载优先级

- 环境变量（`process.env`）> `<cwd>/.agent-slack/.env.local` > `~/.agent-slack/.env`
- `<cwd>/.agent-slack/config.yaml` > `~/.agent-slack/global.yaml` > 代码默认值
- Slack live E2E runner 额外加载 `<cwd>/.env.e2e` 并允许覆盖，仅用于 `SLACK_E2E_*` 等手动测试变量

### 3.4 `config.yaml` 形态

```yaml
agent:
  name: default
  model: claude-sonnet-4-6
  provider: litellm
  maxSteps: 50
  context:
    maxApproxChars: 240000      # 传给模型的历史上下文近似字符预算；只影响模型视图，不裁剪 messages.jsonl
    keepRecentMessages: 80      # 传给模型的最近消息数上限；用于限制大量短消息导致的上下文膨胀
    keepRecentToolResults: 20   # 保留最近 N 个完整工具结果；更旧结果仅在模型视图中压缩

skills:
  enabled: ['*']

im:
  provider: slack
  slack:
    resolveChannelName: true           # 首次创建 session 时调一次 conversations.info
```

### 3.5 为什么全 Files 而非 SQLite

| 维度 | Files | SQLite |
|---|---|---|
| Agent 索引能力 | ✅ 原生 read/grep/glob 可用 | ❌ 黑盒，需专用 tool |
| 用户直接编辑 | ✅ `vim`、`cat` 可用 | ❌ 需 sqlite CLI |
| Git version control | ✅ 文本 diff 清晰 | ❌ 二进制 |
| 按 thread 查 session | ✅ 路径拼接 O(1) | 索引 O(log n) |
| 跨 session 聚合统计 | ⚠️ 扫 jsonl，一期不做 | ✅ |
| 并发写 jsonl | ⚠️ 需 append 锁（同 session 串行执行不冲突） | ✅ 事务保证 |

**结论**：对本项目场景（单进程单 workspace、session 数量合理、重点是 agent/用户友好度），全 Files 完胜。未来若需要聚合统计，再引入只读 SQLite 索引。

### 3.6 Memory 读写策略（按用户单文件）

> 详见 `2026-04-18-memory-per-user-design.md`

- **存储方式**：一人一文件，`memory/<sanitize(userName)>-<userId>.md`
  - sanitize 规则：`[\/\\:*?"<>|\s]` → `_`（保留中文与可读字符）
  - 文件带 frontmatter（仅 `updatedAt`），正文为任意 markdown
- **写入用专用 tool**：`save_memory(content)` — 参数仅 `content`，`userName` / `userId` 由 Orchestrator 从 `InboundMessage` 注入 `ToolContext.currentUser`，agent 无需关心
  - 覆盖写（overwrite）语义；合并由主 agent 自行负责（先 `bash cat` 读 → 合并 → 整体 `save_memory` 覆盖写）
- **读取用通用 tool**：agent 直接用内置 `bash cat` / `read_file` / `grep` / `glob` 访问 `memory/` 目录
- **Orchestrator 注入 memory 提示**：
  - 文件已存在 → systemPrompt 追加 `[你关于该用户的长期记忆在 \`<relPath>\`，需要时用 bash 读]`
  - 文件不存在 → 不注入提示；agent 首次 `save_memory` 自动创建
- **tools 每次 handle 动态构建**：Orchestrator 注入 `toolsBuilder: (ctx: ToolContext) => ToolSet`，闭包持有当前 user，per-handle 新建 executor
- **userName 来源**：Slack `users.info(userId)` → `real_name ?? name`，回退 `userId`；加 `userNameCache: Map<userId, userName>` 缓存

### 3.7 Session 上下文预算与压缩设计

#### 3.7.1 背景与目标

当前 session 历史以 append-only `messages.jsonl` 保存，`SessionStore.loadMessages()` 会完整读取历史。长 thread、频繁 tool loop、较大的 bash/tool 输出会让 `ConversationOrchestrator` 把越来越大的 `messages` 传给模型，存在触发 provider context too large 的风险。

目标是在不破坏全量 transcript 的前提下，为模型调用构造一个有预算的 **model-view messages**：

- `messages.jsonl` 继续作为完整事实源，append-only，不做 destructive rewrite。
- Slack 展示、审计、debug 仍可读取完整历史。
- 只裁剪传给 `AgentExecutor.execute()` 的模型视图。
- 裁剪必须保护 AI SDK tool-call / tool-result 配对，避免产生 orphan tool result 或悬空 tool call。
- 一期先做 deterministic pruning；LLM summary compact、tool result microcompact 作为渐进增强。

#### 3.7.2 配置

上下文预算属于行为配置，只放在 `config.yaml`，不使用 env：

```yaml
agent:
  context:
    maxApproxChars: 240000      # 传给模型的历史上下文近似字符预算；只影响模型视图，不裁剪 messages.jsonl
    keepRecentMessages: 80      # 传给模型的最近消息数上限；用于限制大量短消息导致的上下文膨胀
    keepRecentToolResults: 20   # 保留最近 N 个完整工具结果；更旧结果仅在模型视图中压缩
    autoCompact:
      enabled: true             # 自动 compact 开关；只影响主流程前置维护，不影响手动 /compact
      triggerRatio: 0.8         # boundary 后候选模型视图达到预算 80% 时触发
      maxFailures: 2            # 同 session 连续失败 2 次后熔断自动 compact
```

- `maxApproxChars`：模型视图的近似字符预算。默认 `240000`，作为跨 provider 的保守上限，避免把文件型 transcript 无限制塞入 prompt。
- `keepRecentMessages`：最多保留的最近消息数。默认 `80`，用于限制大量短消息导致的无限增长。
- `keepRecentToolResults`：最多保留的最近完整 tool-result 数。默认 `20`，更旧 tool-result 只在模型视图中替换为占位提示。
- `autoCompact.enabled`：自动 compact 默认开启。它只在主流程前置阶段运行；手动 `/compact` 不受该开关影响。
- `autoCompact.triggerRatio`：自动触发阈值，默认 `0.8`。当最后 compact boundary 之后的候选模型视图达到 `maxApproxChars` 或 `keepRecentMessages` 的 80% 时触发。
- `autoCompact.maxFailures`：同 session 自动 compact 连续失败上限，默认 `2`。达到上限后本 session 自动 compact 熔断，主流程继续使用 Phase 1/2。

预算是 best-effort：为保护 tool-call/tool-result 配对，实际输出可能略超预算；正确性优先于硬截断。

#### 3.7.3 Phase 1：确定性模型视图裁剪

新增纯函数模块构造模型视图，例如：

```ts
interface ModelMessageBudget {
  maxApproxChars: number
  keepRecentMessages: number
  keepRecentToolResults: number
}

function buildModelMessages(args: {
  history: CoreMessage[]
  userMessage: CoreMessage
  budget: ModelMessageBudget
  messagesJsonlPath: string
}): CoreMessage[]
```

`SessionStore.loadMessages()` 仍完整返回历史；`ConversationOrchestrator` 在 append 当前 user message 后，调用 `buildModelMessages()`，再把结果传给 executor。裁剪提示里必须使用当前 session 的真实 `messages.jsonl` 路径（例如 `path.join(session.dir, 'messages.jsonl')`），禁止写死泛化文案：

```ts
const history = await deps.sessionStore.loadMessages(session.id)
const userMsg: CoreMessage = { role: 'user', content: input.text }
await deps.sessionStore.appendMessage(session.id, userMsg)

const messagesJsonlPath = path.join(session.dir, 'messages.jsonl')
const modelMessages = buildModelMessages({
  history,
  userMessage: userMsg,
  budget: workspace.config.agent.context,
  messagesJsonlPath,
})

executor.execute({ systemPrompt, messages: modelMessages, abortSignal })
```

裁剪策略：

1. 当前 `userMessage` 永远保留。
2. 从 `history` 尾部向前累计，直到达到 `maxApproxChars` 或 `keepRecentMessages`。
3. 若没有触发预算，返回 `history + userMessage`。
4. 若触发裁剪，在模型视图最前面插入一条中文提示，说明仅加载最近上下文，完整记录仍在 session 文件中。
5. 裁剪只发生在模型视图，不回写 `messages.jsonl`。

裁剪提示建议：

```txt
[历史上下文已按预算裁剪]
本次仅加载最近对话片段；完整会话记录仍保存在：<messagesJsonlPath>
```

#### 3.7.4 Tool-call / tool-result 不变量

裁剪边界必须维护 AI SDK 消息序列合法性：

- 保留 `role: 'tool'` 的 tool-result 时，必须保留对应 assistant tool-call。
- 保留 assistant tool-call 且历史中已有对应 tool-result 时，必须保留该 tool-result。
- 如果预算切点落在一组 tool-call/tool-result 中间，向前或向后扩展边界以保留完整 pair。
- 若扩展后超过预算，仍优先保留完整 pair；不能为了硬预算制造非法消息序列。

实现上通过扫描 `CoreMessage.content` 中的结构化块识别：

- assistant content array 中的 `{ type: 'tool-call', toolCallId }`
- tool content array 中的 `{ type: 'tool-result', toolCallId }`

边界调整优先向前扩展到包含缺失的 assistant tool-call；对已经位于保留区内的 assistant tool-call，则向后包含匹配 tool-result。若存在多 tool-call 一次返回、多 tool-result 分条落盘，也按 `toolCallId` 集合处理。

#### 3.7.5 Phase 2：工具结果 microcompact

Phase 1 稳定后，再在模型视图层加入旧 tool-result 轻量压缩：

- 保留最近 `agent.context.keepRecentToolResults` 个完整 tool-result，默认 20。
- 更旧的 tool-result content 替换为占位文本：

```txt
[旧工具结果已压缩；完整内容保存在：<messagesJsonlPath>]
```

该替换仅作用于 `modelMessages`，不回写 `messages.jsonl`，避免 transcript migration 和审计信息丢失。

#### 3.7.6 Phase 3：LLM summary compact + boundary

当 deterministic pruning 仍不足以保留高质量上下文时，引入 compact summary：

- 用单独的无工具模型调用生成历史摘要。
- 在文件存储中追加 compact marker / summary，而不是覆盖旧消息。
- 后续构造模型视图时，从最后一个 compact boundary 开始加载：`summary + boundary 后 tail + 当前 userMessage`。
- compact 失败时回退 Phase 1，不阻塞用户请求。
- 手动 compact 的 Slack 输出必须短，只保留后续有用上下文；过滤握手/测试/原样回复等低价值内容，不展示本地绝对路径、session/jsonl 路径或完整记录路径。

compact marker 使用结构化文件记录，存储在当前 session 目录的 `compact.jsonl`。每次 compact 成功时，除了把人类可读 summary 作为 assistant message 追加到 `messages.jsonl`，还追加一条结构化记录：

```ts
interface CompactRecord {
  schemaVersion: 1
  messageId: string
  mode: 'manual' | 'auto'
  createdAt: string
}
```

模型视图构造时优先使用 `compact.jsonl` 中的 `messageId` 识别最后 compact boundary；该 summary 必须保留，预算裁剪只作用于 boundary 之后的 tail。为了兼容旧 session，若没有匹配的结构化记录，可 fallback 识别 assistant 文本前缀 `[compact:`（例如 `[compact: manual]`），但新写入不再依赖自然语言前缀作为权威 marker。

LLM compact 不作为普通 AI SDK built-in tool 注入主 agent toolset。原因是 compact 属于运行时上下文管理，不应该由模型自主决定或消耗主任务 `maxSteps`；自动触发由 Orchestrator / ContextCompactor 服务在调用 executor 前处理。本期新增 @mention command router 作为手动 compact 控制入口，首个支持的 command 为 `compact`，它复用同一个 compact service，而不是暴露成主 agent 可调用工具。

compact marker 必须是稳定可识别的数据，而不是只能靠自然语言匹配。优先方案是单独 `compact.jsonl` 或消息 metadata；若使用 `CoreMessage` metadata，需先验证 AI SDK 会安全透传/忽略该字段，不影响 provider 请求。

#### 3.7.7 Phase 4：自动触发与熔断

自动 compact 是主流程的前置维护阶段，发生在 `ConversationOrchestrator` append 当前 user message 后、调用 `buildModelMessages()` 和主 `AgentExecutor` 前。触发后同一轮仍继续执行用户请求，不把 compact summary 当成最终回复。

状态机：

1. Orchestrator 进入同 session `SessionRunQueue`，`meta.status = running`；同 thread 后续消息继续排队。
2. append 当前 user message。
3. 计算最后 compact boundary 之后的候选模型视图预算占用：`lastCompactSummary + boundary 后 tail + currentUserMessage`。
4. 若达到 `autoCompact.triggerRatio`，且本 session 未熔断，则先发 `activity-state`：`正在整理上下文…`。
5. 调用 `ContextCompactor.autoCompact()`，使用无工具 LLM 生成 `[compact: auto]` summary 并 append 到 `messages.jsonl`；不通过 `assistant-message` 发 Slack 回复。
6. 重新 load history / 重建 model-view，继续调用主 `AgentExecutor`。
7. 若 auto compact 失败，记录失败计数并回退 Phase 1/2，继续本轮主请求；失败不能让用户请求直接失败。

触发规则：

- 默认开启：`agent.context.autoCompact.enabled = true`。
- 字符阈值：`candidateApproxChars >= maxApproxChars * triggerRatio`。
- 消息数阈值：`candidateMessageCount >= keepRecentMessages * triggerRatio`。
- 只统计最后 compact boundary 之后的候选视图，避免 append-only 完整历史导致每轮重复 compact。
- 若 boundary 后有效消息少于 2 条，跳过 auto compact，避免生成空摘要。

熔断规则：

- 自动 compact 连续失败达到 `autoCompact.maxFailures` 后，本 session 进入 auto compact circuit breaker。
- 熔断只影响自动 compact；用户显式 `/compact` 继续可用，并且仍需把失败展示给用户。
- 自动 compact 成功后重置失败计数并关闭熔断。
- 熔断状态必须持久化在 file storage 中；推荐扩展 `meta.json` 的可选 `context.autoCompact` 字段，保持旧 `meta.json` 向后兼容：

```ts
interface SessionMeta {
  context?: {
    autoCompact?: {
      failureCount: number
      breakerOpen: boolean
      lastAttemptAt?: string
      lastSuccessAt?: string
      lastFailureAt?: string
      lastFailureMessage?: string
    }
  }
}
```

Slack UI：

- auto compact 等待期间显示运行态：`正在整理上下文…`。
- 该状态只是主流程 activity，不产生最终回复，也不显示 `[compact: auto]` 内容。
- compact 完成后进入正常 agent executor 状态；最终只发送主 agent 回复、usage 与终态。

可观测性：

- 记录日志 tag `context:compact`，包含 trigger reason、candidate chars/messages、failureCount、breakerOpen。
- 可在 `events.jsonl` 追加非对话事件（例如 `auto_compact_attempt/succeeded/failed/skipped`），但不得污染 `messages.jsonl`；`messages.jsonl` 只追加 compact summary 这类模型上下文事实。
- live E2E 应覆盖：超阈值后自动 compact、Slack 显示整理上下文活动态、主回复继续完成、`messages.jsonl` 持久化 `[compact: auto]`、`compact.jsonl` 持久化结构化 marker、熔断后不再重复调用 compact。

### 3.8 辅助 agent 与 prompt 目录归口

本期新增专门目录集中管理辅助 agent。这里的 "agent" 指 agent-slack 内部的辅助能力模块，不等同于主 `AgentExecutor`；它们可能是纯代码处理器，也可能是无工具 LLM 调用封装。目标是把 compact agent、self-improve collector/generator 以及它们的 prompts 放在同一归口下，避免继续散落在 `src/agent/tools/*`。

推荐目录：

```txt
src/agents/
  compact/
    index.ts
    compactAgent.ts
    prompts.ts
    types.ts
  selfImprove/
    index.ts
    collectorAgent.ts
    generatorAgent.ts
    semanticDedupAgent.ts
    prompts.ts
    types.ts
```

职责边界：

- `src/agents/compact/compactAgent.ts`：封装无工具 LLM summary compact 调用，供 `ContextCompactor` 使用。
- `src/agents/compact/prompts.ts`：保存 compact summary prompt、输出格式约束、裁剪提示模板。
- `src/agents/selfImprove/collectorAgent.ts`：承接已实现的 self-improve collector 职责，负责收集 session / memory / existing rules。
- `src/agents/selfImprove/generatorAgent.ts`：承接已实现的 self-improve generator 职责，负责候选规则后处理/去重/排序。
- `src/agents/selfImprove/semanticDedupAgent.ts`：承接 self-improve 语义去重 LLM 能力（存在时），失败降级到 generator。
- `src/agents/selfImprove/prompts.ts`：保存 AGENTS 规则编写指南、语义去重 prompt 等 self-improve 相关 prompt。

`src/agent/tools/*` 只保留 AI SDK tool wrapper：解析 tool 参数、调用 `src/agents/*` 能力、格式化 tool 返回值。tool wrapper 不再定义长 prompt、不直接实现 collector/generator/compact 核心逻辑。新增辅助 agent 时必须优先放入 `src/agents/<name>/`，再由 tool、orchestrator command、运行时服务按需复用。

---

## 4. 关键数据流

以一次 `@mention` 的完整路径为例：

```
┌─────────────┐
│ Slack Event │ (app_mention)
└──────┬──────┘
       ▼
 (1) SlackAdapter.onMention
     ├─ 立即加 👀 reaction（ack）到用户原消息（sourceMessageTs）
     ├─ 构造 InboundMessage
     └─ 创建 SlackEventSink（包装 WebClient，持有 sourceMessageTs）
       ▼
 (2) ConversationOrchestrator.handle(inbound, sink)
     │
     ├─ 2a. 从 SessionRunQueue 入队（同 session 严格 FIFO）
     │
     ├─ 2b. SessionStore.getOrCreate(slack, ch, ts)
     │       ├─ 目录存在 → load meta
     │       └─ 不存在 → 调用 conversations.info 查 channelName（缓存到 meta）
     │
     ├─ 2c. SessionStore.loadMessages(sessionId) → 完整历史 CoreMessage[]
     │
     ├─ 2d. append 新 user message 到 messages.jsonl
     │
     ├─ 2e. buildModelMessages(history, userMsg, context budget)
     │       └─ 生成预算内 model-view messages（完整 transcript 不回写裁剪）
     │
     ├─ 2f. 组装 AgentExecutionRequest
     │       ├─ systemPrompt (system.md + skills frontmatter 拼接)
     │       ├─ messages (model-view messages)
     │       ├─ tools (内置 8 个)
     │       ├─ abortSignal (AbortRegistry 分配)
     │       └─ modelConfig (from config.yaml)
     │
     ├─ 2g. executor.execute(req) → AsyncGenerator<AgentExecutionEvent>
     │
     └─ 2h. for await event of stream:
               sink.emit(event)
               持久化 assistant/tool message 到 jsonl
               step_finish 累加 usage 到 meta.json
       ▼
 (3) AiSdkExecutor.execute
     └─ streamText({ model: litellm(...), messages, tools,
                     stopWhen: stepCountIs(maxSteps), abortSignal })
        .fullStream → yield AgentExecutionEvent
       ▼
 (4) SlackEventSink → SlackRenderer
     ⚠️ 已被 2026-04-19 spec 重写（三载体模型：状态条 + progress message + reply messages）。
     新流程权威定义见新 spec §3（架构分层）/ §4（SlackRenderer）/ §5（Sink 状态机）/ §6（AiSdkExecutor 聚合）。
     摘要：
       lifecycle:started     → addAck(👀) + setStatus('思考中…', loading pool)
       activity-state        → key diff 去重 → upsert progress message（有意义态激活）
       assistant-message     → 独立 postThreadReply（markdown 自动分块）+ 删 progress
       usage-info            → 暂存，completed 时独立 postSessionUsage
       lifecycle:completed   → finalize progress（✅ 完成 · toolHistory）+ addDone(✅)
       lifecycle:stopped(max_steps)
                           → 发送 maxSteps 上限总结回复，不标记 ✅ 完成，终态按 stopped 收口
       lifecycle:stopped     → finalize（已被用户中止）+ addStopped(⏹️)
       lifecycle:failed      → finalize（⚠️ 出错）+ addError(❌)
```

### 4.1 Cost 路径

⚠️ 已被 2026-04-19 spec 重写，以新 spec §6.4（`extractCostFromMetadata`）+ §7（持久化映射）为准。摘要：
- 在 AI SDK v4 `fullStream` 的 `step-finish` part 中从 `providerMetadata` 读 cost（非 `onFinish`）
- Executor 聚合成 `usage-info` 事件（粗粒度），在 `finish` 顶层 part 发一次
- Orchestrator 订阅 `usage-info` 累加到 `meta.json`；Renderer 在 completed 后独立 `postSessionUsage`

### 4.2 Abort 路径

⚠️ 已被 2026-04-19 spec 细化，以新 spec §8.1 为准。关键增强：
- AI SDK 抛 `AbortError` 后 executor 尝试 `await result.response.catch(...).messages`（best-effort）携带已完成 step 的 `finalMessages` 进入 `lifecycle { stopped }`
- Orchestrator 收到 `stopped` 事件：若 `finalMessages` 非空 → 整批 append 到 jsonl；随后追加 `[stopped]` 标记，保证中断后记忆完整

### 4.3 Channel name 获取策略

- **一期策略**：首次创建 session 时调 `conversations.info` 查一次，写入 `meta.json` 和目录名
- **缓存后永不复查**：channel 重命名不会同步，目录名保持首次值
- 失败降级：`channelName = 'unknown'`

### 4.4 并发控制

- **每个 session 一个 FIFO 队列**（`SessionRunQueue`）
- 同 session 的多条消息严格串行（避免 jsonl 并发追加、agent 状态污染）
- 不同 session 完全并行
- 排队期间 IM 侧可加 `⏳` reaction 提示
- 进程崩溃 = 队列丢失（一期接受）

### 4.5 @mention command router：`compact`

本期新增 @mention command router，第一条命令是 `compact`，用于手动触发当前 thread session 的 LLM summary compact。该入口是 IM 控制面，不进入主 agent toolset，也不消耗主任务 `maxSteps`。

用户仍然通过 @mention 触发，不需要额外配置 Slack slash command。`SlackAdapter` 去掉 bot mention 后，把用户文本交给 command router 先做确定性匹配；命中控制命令则走命令处理，不再进入普通 agent 执行。首期支持的 compact 触发表达：

```txt
@bot /compact
@bot compact
@bot 压缩上下文
@bot 帮我压缩当前上下文
```

未来新增其他命令时，沿用同一个 router 注册表扩展；不要把比喻性的命令前缀写成真实示例。

目标 session 由当前 @mention 事件确定：

- 在 thread 内触发时，使用该 thread 的 `threadTs`。
- 在 channel 根消息触发时，使用当前消息形成的 thread/session key；如果不存在可 compact 的历史，回复用法提示，不创建空 compact。
- 不从自然语言里猜测其他 thread，也不要求用户手输 thread URL。

处理流程：

1. `SlackAdapter.onMention` 继续按现有 @mention 路径 ack，并构造 `InboundMessage`。
2. `ConversationOrchestrator` 在构造 tools/executor 前调用 command router。
3. 命中 `compact` 后，进入同一个 `SessionRunQueue`，与该 thread 的普通 agent run 串行，避免 compact 与运行中 agent 同时写 jsonl。
4. 调用 `ContextCompactor.manualCompact({ sessionId, trigger: 'mention_command', userId })`。
5. compactor 读取完整 `messages.jsonl`，用无工具模型调用生成 summary，追加 compact marker / summary。
6. 成功后在当前 thread 发送一条可见说明；失败时发送错误说明，并记录日志。

`compact` command 只做手动压缩，不触发 agent 回复、不执行工具、不修改 memory。权限沿用 Slack workspace/channel 可见性；更细粒度权限（如仅 thread 参与者可 compact）作为后续增强。

### 4.6 Slack 频道任务监听（增量 spec）

监听指定频道消息、按 user/bot 来源匹配并自动启动任务的设计不直接并入本历史基线文档；当前权威设计见 [`2026-04-26-slack-channel-task-listener-design.md`](./2026-04-26-slack-channel-task-listener-design.md)。

该增量设计的核心边界：

- 使用可选独立配置 `.agent-slack/channel-tasks.yaml`，文件缺失即关闭。
- 支持匹配 user message 与 bot message，并在触发消息 thread 中回复。
- 命中规则后复用 `ConversationOrchestrator.handle()`，不新增 agent 编排 SDK，不暴露为主 agent tool。
- Dashboard 通过独立 Channel Tasks tab/API 管理 raw YAML，并保留中文注释模板。

---

## 5. 运行时入口

### 5.1 两种运行方式

| 模式 | 命令 | 绑定 workspace | 用途 |
|---|---|---|---|
| Dev | `pnpm dev` | agent-slack 仓库自身（dogfooding） | 开发 agent-slack 本体，nodemon 热重载 |
| CLI | `agent-slack start` | 当前 shell cwd | 对任意项目启用 agent，日常/生产使用 |

两种模式共享 `createApplication()`，差异仅为"是否编译"和"workspace 目录解析"。

### 5.2 CLI 命令清单（一期）

```
agent-slack onboard       # 交互式初始化向导
agent-slack start         # 启动 server（前台阻塞）
agent-slack status        # 查看 workspace 状态
agent-slack doctor        # 环境自检
agent-slack --version
agent-slack --help
```

### 5.3 Onboard 流程（@clack/prompts）

1. 确认 `cwd` 作为 workspace
2. 依次询问：Slack Bot Token / App Token / Signing Secret、LiteLLM Endpoint / API Key、默认 Model、Skills 启用策略
3. 当场调 `slack auth.test` 和 `litellm /health` 校验凭证
4. 生成：
    - `.agent-slack/config.yaml`
    - `.agent-slack/system.md`（默认模板）
    - `.agent-slack/.env.local`（凭证 + 提示加入 `.gitignore`）
    - `.agent-slack/{sessions,memory,skills,logs}/` 空目录
5. 引导下一步："运行 `agent-slack start`"

**边界情况处理**：
- 已存在 `.agent-slack/` → 提示 (a) 补齐缺失 / (b) 完全覆盖 / (c) 退出
- 凭证校验失败 → 给出具体错误（无效 token / socket mode 未开 / scope 不足）
- litellm 不可达 → 允许继续，提示运行 `doctor`

### 5.4 `start` 启动序列

1. 加载配置（环境变量 / .env / config.yaml）
2. 校验必需凭证，缺失则提示运行 `onboard` 并退出
3. `createApplication({ workspaceDir: cwd })` 装配依赖
4. `app.start()` 建立 slack socket 连接
5. 日志输出就绪信息
6. 阻塞等待信号（SIGINT/SIGTERM → graceful shutdown）

### 5.5 `doctor` 检查项

- Node.js 版本 ≥ 22
- `.agent-slack/` 结构完整、`config.yaml` 可解析、`system.md` 存在
- 凭证完整且可用（slack auth.test / litellm /health）
- 目标模型在 litellm 可用
- skills 可加载

---

## 6. 日志 + 错误处理

### 6.1 日志

- 技术：`consola` + redactor（脱敏 `SLACK_BOT_TOKEN`、`SLACK_APP_TOKEN`、`SLACK_E2E_TRIGGER_USER_TOKEN`、`LITELLM_API_KEY`）
- 双写：终端（pretty 彩色，dev/CLI 前台）+ 文件（`logs/YYYY-MM-DD.log`，JSON lines）
- 级别：`trace` / `debug` / `info` / `warn` / `error`；dev 默认 `debug`，生产默认 `info`
- `LOG_LEVEL=trace` 时，`orchestrator` 会额外记录最终发给模型的完整 `systemPromptWithMemory`，用于排查 memory 注入和 system prompt 拼装问题
- 取舍：`trace` 噪音最高，且会把最终 system prompt 正文写入日志；虽然仍经过 redactor 脱敏，但建议只在定位 prompt 相关问题时临时开启
- Tag 分组：`slack` / `slack:render` / `orchestrator` / `agent` / `agent:tool` / `agent:reasoning` / `agent:usage` / `store:session` / `store:memory`

### 6.2 错误三层

| 层级 | 场景 | 处理 |
|---|---|---|
| **Fatal**（启动期） | 缺凭证、config 解析失败、目录权限 | 日志输出原因 + 修复建议 → 退出码 1；`start` 主动引导 `onboard` |
| **Agent Errors**（运行期语义） | AI SDK 失败、模型拒答、tool 执行抛错 | ⚠️ 已被 2026-04-19 spec §8.3 的四层错误归属替换：fullStream 内部 `error` part / 外层 throw 均经 executor emit `lifecycle { failed, error }`；orchestrator 代码级异常走 `emitSyntheticFailed(sink, message)`；sink 不再有独立 `fail()`。UI 仍为"⚠️ 出错 + ❌ reaction" |
| **Recoverable**（运行期瞬态） | Slack API 429 / 超时 / 网络抖动 | `safeRender` 包装所有 Slack API：`logger.warn` 记录，不传播到 orchestrator；AI SDK 内置 retry |

### 6.3 Graceful shutdown

```
SIGINT / SIGTERM
  ├─ 停止 SlackAdapter 接新事件
  ├─ SessionRunQueue.drain(maxWait=30s)
  ├─ abortRegistry.abortAll('shutdown')
  ├─ flush logger
  └─ exit(0)
```

### 6.4 测试策略

- **Unit**：Vitest，每个 core service 一个 `.test.ts`
- **Integration**：mock SlackClient + mock litellm → 跑完整链路
- **Live E2E（手动）**：`pnpm e2e:list` / `pnpm e2e <id>` 启动真实 app，向真实 Slack channel 发消息并轮询 thread 断言；默认不挂到 `pnpm test`

---

## 7. 实施路线图

按"**最小可验证链路 → 渐进增强**"原则拆 7 个阶段：

```
阶段 0: 脚手架
阶段 1: 核心抽象 + 文件系统 Store
阶段 2: AiSdkExecutor + 内置 tools（不接 IM）
阶段 3: SlackAdapter + Orchestrator（MVP） ← 🎯 核心假设验证点
阶段 4: Renderer 丰富度（thinking/tool/cost）
阶段 5: Skills 加载 + 交互完善 + 排队 + abort
阶段 6: CLI + Onboard（最后打包分发）
阶段 7: 二期预留（多 agent、多 IM、memory 检索等）
```

**顺序原因**：CLI + Onboard 是打包分发层，放在交互完善之后，保证 bin 打包出去即具备完整能力；否则先做 CLI 再补交互完善，会出现"有 bin 但功能残缺"的中间版本。

| 阶段 | 产出 | 验证方式 | 粗估 |
|---|---|---|---|
| **0. 脚手架** | package.json / tsconfig / vitest / eslint / prettier / tsdown | `pnpm install && pnpm test` 通过 | 0.5 天 |
| **1. 抽象 + Store** | types；SessionStore；MemoryStore；WorkspaceContext 加载 | Unit tests 全绿 | 1.5 天 |
| **2. AiSdkExecutor** | AI SDK + litellm；内置 8 tools；event 映射；cost 提取 | `pnpm tsx scripts/smoke.ts` 跑通 tool loop | 2 天 |
| **3. Slack MVP** 🎯 | Bolt socket；Adapter；Orchestrator；简化 Renderer | 真 Slack：`@bot hello` 有回复 + 持久化 | 2 天 |
| **4. Renderer 丰富度** | 2.5s thinking；reasoning/tool/cost 渲染；safeRender；reaction | Slack UX 达到截图标准；长回复分块正常 | 2 天 |
| **5. 交互完善** | Skills 加载；/usage；🛑 reaction abort；SessionRunQueue；AbortRegistry | 并发消息按序处理；🛑 能中断 | 1.5 天 |
| **6. CLI + Onboard** ✅ | bin；commander；@clack/prompts；onboard/start/status/doctor | 另一个目录 `agent-slack start` 能服务那个目录 | 1.5 天 |

**MVP（阶段 0–3 完成）**：约 6 天工作量。

### 7.1 关键里程碑

- 🎯 **M1（阶段 3 末）**：`@mention` 能收到回复，消息历史正确持久化——**最关键的跨越**（litellm + AI SDK + slack 三方同时碰头，越早发现兼容性问题越好）。
- 🎯 **M2（阶段 4 末）**：丰富度 UX 达成（thinking、tool-use、cost）。⚠️ M2 原 plan `plans/2026-04-18-M2-renderer.md` 已作废；当前权威 plan 见 [`plans/2026-04-19-M2-renderer.md`](../plans/2026-04-19-M2-renderer.md)，设计源自 [`specs/2026-04-19-slack-render-flow-redesign.md`](./2026-04-19-slack-render-flow-redesign.md)
- 🎯 **M3（阶段 5 末）**：skills / 并发 / cancel 完整，功能闭环
- 🎯 **M4（阶段 6 末）** ✅：脱离 `pnpm dev`，bin 可分发，进入二期准备

### 7.2 阶段 7 二期范围

一期不设计细节，仅保留扩展点：

- **多 agent provider**：基于 `AgentExecutor` 接口的 `OpenAiAgentsSdkExecutor` / `ClaudeCodeCliExecutor` / `CodexCliExecutor`
- **多 IM 适配**：基于 `IMAdapter` 接口的 `TelegramAdapter`
- **Memory 检索增强**：ripgrep 封装 tool 或可选的向量索引
- **多 workspace 切换**：在 `config.yaml` 声明多个 workspace 或引入 `global.yaml` 的 workspace 注册表
- **E2E 场景扩展**：在现有 live runner 上按需迁移更多 kagura 场景

---

## 8. 技术依赖清单

| 包 | 用途 | 备注 |
|---|---|---|
| `ai` | Vercel AI SDK 核心 | 流式 agent loop |
| `@ai-sdk/openai-compatible` | 接 LiteLLM | OpenAI 兼容 provider |
| `@slack/bolt` | Slack SDK | socket mode |
| `markdown-to-slack-blocks` | 长消息分块 | 官方推荐 |
| `consola` | Logger | app 同款 |
| `commander` | CLI 命令解析 | 成熟稳定 |
| `@clack/prompts` | 交互式问答 | onboard 向导 |
| `dotenv` | `.env` 加载 | 标准方案 |
| `yaml` | 解析 `config.yaml` | |
| `gray-matter` | 解析 SKILL.md frontmatter | |
| `zod` | tool schema / 配置校验 | AI SDK 原生支持 |
| `vitest` | 单元测试 | app 同款 |
| `tsdown` | 打包 | app 同款 |
| `eslint` / `prettier` / `typescript` | 代码质量 | |

---

## 9. 与 app 的对照与差异

**借鉴自 app**：

- DI 容器模式（`createApplication()`）
- Zod 环境变量校验
- Slack handler 分组（ingress / commands / interactions）
- SlackRenderer 的 2.5s thinking rotation + 文案池
- `safeRender` 容错包装
- context block 展示 cost/usage
- `splitBlocksWithText` 长消息分块
- consola + redactor 日志
- 👀 / ✅ / ❌ reaction 协议
- 🛑 reaction 触发 abort

**主动偏离 app**：

| 维度 | app | agent-slack | 原因 |
|---|---|---|---|
| 存储 | SQLite + Drizzle | 全 Files（JSON/JSONL/MD） | Agent 原生索引友好、用户可直接读写、git 可 version |
| Agent 基座 | Claude Agent SDK | Vercel AI SDK + LiteLLM | 统一模型层代理、多 provider 自由切换 |
| Workspace | REPO_ROOT_DIR 扫描多 repo | 单进程绑定 cwd | YAGNI、简化一期 |
| IM 抽象 | Slack 深度耦合 | IMAdapter 接口先行 | 多 IM 扩展不返工 |
| Agent 抽象 | 已有 ProviderRegistry 但只一份实现 | 同样 registry，未来加 provider 无结构改动 | 对齐 |
| 探针机制 | FileClaudeExecutionProbe 等 | 不做 | 过度设计，logs 够用 |
| E2E 框架 | packages/live-cli | 已引入 live runner，覆盖 basic-reply / rich-text-blocks / tool-progress / save-memory / thread-session-resume | 控制范围，避免迁入 kagura 专有 Claude/SQLite 依赖 |

---

## 10. 待决事项（可在实施期确认）

- **LiteLLM cost 的具体读取路径**：实测 `providerMetadata.litellm` 或 response header，定型字段名
- **内置 tool 的精确参数**：实现时参照 Claude Code / Cursor 的标准签名
- **`meta.json` 字段的稳定版本号**：引入 `schemaVersion`，便于未来迁移
- **Skills 加载顺序**：一期按字母序；未来考虑 `priority` 字段

---

## 11. 附录

### 11.1 名词表

- **Workspace**：agent-slack 进程绑定的项目目录（= `process.cwd()`）
- **Session**：一次 slack thread 对应的会话，`sessionId = imProvider + channelId + threadTs`
- **Memory**：跨 session 的长期记忆，存为 markdown 文件
- **Skill**：以 `SKILL.md` 形式提供的自然语言指令增强（一期只进 system prompt，不引入 tool）
- **Agent Provider**：Agent 基座实现（一期仅 `AiSdkExecutor`）
- **IM Adapter**：IM 入口实现（一期仅 `SlackAdapter`）

### 11.2 参考

- app 仓库本地路径：`/Users/moego-winches/Desktop/Company/AI-Agent/agent-slack/app`
- Vercel AI SDK：https://ai-sdk.dev
- LiteLLM：https://docs.litellm.ai
- Slack Bolt JS：https://tools.slack.dev/bolt-js
