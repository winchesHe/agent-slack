# Slack 频道任务监听设计

**日期**：2026-04-26  
**状态**：已实现（Chunk 1-4 已完成并验证）  
**关联**：[`2026-04-17-agent-slack-architecture-design.md`](./2026-04-17-agent-slack-architecture-design.md)、[`2026-04-22-daemon-design.md`](./2026-04-22-daemon-design.md)

## 1. 背景与目标

当前 Slack 入口以 `app_mention` 为主：用户必须在频道或 thread 中 @bot，`SlackAdapter` 才会构造 `InboundMessage` 并交给 `ConversationOrchestrator`。新的使用场景需要 agent 主动监听某些频道里的普通消息或 bot 消息：当消息来源命中配置规则时，agent 自动执行指定任务，并在触发消息所属 thread 里回复。

目标：

- 监听指定 Slack 频道中的 `message` 事件。
- 支持匹配 user message，也支持匹配 bot message。
- 命中规则后，把固定任务 prompt 和原始消息组合为一次 agent 输入。
- 复用现有 `ConversationOrchestrator`、`SessionRunQueue`、`SlackEventSink`、上下文压缩、usage、终态渲染能力。
- 配置独立于 `.agent-slack/config.yaml`，作为可选文件存在；文件缺失时功能完全关闭。
- 配置文件模板包含中文注释，并可通过 dashboard 管理。

非目标：

- 不引入数据库、ORM 或远程配置中心。
- 不做多 workspace 调度；仍然是一进程绑定一个 `cwd`。
- 不在本阶段实现复杂工作流编排；命中规则后只启动一次主 agent run。
- 不把频道监听任务做成主 agent tool；这是 IM 入口能力，不由模型自主调用。

## 2. 核心决策

| 决策项 | 方案 | 理由 |
|---|---|---|
| 配置位置 | `.agent-slack/channel-tasks.yaml` | 独立可选，避免主 `config.yaml` 膨胀；适合 dashboard 单独管理 |
| 默认状态 | 文件缺失或 `enabled: false` 时关闭 | 避免无意监听频道消息 |
| 配置注释 | onboard/dashboard 生成带中文注释的 YAML 模板 | 降低手写配置成本 |
| 消息入口 | Slack `message` event handler | 可覆盖 user message 与 bot message |
| 执行方式 | 构造 `InboundMessage` 后复用 `ConversationOrchestrator.handle()` | 保持会话、工具、上下文压缩、Slack 渲染一致 |
| 回复位置 | 默认回复到触发消息所属 thread | 满足“在该消息 thread 里回复”，并避免污染频道主时间线 |
| 去重 | 文件型 trigger ledger | Slack 事件可能重试；用 files 保持幂等 |
| Dashboard 管理 | dashboard 新增 Channel Tasks tab/API，读写 raw YAML 并校验 schema | 符合现有 dashboard 零构建、零依赖、文件管理模式 |

## 3. 文件布局

```txt
.agent-slack/
  channel-tasks.yaml              # 可选；频道任务监听规则，缺失则关闭
  channel-tasks/
    triggers.jsonl                # 已触发消息 ledger，用于去重和审计
  sessions/
    slack/
      <channelName>.<channelId>.<threadTs>/
        messages.jsonl
        meta.json
```

`channel-tasks.yaml` 是行为配置，但它是频道任务监听的专用配置文件，不放进 `config.yaml`，也不使用 env。env 仍只放 Slack/LiteLLM/Anthropic 凭证、base URL 与 debug 选项。

`triggers.jsonl` 只记录触发事实，不替代 session transcript：

```ts
interface ChannelTaskTriggerRecord {
  schemaVersion: 1
  ruleId: string
  channelId: string
  messageTs: string
  threadTs: string
  actorType: 'user' | 'bot'
  actorId: string
  triggeredAt: string
  sessionId: string
}
```

去重 key 使用 `${ruleId}:${channelId}:${messageTs}`。同一 Slack 消息命中同一规则只执行一次；若它命中多个规则，每个规则各自独立去重。

## 4. 配置文件设计

### 4.1 示例模板

Dashboard 和 onboard 后续可生成以下模板。所有字段都带中文注释；用户可以删除注释，但 dashboard raw 编辑器应尽量保留已有注释。

