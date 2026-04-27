# Slack Multi-Agent 协作设计

**日期**：2026-04-27
**状态**：设计中（待评审 → P0 plan）
**关联**：
- [`2026-04-17-agent-slack-architecture-design.md`](./2026-04-17-agent-slack-architecture-design.md)
- [`2026-04-22-daemon-design.md`](./2026-04-22-daemon-design.md)
- [`2026-04-26-slack-channel-task-listener-design.md`](./2026-04-26-slack-channel-task-listener-design.md)

## 1. 背景与目标

现状：agent-slack 是单 Agent 形态，一个 `cwd` 对应一个 Slack bot 身份，所有任务由同一个 Agent 处理。`ConversationOrchestrator` / `SessionStore` / `SlackAdapter` 都按"单 thread 单 agent"假设组装。

新需求：在 Slack 中跑一个三角色的 Agent 协作矩阵 —— **PM**（用户代理 / 默认全能 Agent）、**Coding**（深度 repo 修改 / 测试）、**CS**（多源排障，跨 jira / sentry / datadog / redshift / slack 历史等）。三者各自有独立 Slack App 身份，可被用户分别 @；同一 thread 内可以多发言；当用户 @ PM 给目标时，PM 自主规划、必要时派发任务、替用户在 Agent-to-Agent 决策路口拍板，直至目标达成。

### 目标

- 三个独立 Slack App 身份（`@pm` / `@coding` / `@cs`）共用单 Runtime（一个 daemon 进程），文件态存储，无新数据库依赖。
- 拓扑：默认 PM 当 conductor；用户可直接 @ 任一角色拉到前台；同 thread 多个 Agent 都能发言。
- A2A 协议：typed envelope + handoff 作为 tool call（`delegate_to`）+ 文件态 task 黑板。
- PM = 用户代理：默认自闭环；遇到必须的高门槛专项才 delegate；其他 Agent 反问时 PM 自主决策；只有真正不可决策事项才 `escalate_to_user`。
- 单 / Multi 两种模式 schema 完全统一（`agents[]` 数组），onboard 时选；提供 `agent-slack upgrade --to=multi|single` CLI 升级/降级。
- 工具与 skills 全部全局共享，三个 Agent 装配完全一致；唯一差异是 system prompt + Slack 身份 + session 命名空间。
- 单 Agent 模式向后兼容：现有用户启动时旧 `agent.*` 字段自动迁移成 `agents:[{ id: 'default', role: 'generic' }]`，行为等同今天。

### 非目标（v1 不做）

- 真正的 Agent 间并行（v1 串行 handoff；SubAgent 仅作为单 Agent 内部并行手段，不是必需）。
- RAG / 向量检索（按需 grep + git log + repo CLAUDE.md 即可）。
- PM 长期产品记忆（业务知识全部走 feishu skill 即查即用）。
- Approval gate / wall-clock 上限 / 审批超时（用户已明确不做）。
- 自动合 PR（人工合）。
- SQLite 或任何新数据库（task 黑板与 envelope 全部文件态）。
- 跨 thread 自动接续（一个 thread = 一个 task；新 thread 重新开）。

## 2. 核心决策

| 决策项 | 方案 | 理由 |
|---|---|---|
| Schema 形态 | 单 / Multi 共用 `agents[]` 数组（单 Agent = 长度 1） | 一套代码路径；升级路径平滑；老 config 启动时自动迁移 |
| Slack 身份 | 每个 Agent 一个独立 App（独立 bot/app/signing 凭证） | 用户能直接 @ 角色；同 thread 三个 bot 各自发言；权限边界天然清晰 |
| Runtime | 单 daemon 进程承载 N 个 SocketMode client | 共享 dashboard / sessions / memory / channel-tasks 基础设施 |
| 工具 / Skill | 全部全局共享，三 Agent 装配一致 | 不做 per-agent tool subset；差异仅在 system prompt |
| A2A 协议 | typed envelope + `delegate_to` tool + 文件态 task 黑板 | 结构化外壳便于观测；自然语言 content 便于推理；文件存储符合"无新数据库"约束 |
| Loop 终止 | PM 自己宣布 `<final/>`；不限 hop / 不限时长 | 用户明确要求 PM 最大 loop 完成任务 |
| 用户代理语义 | PM 默认自闭环；只有专项高门槛才 delegate；反问由 PM 自主决策；`escalate_to_user` 是兜底 | 用户核心诉求："PM 替用户发言、查资料、做决策" |
| 进度可见性 | 每次 delegate / 自闭环关键节点在 thread 短消息（caveman 风） | 用户在场围观但不参与，避免 Slack 噪音 |
| 工作区隔离 | per-task git worktree（沿用现有 cwd 概念，每个 task 独立 worktree） | 多人并发触发不互相破坏；用户已确认 |
| 持久化 | 全部文件态 | 用户明确要求不引入 SQLite |
| 单 Agent 兼容 | 旧 `agent.*` 字段启动时自动迁移成 `agents:[{ id:'default', role:'generic' }]` | 0 破坏老用户；老 .env 中无后缀 SLACK_* 仍可用 |
| 升级 CLI | `agent-slack upgrade --to=multi|single` 幂等 + dry-run + 失败回滚 | 用户从 single 升 multi 不必手改 yaml |
| 审批 | 不做 | 用户明确"想干嘛干嘛，PR 由人合" |

## 3. 工作区文件布局

### 3.1 单 Agent 模式（onboard 选 single）

```
.agent-slack/
├── config.yaml                  # agents:[{ id:'default', role:'generic', ... }]
├── system.md                    # 唯一 system prompt
├── experience.md                # self-improve 沉淀（沿用）
├── channel-tasks.yaml           # 沿用；默认接收方=数组首项
├── channel-tasks/triggers.jsonl # 沿用
├── sessions/slack/
│   └── <channel>.<id>.<threadTs>/
│       └── default/messages.jsonl   # ★ 路径多一层 agentId='default'
├── memory/*.md                  # workspace 全局，沿用
├── skills/                      # workspace skills，沿用
├── logs/agent-YYYY-MM-DD.log
└── daemon/{daemon.json,daemon.pid,daemon.lock,dashboard.json}
```

`tasks/` 目录在单 Agent 模式下不写（A2A 退化为 no-op）。

### 3.2 Multi-Agent 模式（onboard 选 multi）

```
.agent-slack/
├── config.yaml                  # agents:[pm, coding, cs]
├── system.md                    # base prompt（共享前缀）
├── system.pm.md                 # ★ 新增：PM role overlay
├── system.coding.md             # ★ 新增：Coding role overlay
├── system.cs.md                 # ★ 新增：CS role overlay
├── experience.md                # 三 Agent 共享
├── channel-tasks.yaml           # 可选 agent 字段，未填默认 PM 接
├── channel-tasks/triggers.jsonl
├── sessions/slack/
│   └── <channel>.<id>.<threadTs>/
│       ├── pm/messages.jsonl
│       ├── coding/messages.jsonl
│       └── cs/messages.jsonl
├── tasks/                       # ★ 新增：A2A 文件态
│   └── <task_id>/
│       ├── task.json            # 任务黑板（事实+决策）
│       └── envelopes/<env_id>.json  # A2A 消息流水
├── memory/*.md                  # workspace 全局
├── skills/                      # workspace 全局
├── logs/agent-YYYY-MM-DD.log    # 增加 agent= 字段
└── daemon/
    ├── daemon.json              # 新增 agents:[{id,botUserId,status}]
    ├── daemon.pid|lock
    └── dashboard.json
```

### 3.3 env 约定

**单 Agent**（沿用今天）：
```
SLACK_BOT_TOKEN
SLACK_APP_TOKEN
SLACK_SIGNING_SECRET
LITELLM_BASE_URL / LITELLM_API_KEY  或  ANTHROPIC_API_KEY
```