```yaml
# Slack 频道任务监听配置。
# 文件缺失时该功能关闭；enabled=false 时即使配置了规则也不会监听执行。
version: 1
enabled: false

# rules 是一组独立触发规则；同一条 Slack 消息可能命中多条规则。
rules:
  - id: example-channel-task
    # 当前规则开关；可临时关闭某条规则而不删除配置。
    enabled: false

    # 人类可读说明，仅用于 dashboard 展示和审计日志。
    description: 示例：监听指定频道里某个用户或 bot 的消息，并让 agent 总结处理

    # 监听的 Slack channel ID 列表。建议使用 C/G 开头的 channel ID，不建议使用频道名。
    channelIds:
      - C0123456789

    # 消息来源匹配。三个 ID 字段都是数组；只会匹配显式列出的来源。
    # userIds 匹配普通用户或 bot user ID；botIds/appIds 匹配 subtype=bot_message 的消息。
    source:
      # 是否允许普通 user message（Slack event 通常没有 subtype，带 user 字段）。
      includeUserMessages: true
      # 是否允许“由 bot 发送”的消息（Slack event 通常 subtype=bot_message，带 bot_id/app_id）。
      includeBotMessages: false
      # 允许的 Slack user ID。为空表示不按 user ID 放行；生产建议显式填写。
      userIds: [U0123456789]
      # 允许的 Slack bot ID。需要匹配 bot_message 时填写。
      botIds: []
      # 允许的 Slack app ID。某些 bot 消息更适合按 app_id 匹配。
      appIds: []

    # 消息范围。默认只处理频道根消息；打开 includeThreadReplies 后也会处理 thread 回复。
    message:
      includeRootMessages: true
      includeThreadReplies: false
      # 默认忽略编辑/删除/join/leave 等非新文本消息；需要 bot_message 时把 bot_message 加入 allowSubtypes。
      allowSubtypes:
        - none
      # 是否要求存在 text。若未来要处理文件/附件，可设为 false 并扩展 renderer/input builder。
      requireText: true
      # 默认忽略“内容里 @当前 agent”的消息，避免和 app_mention 入口重复执行；这和 includeBotMessages 不是同一概念。
      ignoreAgentMentions: true

    # 可选文本过滤。不配置时，只要频道、来源、消息范围命中就触发。
    match:
      containsAny: []
      regexAny: []

    # 命中后交给主 agent 的固定任务。运行时会把原始 Slack 消息追加到该 prompt 后。
    task:
      prompt: |
        请阅读触发消息，判断是否需要执行后续处理，并给出简洁结论。
      includeOriginalMessage: true
      includePermalink: true

    # 回复策略。replyInThread=true 时，根消息使用自己的 ts 开 thread；thread 回复沿用原 thread_ts。
    reply:
      inThread: true

    # 去重策略。默认开启，避免 Slack 重试或进程重连导致重复执行。
    dedupe:
      enabled: true
```

### 4.2 Schema 草案

```ts
interface ChannelTasksConfig {
  version: 1
  enabled: boolean
  rules: ChannelTaskRule[]
}

interface ChannelTaskRule {
  id: string
  enabled: boolean
  description?: string
  channelIds: string[]
  source: {
    includeUserMessages: boolean
    includeBotMessages: boolean
    userIds: string[]
    botIds: string[]
    appIds: string[]
  }
  message: {
    includeRootMessages: boolean
    includeThreadReplies: boolean
    allowSubtypes: Array<'none' | 'bot_message'>
    requireText: boolean
    ignoreAgentMentions: boolean
  }
  match?: {
    containsAny?: string[]
    regexAny?: string[]
  }
  task: {
    prompt: string
    includeOriginalMessage: boolean
    includePermalink: boolean
  }
  reply: {
    inThread: true
  }
  dedupe: {
    enabled: boolean
  }
}
```

校验规则：

- `version` 必须为 `1`。
- `rules[].id` 在文件内唯一，只允许 `[a-zA-Z0-9_-]`。
- `enabled=true` 的规则必须至少有一个 `channelIds`。
- `source` 至少要能匹配一种来源：
  - `includeUserMessages=true` 时，建议填写 `userIds`。
  - `includeBotMessages=true` 时，建议填写 `botIds` 或 `appIds`。
- `allowSubtypes` 中的 `none` 表示 Slack message event 没有 `subtype` 的普通消息；`bot_message` 表示 bot 消息。
- `task.prompt` 不能为空。
- `reply.inThread` 本阶段固定为 `true`；不支持频道根回复。
- `regexAny` 保存时必须能被 `new RegExp()` 编译，否则 dashboard 拒绝保存。