**Multi-Agent**（每个 Agent 一组带后缀；后缀 = 大写 agent.id）：
```
SLACK_BOT_TOKEN_PM       SLACK_APP_TOKEN_PM       SLACK_SIGNING_SECRET_PM
SLACK_BOT_TOKEN_CODING   SLACK_APP_TOKEN_CODING   SLACK_SIGNING_SECRET_CODING
SLACK_BOT_TOKEN_CS       SLACK_APP_TOKEN_CS       SLACK_SIGNING_SECRET_CS
```

provider 凭证（LiteLLM/Anthropic）三 Agent 共用一组。`config.yaml` 里每个 agent 的 `slack.botTokenEnv` 字段显式声明用哪个 env key，便于自定义命名。

## 4. config.yaml schema

```ts
interface WorkspaceConfig {
  agents: AgentConfig[]                    // ★ 数组，长度 ≥ 1
  skills: { enabled: string[] }            // 全局，沿用
  im: { provider: 'slack'; slack: { ... } }
  daemon: { port: number; host: string }
}

interface AgentConfig {
  id: string                               // 'default' | 'pm' | 'coding' | 'cs'，
                                           // 同时是 sessions 路径片段、env 后缀来源
  role: 'generic' | 'pm' | 'coding' | 'cs' // 决定加载哪个 system overlay
  model: string                            // 各自模型可不同
  maxSteps: number
  context: ContextConfig                   // 沿用现有结构
  slack: {
    botTokenEnv: string                    // env 变量名
    appTokenEnv: string
    signingSecretEnv: string
  }
}
```

**自动迁移**（启动时一次性）：
- 检测到旧顶层 `agent.*` 字段时，转换为 `agents:[{ id:'default', role:'generic', model: agent.model, maxSteps: agent.maxSteps, context: agent.context, slack: { botTokenEnv:'SLACK_BOT_TOKEN', appTokenEnv:'SLACK_APP_TOKEN', signingSecretEnv:'SLACK_SIGNING_SECRET' } }]`
- 旧 yaml 备份到 `config.yaml.bak.<timestamp>`，新 yaml 写回原位
- 老 sessions 目录 `sessions/slack/<thread>/messages.jsonl` 自动 `mv` 到 `sessions/slack/<thread>/default/messages.jsonl`
- 迁移记录追加到 `logs/migration.log`

## 5. A2A 协议

### 5.1 Envelope（在内存总线流转 + 落 `tasks/<id>/envelopes/<env_id>.json`）

```ts
interface A2AEnvelope {
  id: string                  // 'env_' + ulid
  taskId: string              // 'tsk_' + ulid，一个 thread 一个 task
  from: 'user' | 'pm' | 'coding' | 'cs'
  to: 'pm' | 'coding' | 'cs' | 'thread'  // 'thread' = 公开发言到 Slack
  intent: 'delegate' | 'reply' | 'broadcast' | 'final'
  parentId?: string           // 回复哪个 envelope
  content: string             // 自然语言
  references?: Array<{
    kind: 'file' | 'url' | 'session' | 'envelope'
    value: string
  }>
  createdAt: string           // ISO
}
```

### 5.2 Handoff = tool call

所有 Agent 共享两个 tool：

```ts
delegate_to(agent: 'pm' | 'coding' | 'cs', content: string, references?: Reference[])
  → { envelopeId: string, status: 'queued' }

escalate_to_user(reason: string)            // PM 专属（system prompt 约束，不在工具层强制）
  → { status: 'escalated' }
```

`delegate_to` 行为：
1. 校验 `agent !== self`
2. 写入 envelope 文件
3. 投递到内存 A2A bus
4. **当前 Agent 的 turn 此处返回（不阻塞）**：当前 Agent 继续输出 `<waiting/>` 标记，runtime 暂停该 Agent 的下一轮 step，直到收到 `reply` envelope 或被 abort

`escalate_to_user` 行为：
1. 在 thread 里 @ 原始用户发问
2. task state → `awaiting_user`
3. 用户回复后，runtime 把回复打包成 `from: 'user', to: 'pm'` envelope 投递