字段命名说明：

- `source.includeBotMessages`：控制**消息发送者类型**，即是否允许由 Slack bot 发出的 `bot_message` 触发规则。
- `message.ignoreAgentMentions`：控制**消息内容路由**，即当文本里 @当前 agent 时是否跳过频道任务，避免同一条消息同时走 `message` 和 `app_mention` 两条入口。
- `source.appIds`：不是“app mention”开关，而是 Slack `bot_message` 事件里的 `app_id` allowlist。某些集成型 bot 的 `bot_id` 不稳定或不易提前知道时，可以用 `app_id` 匹配来源。

## 5. 匹配与执行流程

```txt
Slack message event
  │
  ▼
SlackAdapter.onMessage
  ├─ 读取 ChannelTaskConfig；缺失/disabled → return
  ├─ 基础过滤：channel、root/thread 范围、subtype、text、@agent 重复入口
  ├─ source 匹配：userIds / botIds / appIds
  ├─ text match：containsAny / regexAny
  ├─ dedupe：检查 channel-tasks/triggers.jsonl
  ├─ 写 trigger record
  ├─ 构造 ChannelTask input text
  ├─ 创建 SlackEventSink(channelId, threadTs, sourceMessageTs)
  └─ ConversationOrchestrator.handle(inbound, sink)
       └─ 复用现有 session / tools / compact / renderer / usage / terminal state
```

### 5.1 Slack event 过滤

`SlackAdapter` 新增 `message` event handler，但不能影响现有 `app_mention` 路径。默认行为：

- 未配置 `channel-tasks.yaml`：不注册或不执行频道任务逻辑。
- `ignoreAgentMentions=true`：若消息文本包含当前 agent 的 Slack user mention（例如 `<@U_AGENT>`），跳过频道任务，交给 `app_mention` handler。它只处理“消息内容是否 @agent”，和 `includeBotMessages` 的“消息作者是否是 bot”不是同一层概念。
- `includeRootMessages=true`：处理 `event.thread_ts` 为空的频道根消息。
- `includeThreadReplies=false`：默认跳过 thread 回复；需要时由规则显式打开。
- `allowSubtypes: ['none']`：默认只允许无 subtype 的普通消息。
- 需要匹配 bot 消息时，规则必须设置 `includeBotMessages: true`，并把 `bot_message` 加入 `allowSubtypes`。
- Slack 真实事件/历史中，当前 bot 通过 `chat.postMessage` 发送的消息可能带 `bot_id/app_id/user` 但不带 `subtype`。运行时会先按 `userIds` 尝试匹配无 subtype 消息；若用户来源未命中且 `botIds/appIds` 命中，则按 bot 来源处理，并归一化为 `bot_message`。
- 为支持当前 bot 自己发消息触发频道任务，`SlackAdapter` 关闭 Bolt 默认 `ignoreSelf`，并在 `app_mention` handler 内手动跳过来自当前 agent 自身的 mention，避免自触发循环。

这不是安全边界，而是噪音控制。安全边界来自明确的 channel/source allowlist。

### 5.2 来源匹配

Slack 的 user message 和 bot message 字段不同，匹配逻辑按以下顺序归一化 actor：

| Slack event 形态 | actorType | actorId | 可匹配字段 |
|---|---|---|---|
| 无 subtype，存在 `user` | `user` | `event.user` | `source.userIds` |
| `subtype=bot_message`，存在 `bot_id` | `bot` | `event.bot_id` | `source.botIds` |
| `subtype=bot_message`，存在 `app_id` | `bot` | `event.app_id` | `source.appIds` |
| 无 subtype，存在 `bot_id/app_id`，且 `userIds` 未命中 | `bot` | `event.bot_id` 或 `event.app_id` | `source.botIds` / `source.appIds` |
| bot 以 bot user 身份发普通消息，且 `userIds` 命中 | `user` | `event.user` | `source.userIds` |

命中 user message 时，`InboundMessage.userId` 使用 Slack user ID；命中 bot message 时，`InboundMessage.userId` 使用 `bot_id ?? app_id ?? user ?? 'unknown'`，`userName` 使用可解析的 bot/profile 名称，失败时回退 actorId。这样现有 `ToolContext.currentUser` 仍有稳定身份，不需要引入全局单例或特殊 tool 分支。