### 5.3 task 黑板（`task.json`）

```ts
interface TaskBoard {
  taskId: string
  threadTs: string
  channelId: string
  originalUser: string                   // Slack uid
  goal: string                           // 一句话目标摘要
  state: 'active' | 'awaiting_agent' | 'awaiting_user' | 'done' | 'aborted'
  activeAgent: 'pm' | 'coding' | 'cs' | null
  worktreePath?: string                  // Coding 工作时的 git worktree 绝对路径
  createdAt: string
  updatedAt: string
  scratchpad: {
    facts: string[]                      // 各 Agent 查到的关键事实
    decisions: string[]                  // PM / 其他 Agent 已确定的决策
    openQuestions: string[]              // 当前悬而未决的问题
  }
}
```

**写规约**：
- 每次 turn 开头读一次 `task.json` 注入到 system prompt 上下文（短，不会爆）
- 每次 turn 结尾允许 Agent 通过 `update_task_board` tool 追加 facts / decisions
- 文件锁：写时 `task.json.lock`；读不加锁（最终一致足够）

### 5.4 Loop 终止

- PM 输出 envelope `intent: 'final'` 且 `to: 'thread'` 时，task state → `done`
- 没有 hop 上限 / 时长上限（用户决策）
- 用户主动 abort（`stop` / 反应停止 emoji）→ 透传到所有正在跑的 Agent，state → `aborted`

## 6. 模块改动 diff

### 6.1 新增模块

| 路径 | 职责 |
|---|---|
| `src/multiAgent/A2ABus.ts` | 内存 envelope 投递 + 文件落盘 |
| `src/multiAgent/TaskBoard.ts` | task.json 读写 + 文件锁 |
| `src/multiAgent/WorktreeManager.ts` | per-task git worktree 创建/复用/清理 |
| `src/multiAgent/RolePromptLoader.ts` | system.md + system.<role>.md 拼装 |
| `src/multiAgent/migrateConfig.ts` | 老 `agent.*` → `agents:[]` 自动迁移 |
| `src/agent/tools/delegateTo.ts` | `delegate_to` tool 实现 |
| `src/agent/tools/escalateToUser.ts` | `escalate_to_user` tool 实现 |
| `src/agent/tools/updateTaskBoard.ts` | `update_task_board` tool 实现 |
| `src/cli/commands/upgrade.ts` | `agent-slack upgrade --to=...` |

### 6.2 修改模块（按风险分级）

**🟡 低-中风险（向后兼容扩展）**

- [`src/workspace/config.ts`](../../../src/workspace/config.ts)：`ConfigSchema` 改为 `agents: z.array(AgentConfigSchema)`；保留 `agent: z.object({...}).optional()` 触发自动迁移
- [`src/workspace/paths.ts`](../../../src/workspace/paths.ts)：`slackSessionDir` 增加 `agentId` 参数；新增 `taskDir` / `envelopeFile` / `taskBoardFile` 函数
- [`src/store/SessionStore.ts`](../../../src/store/SessionStore.ts)：key 增加 `agentId` 维度；缺省 `'default'`
- [`src/im/slack/SlackAdapter.ts`](../../../src/im/slack/SlackAdapter.ts)：增加 `agentId` 参数；application 层为每个 agent 实例化一份
- [`src/cli/commands/onboard.ts`](../../../src/cli/commands/onboard.ts)：交互流加"选模式"步；multi 时分别问三套凭证

**🔴 中-高风险（核心重构）**

- [`src/orchestrator/ConversationOrchestrator.ts`](../../../src/orchestrator/ConversationOrchestrator.ts)：
  - sessionKey / runQueue / abortRegistry key 增加 `agentId`
  - 新增 A2A 接收循环：投递到该 Agent 的 envelope 排队，与 Slack 来的 InboundMessage 共用同一 SessionRunQueue
  - `systemPrompt` 从单 string 变成按 agentId 选择（由 RolePromptLoader 提供）
  - 现有 42KB 测试套件全部需重跑：先把所有 fixture 默认 `agentId='default'` 跑通，再加 multi-agent 用例
- [`src/orchestrator/MentionCommandRouter.ts`](../../../src/orchestrator/MentionCommandRouter.ts)：
  - 入口判定：哪个 botUserId 被 mention → 路由到哪个 agent
  - PM 收到 mention 时启动新 task（写 task.json）；其他 agent 直接 mention 时继承现有 thread 的 task 或新建
- [`src/application/createApplication.ts`](../../../src/application/createApplication.ts)：
  - 从实例化 1 个 SlackAdapter → 循环 `agents` 实例化 N 个
  - 单 Agent 模式 N=1，行为等同今天
  - A2ABus / TaskBoard / WorktreeManager 注入到 orchestrator
- [`src/dashboard/`](../../../src/dashboard/)：
  - 新增 `/api/agents` 列出三个 agent 状态（pid 不分开但 botUserId / 在跑 task 数 / 累计 token）
  - 新增 "Multi-Agent Thread" tab：列 task → 展开看 envelope 时间线
  - sessions tab 增加 agentId 列与过滤器
- [`src/cli/commands/daemon.ts`](../../../src/cli/commands/daemon.ts)：日志/状态展示增加 per-agent 维度

### 6.3 不受影响

- `memory/` 全局共享，机制不动
- `skills/` 全局，三 Agent 共用
- `experience.md` 三 Agent 共享
- `channel-tasks.yaml` 不强制加 `agent` 字段；不加默认 PM 接（multi）/ default 接（single）
- LiteLLM / Anthropic provider 装配
- ContextCompactor / SelfImprove agents 单实例共享
- 现有 tools（grep / read file / edit file / git log 等）

## 7. PM / Coding / CS 角色定义

### 7.1 PM（默认 / 用户代理）

**核心定位**：用户的代理。用户给目标后退场，PM 负责把它做完。

**system prompt 关键段**：
```
你是用户的代理。用户给目标后退场，你负责把它做完。

默认行为：你自己干。包括但不限于：
- 业务问答 / thread 总结 / 查 feishu 业务文档
- 帮查用户数据并导出
- 填报表 / 跑脚本 / 操作内部系统
- 看代码答疑 / 排查思路梳理
- 任何没有明确归属其他 Agent 的任务

仅当任务命中以下两类高门槛场景，才 delegate：
1. 多源排障（同时要交叉查 jira / sentry / datadog / redshift / slack 历史等）
   → delegate_to('cs', ...)
2. 写代码 / 跑测试 / 深度 repo 修改
   → delegate_to('coding', ...)

决策路口被 coding/cs 反问 → 自己决策。必要时先查 feishu / 看 thread / 看 task 黑板。
只有 ① 需要凭证或外部权限 ② 决策严重偏离原始目标 ③ 多方案利弊相当且都有重大代价
才 escalate_to_user。

发到 thread 的消息要短而精，按 caveman 风格只发重点：
- 自闭环：'PM ✓ <结论>'
- 派发：'PM → CS：<task>' / '← CS：<result>'
- 收尾：'✓ 目标达成：<总结>'
```

### 7.2 Coding

**核心定位**：深度 repo 修改 / 测试 / git 操作专家。改完不合 PR，由人工合。

**system prompt 关键段**：
```
你负责深度 repo 修改与测试。每个任务在独立 git worktree 跑。

遇到边界不清 / 需求模糊 / 方案分叉时，绝对不要自己拍脑袋。
调用 delegate_to('pm', question)，等 PM 回复后再继续。
PM = 用户。PM 的回复 = 用户的话。

完成后产出 PR / patch 给 PM 收尾，由人工合。

你需要哪些上下文先看 task 黑板（task.json 的 facts/decisions），不要重复问。
```

### 7.3 CS

**核心定位**：多源排障专家，跨 jira / sentry / datadog / redshift / slack 历史交叉查证。