### 5.3 任务输入构造

频道任务监听不把用户原文直接当作完整 prompt，而是包装成结构化输入，避免模型混淆触发来源与任务指令：

```txt
[频道任务触发: <ruleId>]

任务说明：
<task.prompt>

触发信息：
- channelId: <channelId>
- messageTs: <messageTs>
- actorType: <user|bot>
- actorId: <actorId>
- permalink: <permalink, 如果 includePermalink=true 且可获取>

原始 Slack 消息：
<event.text>
```

若 `task.includeOriginalMessage=false`，则省略“原始 Slack 消息”段，仅执行固定 prompt。该模式适合定时/信号类 bot 消息，但默认应为 `true`。

### 5.4 回复 thread 选择

`reply.inThread` 本阶段固定为 `true`：

- 触发消息是频道根消息：`threadTs = event.ts`，agent 在该消息 thread 首次回复。
- 触发消息是 thread 回复且规则允许 `includeThreadReplies=true`：`threadTs = event.thread_ts`，agent 回复到同一个 thread。
- `sourceMessageTs = event.ts`，用于 reaction、usage suppression 与审计。

这样会话目录仍复用现有规则：`slack:<channelId>:<threadTs>`。

## 6. Dashboard 管理

Dashboard 新增 `Channel Tasks` tab，管理 `.agent-slack/channel-tasks.yaml`。

### 6.1 API

沿用当前 dashboard 原生 HTTP server 和 `DashboardApi` 模式：

| 方法 | 路径 | 行为 |
|---|---|---|
| `GET` | `/api/channel-tasks` | 返回 `{ exists, raw, parsed, validation }` |
| `PUT` | `/api/channel-tasks` | 接收 raw YAML，解析并校验，通过后写入文件 |
| `DELETE` | `/api/channel-tasks` | 删除配置文件，功能回到关闭状态 |
| `POST` | `/api/channel-tasks/template` | 生成带中文注释的默认模板；若文件已存在则拒绝覆盖，除非显式 force |

Dashboard 只绑定 `127.0.0.1`，写操作沿用现有 dashboard 假设，不新增鉴权。

### 6.2 UI

首版使用 raw YAML 编辑器，和现有 Config/System Prompt tab 保持一致：

- 文件不存在时展示“未启用”，提供“生成模板”按钮。
- 文件存在时展示 raw YAML textarea、保存、删除按钮。
- 保存前后展示 schema 校验结果。
- Parsed 区域只读展示生效后的规则摘要。
- 保存后提示“需要重启 agent/daemon 后生效”。

后续可以在同一 tab 增加表单化编辑，但 raw YAML 仍保留，避免 dashboard 丢失注释或无法表达新增字段。

### 6.3 注释保留策略

`yaml` 包解析成对象后不会保留所有注释。因此：

- dashboard raw 编辑器保存用户输入的原始文本，不重新格式化。
- schema 校验只用于判断是否允许保存，不把 parsed object 再 stringify 回文件。
- “生成模板”负责提供完整中文注释；已经存在的文件不自动重写注释。

## 7. 运行时装配

新增模块建议：

```txt
src/channelTasks/
  config.ts             # ChannelTasksConfig schema / parse / default template
  matcher.ts            # 纯函数：Slack message event + config -> matched rules
  inputBuilder.ts       # 纯函数：matched rule + Slack event -> InboundMessage text
  triggerLedger.ts      # files ledger：read/check/append triggers.jsonl
```

装配点：

1. `WorkspacePaths` 新增 `channelTasksFile`、`channelTasksDir`、`channelTaskTriggersFile`。
2. `loadWorkspaceContext()` 或 `createApplication()` 加载可选 `channel-tasks.yaml`。
3. `createApplication()` 将解析后的 channel task config 和 ledger 注入 `SlackAdapter`。
4. `SlackAdapter` 注册 `message` event handler，匹配成功后复用现有 `createSlackEventSink()` 与 `orchestrator.handle()`。
5. Dashboard API 读写同一个 schema 和模板，避免运行时与管理端校验不一致。

配置热重载不在首版实现。Dashboard 保存后，用户需要重启 `agent-slack start` 或 daemon；daemon tab 可在后续提供“保存并重启”快捷操作。

## 8. Slack 权限与事件订阅

需要在 Slack App 配置中补充事件订阅和 scope：