**system prompt 关键段**：
```
你负责多源排障。skill 里已有 jira / sentry / datadog / redshift / slack-search 等检索能力。

接到任务先看 task 黑板（避免重复查），然后并发跨源查证，给出：
- 最可能的根因（带证据链）
- 涉及代码位置（文件:行）
- 对修复的建议范围

遇到决策点（这是不是同一个问题 / 该不该继续追下去）时，
delegate_to('pm', question)。PM = 用户。

不要做长篇大论。每次 reply envelope 给 PM 只发结论 + 关键证据。
```

## 8. CLI 改动

### 8.1 onboard

[`src/cli/commands/onboard.ts`](../../../src/cli/commands/onboard.ts) 交互流增加：

```
? 选择 Agent 模式
  ▶ Single Agent       — 一个 bot，简单场景
    Multi-Agent (PM+Coding+CS) — 三个 bot 协作，需准备 3 套 Slack App 凭证
```

- 选 Single：原有流程，写出 `agents:[{ id:'default', role:'generic', ... }]` + 一份 `system.md`
- 选 Multi：分别问 3 套 SLACK_*_<ROLE> 凭证 → 写 `.env` → 写 `config.yaml` (agents 长度 3) → 生成 `system.md` + `system.pm.md` + `system.coding.md` + `system.cs.md` 模板

### 8.2 upgrade

新增 [`src/cli/commands/upgrade.ts`](../../../src/cli/commands/upgrade.ts)：

```bash
agent-slack upgrade                # 自动检测当前模式提供选项
agent-slack upgrade --to=multi     # single → multi
agent-slack upgrade --to=single    # multi → single（保留 PM 配置作为 default）
agent-slack upgrade --to=multi --dry-run    # 只打印改动
agent-slack upgrade --to=multi --keep-system  # 保留现有 system.md，不覆盖
```

**`--to=multi` 步骤**：
1. 校验当前是 single（agents 长度 1）
2. 备份：`cp config.yaml config.yaml.bak.<ts>`
3. 交互问 3 套 Slack 凭证（可选；跳过则只更新 yaml + 在 `.env.example` 加占位）
4. 生成 `system.<role>.md` 模板（如已存在跳过）
5. 重写 `config.yaml`：`default` agent 配置作为 PM 初值（model/maxSteps/context），新增 coding/cs 项
6. sessions 不动（历史会话保留在 `default/`）
7. 打印下一步：填 .env → `agent-slack doctor` → `agent-slack start`

**失败回滚**：任何写文件失败立即恢复 .bak。

**幂等**：重复跑同一升级命令应该 no-op（检测到目标态已存在时直接退出）。

### 8.3 doctor

[`src/cli/commands/doctor.ts`](../../../src/cli/commands/doctor.ts) 增加：
- 校验 `agents[]` 长度与对应 SLACK_*_<role> env 是否齐全
- 校验 `system.<role>.md` 文件存在性（缺则给模板生成命令提示）

## 9. Slack 交互层

### 9.1 多 SocketMode client

`createSlackAdapter` 在 application 层被调用 N 次，每次传不同的 `agentId` + `botToken/appToken/signingSecret`。每个 adapter 各自起一个 SocketMode client，事件分发到自己 agent 的 ConversationOrchestrator 实例。

### 9.2 Mention 路由

`MentionCommandRouter`：
- 当 `app_mention` 事件中的 `bot_user_id == agents[i].botUserId`，路由到 agent[i]
- 同 thread 多 mention 同步多 agent（v1 不并发，依次入队）
- 进入 thread 时如尚无 task，则该 mention 创建 task；后续 thread 内的 mention 复用同 task

### 9.3 Thread 拓扑

- 每个 Agent 用自己的 bot 身份发消息（Slack 自动用各自 bot 头像/名称区分）
- A2A 内部消息（envelope）**不发到 Slack**；只有 PM 的进度短消息和最终回复发到 thread
- Coding / CS 的中间过程不发 thread，只通过 envelope 回 PM；PM 决定发什么到 thread