| 能力 | Slack 配置 |
|---|---|
| 监听公开频道消息 | Event Subscriptions: `message.channels`；Bot Token Scope: `channels:history` |
| 监听私有频道消息（可选） | Event Subscriptions: `message.groups`；Bot Token Scope: `groups:history` |
| 解析用户名称 | 继续使用现有 `users.info`，需要 `users:read` |
| 回复 thread / reaction | 继续使用现有 `chat:write` / `reactions:write` |

首版建议只实现 `message.channels`；`message.groups`、`message.im`、`message.mpim` 作为后续扩展，避免把频道任务监听扩大到 DM。

## 9. 错误处理与可观测性

- 配置文件不存在：debug 日志即可，不报错。
- 配置解析失败：启动期应 fail fast，提示 dashboard 修复；dashboard 保存时必须先校验，避免写入坏配置。
- 单条规则匹配或 prompt 构造失败：记录 warn，不影响其他规则。
- Slack API 失败：沿用 `safeRender` / renderer 层错误处理，不让 Slack 渲染失败拖垮 orchestrator。
- ledger 写失败：为避免重复执行，视为当前触发失败并 warn；不要在无法记录去重事实时继续执行。
- 日志 tag 建议使用 `slack:channel-task`，记录 ruleId、channelId、messageTs、actorType、actorId、dedupe 命中情况。

## 10. 测试策略

单测：

- `channelTasks/config.test.ts`：模板可解析、schema 默认值、非法 regex / 重复 id / 空 prompt 拒绝。
- `channelTasks/matcher.test.ts`：user message、bot message、channel/source/subtype/thread/text match、ignore agent mention。
- `channelTasks/inputBuilder.test.ts`：任务 prompt 包装、permalink 可选、原始消息可选。
- `channelTasks/triggerLedger.test.ts`：同 rule/channel/message 去重，不同 rule 可分别触发。
- `SlackAdapter.test.ts`：message event 命中后构造 `InboundMessage`，`threadTs` 与 `sourceMessageTs` 正确。
- `dashboard/server.test.ts`：`GET/PUT/DELETE /api/channel-tasks` 与模板生成。

Live E2E：

- 新增 `channel-task-user-message`：临时 workspace 写入 `channel-tasks.yaml`，用真实用户 token 在目标频道发根消息，断言 agent 在该消息 thread 回复。
- 新增 `channel-task-bot-message`：用当前 bot 自己发根消息触发频道任务，验证 `bot_message` / 缺 subtype 但带 `bot_id/app_id` 的归一化匹配、thread 回复、usage、done reaction、session 持久化与 trigger ledger。
- 验证重复发送同一 Slack retry payload 不会重复触发；live 环境难以模拟时用集成测试覆盖 ledger。

## 11. 落地节奏

1. **Chunk 1：配置与匹配纯函数（已完成）**  
   新增 `channelTasks/config.ts`、`matcher.ts`、`inputBuilder.ts` 与单测；不接 Slack。
2. **Chunk 2：SlackAdapter 接入（已完成）**  
   注入配置与 ledger，新增 `message` event handler，复用 orchestrator 和 SlackEventSink。
3. **Chunk 3：Dashboard 管理（已完成）**  
   新增 `/api/channel-tasks`、Channel Tasks tab、模板生成与 schema 校验。
4. **Chunk 4：Live E2E 与文档（已完成）**  
   补真实 Slack E2E、README/onboard 说明、Slack 权限提示。
5. **后续增强（可选）**  
   Dashboard 表单化编辑、保存并重启 daemon、更多 Slack 子类型覆盖。

## 12. 风险与缓解

| 风险 | 缓解 |
|---|---|
| 监听范围过大导致误触发 | 默认文件缺失关闭；规则必须显式 channel/source allowlist |
| bot message 字段差异导致匹配失败 | 同时支持 `userIds`、`botIds`、`appIds`；日志记录归一化 actor |
| @mention 与 message event 重复执行 | 默认 `ignoreAgentMentions=true`，@agent 消息仍走现有 `app_mention` |
| Slack retry 导致重复任务 | `triggers.jsonl` 去重；ledger 写失败则不执行 |
| dashboard 保存破坏中文注释 | raw YAML 原样写入，不用 parsed object stringify 覆盖 |
| 保存配置后用户以为立即生效 | dashboard 明确提示需要重启；后续可提供“保存并重启 daemon” |