### 9.4 直接 @ 某 Agent

`@coding 在 repo X 里 grep 一下 foo` → 直接路由到 Coding agent；不创建 task（除非 thread 里已有）；行为等同直接对话，不走 A2A。

### 9.5 进度短消息（caveman 风）

PM 在以下时刻发 thread 短消息：
- 收到目标后立刻：`PM 收到目标：<goal>`
- delegate 时：`PM → CS：<one line task>`
- 收 reply 时：`← CS：<one line result>`
- 自闭环关键节点：`PM ✓ <一行结论>`
- 收尾：`✓ 目标达成：<总结>`

## 10. live e2e

### 10.1 既有 e2e 回归

- [`src/e2e/live/`](../../../src/e2e/live/) 现有所有用例必须在新 schema 下绿
- e2e helper 的 fixture 改成 `agents:[{ id:'default', role:'generic' }]`
- session 路径断言从 `sessions/slack/<thread>/messages.jsonl` 改为 `sessions/slack/<thread>/default/messages.jsonl`

### 10.2 新增 multi-agent 场景（最少 3 个）

| 场景 | 描述 | 断言 |
|---|---|---|
| **目标分发链路** | 测试号 `@PM 帮我查 channel#x 上周报错` → PM delegate CS → CS 调 skill 返回 → PM 在 thread 收敛 | (a) `tasks/<id>/envelopes/` 含至少 3 条 envelope（pm→cs delegate / cs→pm reply / pm→thread final）；(b) thread 最终回复来自 PM bot；(c) `task.json.state == 'done'` |
| **跨 agent 决策** | `@PM 修复 repo 里那个 bug` → PM delegate Coding → Coding `delegate_to('pm','改这个会影响 module Y, 是否继续')` → PM 自主决策回复 → Coding 完成 patch | (a) envelope 序列含 pm→coding / coding→pm / pm→coding / coding→pm；(b) PM 在被反问时 30s 内回复（不卡用户）；(c) Coding 工作目录在独立 worktree |
| **直接点名某 agent** | `@coding 在 repo X 里 grep 一下 foo` → Coding 直接接，PM 不参与 | (a) 不创建 task（或只创建一个 standalone session）；(b) 没有 envelope 文件；(c) thread 回复来自 Coding bot |

### 10.3 e2e 凭证

- `.env.e2e.example` 增加三套 SLACK_*_<role>
- `src/e2e/live/cli.ts` 增加 `--mode=single|multi` 选项
- multi 模式 e2e 在测试 workspace 用 onboard 一键生成（避免手工配置）

## 11. dashboard 改动

- 新增 `/api/agents`：列出 agents 配置 + 每个 agent 当前 inflight session 数 + 累计 usage
- 新增 `/api/tasks`：列出最近 N 个 task（含 active/done/aborted）
- 新增 `/api/tasks/:id`：返回 task.json + envelope 列表
- 新增 "Multi-Agent Thread" tab：task 列表 → 选中后展开 envelope 时间线（按 createdAt 排序，标注 from→to + intent）
- sessions tab 增加 agentId 列 + 按 agent 过滤
- overview tab 在 cards 行增加 "Active Agents" / "Active Tasks" 卡片

单 Agent 模式下 `/api/tasks` 返回空数组；"Multi-Agent Thread" tab 仍显示但提示"single mode"。

## 12. 单 Agent 回归测试清单

`ConversationOrchestrator` 重构后必须验证以下行为完全等同今天：

- [ ] 单 mention 触发 → 单 turn 完整跑完 → Slack 回复
- [ ] 多轮 thread 对话 → session 持久化正确（路径多了 `default/` 一层）
- [ ] channel-tasks 触发 → agent run + 回复
- [ ] context compact 在 maxApproxChars 触达后正常压缩
- [ ] abort（stop / reaction）能中止当前 turn
- [ ] memory 工具 / skill 调用结果与今天一致
- [ ] dashboard sessions / overview / logs / config / channel-tasks tab 正常
- [ ] daemon start/stop / abort routes 正常
- [ ] 老 `agent.*` 配置自动迁移：迁移后行为等同今天，备份文件存在

每条对应至少一个 unit test 或 e2e。

## 13. 子项目拆分（按依赖顺序）

| # | 子项目 | 单位价值 | 关键产出 |
|---|---|---|---|
| **P0** | **Multi-Agent Runtime** | 两个 Agent（PM + Coding）能跑通一次完整 A2A 来回 + worktree | A2ABus / TaskBoard / WorktreeManager / `delegate_to` / `escalate_to_user` / `update_task_board` tool / config 自动迁移 / ConversationOrchestrator 重构（单 Agent 回归通过） |
| **P1** | **Slack 接入层** | Slack 里能 @ 任一 Agent + thread 多发言 + 直接拉某 Agent 前台 + 进度短消息 | 多 SocketMode client / MentionCommandRouter agent 路由 / 进度短消息发送器 / onboard 模式选择 / upgrade CLI |
| **P2** | **三角色装配** | 三个 Agent 能各自跑端到端业务 | system.<role>.md 模板（PM/Coding/CS）/ RolePromptLoader / CS 现有 skills 接入引导 / Coding 的 grep+git+CLAUDE.md 工具引导 / PM 的 feishu skill 接入 |
| **P3** | **观测与 live e2e** | 运维可见 + 回归保底 | dashboard `/api/agents` `/api/tasks` 路由与 tab / 单 Agent 回归 e2e 全绿 / 3 个 multi-agent live e2e 场景 |

每个子项目走自己的 spec → plan → 实施。最早能在 Slack 看到价值：**P0 + P1 + P2 一个最小 happy path（PM 收到问题 → delegate Coding → Coding 提 patch → PM 在 thread 收尾）**。

P3 不阻塞上线，但作为发布前的回归 gate。

## 14. 风险与注意事项

1. **ConversationOrchestrator 重构是最大风险**。建议 P0 第一步：把 sessionKey/runQueue/abortRegistry 加 agentId 维度并让现有 42KB 测试在 `agentId='default'` 下全绿，再加 multi-agent 路径。
2. **Slack 限流**：3 个 bot 同 thread 频繁发言会触限。缓解：进度短消息合并连续节流；A2A 过程不发 thread。
3. **A2A 文件增长**：每条 envelope 一个文件，长 task 会很多。缓解：dashboard `/api/tasks` 默认只列最近 30 天；老 task 保留但不索引。
4. **task.json 并发写**：同一 task 内 PM 与 Coding 同时跑（虽然 v1 串行）时仍可能同时 update_task_board。用 file lock + retry。
5. **worktree 清理**：每个 task 一个 worktree，长期不清会膨胀。task state → done/aborted 后异步清理（保留 N 天再删）。
6. **凭证管理**：`.env` 中 9 个 Slack 变量容易写错。`agent-slack doctor` 必须给清晰的"哪个 env 缺/错"提示。
7. **PM 死循环**：用户决策不限 hop。极端情况 PM 自我反问可能死循环。**靠 system prompt 自律**（明确写"不要自我反问，直接决策"）；不加硬限。
8. **单 Agent 用户的迁移阵痛**：自动迁移虽然透明，但 sessions 路径变化可能让外部脚本失效。CHANGELOG 必须显著标注。

## 15. 待评审 / 后续

- 评审通过后开 P0 plan：`docs/superpowers/plans/2026-04-XX-multi-agent-runtime-plan.md`
- P0 完成 + 单 Agent 回归 e2e 全绿后开 P1
- P3 作为发布前 gate；3 个 live e2e 场景全绿才算 multi-agent 能上线
- 后续可能演进（不在 v1 范围）：
  - 真正并行（多 Agent 同时跑）
  - per-agent budget / token 告警
  - per-agent memory namespace
  - 跨 thread task 接续
  - 自动合 PR（Coding 自主合或半自动）
