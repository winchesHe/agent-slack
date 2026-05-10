# 定时任务模块（scheduledTasks）设计

- 作者: winches
- 日期: 2026-05-10
- 状态: draft（v2，已应对 spec review v1 的发现）

## 1. 背景与目标

agent-slack 目前的"任务"都是入站事件驱动：
- `app_mention` / DM 由用户主动发起
- `channelTasks` 由 Slack 频道里他人消息匹配规则触发
- 微信单聊由对端消息触发

缺少**时间驱动**的入口：用户希望"工作日早上 9 点跑一段 prompt，把结果发到某个频道 / 微信会话"。本模块补这一段。

### 目标

- 通过 yaml 配置一组定时任务，每条独立配置 `cron`、`prompt`、投递目标 IM。
- daemon 进程启动时自动加载并按 cron 触发；停 daemon 即停调度。
- CLI `agent-slack scheduled-tasks run <id>` 支持手动触发同一任务（独立进程，不依赖 daemon 在跑）。
- 复用现有 IM 适配器的入站会话渲染管线（progress / 工具调用 / 最终回复都按 SlackRenderer / WechatRenderer 已有路径输出）。
- 结构化记录每次运行结果到 `.agent-slack/logs/scheduled-tasks.jsonl`，便于"昨天为什么没发"这种排查。

### 非目标（YAGNI）

- 不做 fan-out（一条任务发到多个目标）。需要多目标就复制任务。
- 不做失败重试与失败外发提示。失败仅写历史。
- 不做手动触发与 cron 触发的跨进程互斥锁。CLI 与 daemon 撞同一时刻按"各自跑"处理。
- 不做 dashboard 表单化（cron / prompt 是任务粒度，dashboard 走 Raw YAML 兜底）。
- 不做日历语义糖（`daily/weekly/interval`）。一期只有 cron。
- 不做秒级精度（croner 的 5 字段表达式即可）。

## 2. 用户视角

```yaml
# .agent-slack/scheduled-tasks.yaml
version: 1
enabled: true

tasks:
  - id: daily-standup
    enabled: true
    description: 工作日早上 9 点总结昨日 PR/issue
    cron: '0 9 * * 1-5'
    # timezone: 'Asia/Shanghai'   # 可选，默认本机时区
    prompt: |
      请总结最近 24 小时仓库的关键变更，列 3-5 条要点。
    target:
      im: slack
      channelId: C0123456789

  - id: weekly-report
    enabled: true
    cron: '0 17 * * 5'
    prompt: |
      生成本周工作小结，3 个 highlight + 下周计划。
    target:
      im: wechat
      to: filehelper
```

启动 daemon 后到点自动跑；想立刻跑一次：

```
agent-slack scheduled-tasks run daily-standup
```

跑完后 `.agent-slack/logs/scheduled-tasks.jsonl` 末尾追加一条记录。

## 3. 架构

```
┌────────────────── daemon process ───────────────────────────┐
│                                                             │
│  ScheduledTaskScheduler  ── cron fire ──┐                   │
│  (croner-based)                         │                   │
│                                         ▼                   │
│                              ScheduledTaskRunner.runOnce    │
│                                         │                   │
│                  ┌──────────────────────┴─────┐             │
│                  ▼                            ▼             │
│         slackScheduledHook.run         wechatScheduledHook. │
│         (注入 web=app.client)          run                  │
│         共享 runScheduledSlackSession  共享 runScheduledWechat│
│                                                Session       │
│                  │                            │             │
│                  ▼                            ▼             │
│         existing pipeline: orchestrator → agent → EventSink │
│         → Renderer → IM API                                 │
│                                                             │
│  ScheduledTaskRunHistory ── started/success/failed/skipped  │
│  ─────> .agent-slack/logs/scheduled-tasks.jsonl             │
└─────────────────────────────────────────────────────────────┘

CLI: agent-slack scheduled-tasks run <id>
  └─ 独立进程 createApplication() → 直接调 runScheduled{Slack|Wechat}Session
      Slack: 自建 WebClient（仅 botToken，不 SocketMode）
      Wechat: 调 credentialsStore.load() 失败即退；不触发 QR 登录
```

### 核心抽象：`runScheduled<IM>Session` 是共享纯函数

为了避免在 `IMAdapter` 接口上塞各 IM 形参不同的方法（v1 spec 这点被评审正确指出），改成：

- **每个 IM 内部**导出一个**纯函数** `runScheduled<IM>Session`，它接受"完成一次会话所需的全部依赖 + target + prompt"，复用 inbound 闭包内的"建 sink → orchestrator.handle"那段。
- **adapter 内部**额外暴露一个轻量"hook"方法（不是 IMAdapter 接口的一部分，是 daemon 装配时拿到的 concrete adapter handle），用 adapter 自己的 `app.client` / `api` 调上述纯函数。
- **CLI 模式**直接调纯函数，自己造依赖（WebClient / loaded WechatApi）。

具体形态：

```ts
// src/im/slack/scheduled.ts (新文件)
export interface RunScheduledSlackArgs {
  taskId: string
  channelId: string
  prompt: string
  web: WebClient
  deps: {                    // createApplication 中已构造的共享依赖
    orchestrator: ConversationOrchestrator
    sessionStore: SessionStore
    runQueue: SessionRunQueue
    abortRegistry: AbortRegistry<string>
    renderer: SlackRenderer
    workspaceLabel?: string
    logger: Logger
  }
}
export async function runScheduledSlackSession(args: RunScheduledSlackArgs): Promise<void>
```

```ts
// src/im/wechat/scheduled.ts (新文件)
export interface RunScheduledWechatArgs {
  taskId: string
  to: string
  prompt: string
  api: WechatApi              // 已 setToken
  deps: {
    orchestrator: ConversationOrchestrator
    sessionStore: SessionStore
    rendererFactory: () => WechatRenderer
    logger: Logger
  }
}
export async function runScheduledWechatSession(args: RunScheduledWechatArgs): Promise<void>
```

`IMAdapter` **公共接口不变**（`id / start / stop`）。Slack/Wechat 的 daemon-mode hook 通过 `createApplication()` 暴露的具体类型字段提供给 runner，不入接口。

### 模块边界

新增 `src/scheduledTasks/`：

| 文件 | 职责 |
|---|---|
| `config.ts` | Zod schema、`loadScheduledTasksConfigFile()` |
| `scheduler.ts` | `createScheduledTaskScheduler({ rules, runner, logger })` 基于 `croner` 注册/启停 jobs；in-flight skip |
| `runner.ts` | `createScheduledTaskRunner({ slackHook?, wechatHook?, history, logger })` 暴露 `runOnce(rule, trigger)`；按 `target.im` 路由；包 try/catch；写 history |
| `runHistory.ts` | `appendScheduledTaskRun(file, record)` jsonl 追加 |
| `types.ts` | `ScheduledTaskRunRecord` 等 TS 类型 |
| `index.ts` | 公开导出 |
| `*.test.ts` | 同目录 vitest |

新增/修改的 IM 文件：

- `src/im/slack/scheduled.ts`（新）：`runScheduledSlackSession()` 纯函数。
- `src/im/wechat/scheduled.ts`（新）：`runScheduledWechatSession()` 纯函数。
- `src/im/slack/SlackAdapter.ts`：`app_mention` 闭包里"建 sink + orchestrator.handle"那段抽出 → 调用 `runInboundSlackSession` 内部 helper（与 `runScheduledSlackSession` 共享底层 implementation；区别仅在 inbound 携带 `confirmSender`、scheduled 不带）。`createSlackAdapter` 返回类型从单一 `IMAdapter` 改为：
  ```ts
  export interface SlackAdapterHandle {
    adapter: IMAdapter
    scheduledHook: { run: (args: { taskId; channelId; prompt }) => Promise<void> }
  }
  export function createSlackAdapter(deps): SlackAdapterHandle
  ```
  `scheduledHook.run` 闭包捕获 `app.client` + 当前装配 deps，调 `runScheduledSlackSession`。
- `src/im/wechat/WechatAdapter.ts`：同上抽 `runInboundWechatSession`；返回类型：
  ```ts
  export interface WechatAdapterHandle {
    adapter: IMAdapter
    scheduledHook: { run: (args: { taskId; to; prompt }) => Promise<void> }
    loadCredentialsOnly: (file: string) => Promise<WechatCredentials>   // CLI 用
  }
  ```
  `loadCredentialsOnly` 不触发 QR 登录，缺失则抛 `MissingWechatCredentialsError`。

`createApplication` 内部把两个 handle 解构使用：`adapters = [slackHandle.adapter, wechatHandle.adapter]` 进现有数组，`hooks` 转给 runner。`Application` 顶层多一个 `scheduledTasks?: { runner; scheduler? }`。`IMAdapter` 公共接口完全不动。

### `createApplication` 改动

- load yaml → 装配 history / runner / scheduler；daemon 启动时 `scheduler.start()`，停止时 `scheduler.stop()`。
- 暴露的 application 顶层增加：`scheduledTasks?: { runner, scheduler? }`，runner 给 CLI 用，scheduler 仅 daemon 启动。

## 4. 配置与 Schema

### 4.1 yaml 模板（`examples/scheduled-tasks.example.yaml`）

```yaml
# 定时任务示例。
# 复制到你的 workspace: .agent-slack/scheduled-tasks.yaml
# 文件缺失时功能关闭；保存后需要重启 agent-slack daemon。

version: 1
enabled: false   # 启用：改为 true

tasks:
  - id: daily-standup
    enabled: false   # 启用：改为 true
    description: 示例：工作日早上 9 点总结仓库变更并发到 Slack 频道。
    cron: '0 9 * * 1-5'
    # timezone: 'Asia/Shanghai'   # 可选；默认本机时区
    prompt: |
      请总结最近 24 小时仓库的关键变更，列 3-5 条要点。
    target:
      im: slack
      channelId: C0123456789
      # im=wechat 改为以下两行（删掉 channelId 行）：
      # im: wechat
      # to: filehelper
```

模板按 AGENTS.md §Env/Config 模板源规则提供"启用最少步骤"引导：顶层 `enabled: false` + 单条 `enabled: false`，注释说明改 true 即启用，并给出 wechat target 切换的注释行。

### 4.2 Zod schema 关键约束

```ts
const idSchema = z.string().min(1).regex(/^[a-zA-Z0-9_-]+$/)  // 形态与 channelTasks 一致

const SlackTargetSchema = z.object({
  im: z.literal('slack'),
  channelId: z.string().regex(/^[CG][A-Z0-9]+$/, 'channelId 须以 C/G 开头'),
})

const WechatTargetSchema = z.object({
  im: z.literal('wechat'),
  to: z.string().min(1),
})

const TargetSchema = z.discriminatedUnion('im', [SlackTargetSchema, WechatTargetSchema])

const ScheduledTaskRuleSchema = z.object({
  id: idSchema,
  enabled: z.boolean().default(true),
  description: z.string().optional(),
  cron: z.string().min(1).superRefine((v, ctx) => {
    try {
      // 关键：传 paused: true 让 croner 不真的注册调度，避免 schema 阶段产生副作用
      const c = new Cron(v, { paused: true })
      c.stop()
    } catch (e) {
      ctx.addIssue({ code: 'custom', message: `非法 cron: ${(e as Error).message}` })
    }
  }),
  timezone: z.string().optional(),
  prompt: z.string().trim().min(1),
  target: TargetSchema,
})

const ScheduledTasksConfigSchema = z.object({
  version: z.literal(1).default(1),
  enabled: z.boolean().default(false),
  tasks: z.array(ScheduledTaskRuleSchema).default([]),
}).superRefine((cfg, ctx) => {
  // task id 唯一性
})
```

### 4.3 IM 启用交叉校验

`createApplication` 在 load yaml 后，若顶层 `enabled: true`，对每条 enabled 的 task 检查 `target.im` 是否在 `config.im.enabled` 数组里。未启用直接抛错（启动早失败优于运行时静默）。

### 4.4 `cron` 早失败 + 无副作用

`superRefine` 用 `new Cron(v, { paused: true })` 试解析；构造完立刻 `c.stop()`，避免 schema 阶段意外注册一个真在跑的 cron job。

### 4.5 `timezone` 默认值

`runner` 使用 `rule.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone`。schema 阶段不强校验 IANA 字符串（候选值列表过长且更新中），croner 在 register job 时若不识别会抛错——这种错误经 `scheduler.start()` 暴露，daemon 启动阶段就崩，仍是早失败。

### 4.6 `ScheduledTaskRunRecord` TS 类型（types.ts）

```ts
type ScheduledTaskTarget =
  | { im: 'slack'; channelId: string }
  | { im: 'wechat'; to: string }

export interface ScheduledTaskRunRecord {
  runId: string                        // `${taskId}:${startedAt ISO}:${trigger}` 唯一串联 started 与终态
  taskId: string
  trigger: 'cron' | 'manual'
  status: 'started' | 'success' | 'failed' | 'skipped'
  startedAt: string                    // ISO
  endedAt?: string                     // ISO；started 行无
  durationMs?: number                  // 同上
  target: ScheduledTaskTarget
  skippedReason?: 'in-flight'
  error?: string
  finalSummary?: string                // 截断到前 200 字符
}
```

`started` 与终态（`success`/`failed`）共享同一 `runId`，可在历史里 join。`skipped` 是单独一行（无 started 配对）。

### 4.7 配置联动检查（按 AGENTS.md §Env/Config 变更联动规则）

| 项 | 是否涉及 |
|---|---|
| 1. Schema | ✅ `src/scheduledTasks/config.ts:ScheduledTasksConfigSchema` |
| 2. 模板源 | ✅ `examples/scheduled-tasks.example.yaml` + generator `src/workspace/templates/scheduledTasks.ts` |
| 3. `agent-slack upgrade` | ⚠️ **需在 plan 阶段读 `src/workspace/upgrade.ts` 确认**：generator 框架是否自动支持新顶层 yaml 文件，还是需要在 upgrade.ts 里显式注册一项 |
| 4. Dashboard 常用字段 | ❌ 不加（cron/prompt 任务粒度，走 Raw YAML） |
| 5. 运行时装配 | ✅ `src/application/createApplication.ts` |
| 6. examples/ | ✅ + `templates.test.ts` 守护漂移 |
| 7. env | ❌ 不涉及（行为配置走 yaml） |
| 8. README / 架构 spec | ✅ README 加一段、`docs/superpowers/specs/2026-04-17-agent-slack-architecture-design.md` 提及 |

## 5. 数据流详解

### 5.1 daemon 启动期

```
agent-slack daemon start
└─ createApplication()
   ├─ load .agent-slack/scheduled-tasks.yaml → ScheduledTasksConfig | undefined
   │   yaml 不存在 → undefined（模块禁用）
   │   schema 错 → throw（daemon 拒起）
   ├─ build SlackAdapter / WechatAdapter（已有）
   │   各自暴露 *ScheduledHook（不入 IMAdapter 接口）
   ├─ if config?.enabled:
   │   ├─ build ScheduledTaskRunHistory(file)
   │   ├─ build ScheduledTaskRunner({
   │   │     slackHook: enabled.includes('slack') ? slackScheduledHook : undefined,
   │   │     wechatHook: enabled.includes('wechat') ? wechatScheduledHook : undefined,
   │   │     history, logger
   │   │   })
   │   └─ build ScheduledTaskScheduler({ rules: config.tasks.filter(enabled), runner, logger })
└─ daemon.start()
   ├─ slack.start() / wechat.start()
   └─ scheduler?.start()
```

### 5.2 cron fire 一次

```
croner job 按 task.cron + tz 触发
└─ scheduler 检查 in-flight Map<taskId, Promise>
   ├─ has(taskId) → history.append({ runId, status:'skipped', skippedReason:'in-flight', trigger:'cron' })
   │                return
   └─ set(taskId, runPromise) + runner.runOnce(rule, 'cron') → 完成后 delete
      └─ runOnce(rule, trigger):
         ├─ runId = `${rule.id}:${startedAt}`
         ├─ history.append({ runId, status:'started', trigger, startedAt })
         ├─ hook = (rule.target.im === 'slack') ? slackHook : wechatHook
         │   hook 不存在（adapter 未启用）→ status:'failed', error:'adapter-not-enabled'
         ├─ Slack 路径（hook.run 内部）：
         │   ├─ web.chat.postMessage({ channel: target.channelId, text:`[定时任务: ${rule.id}] 启动…` })
         │   │   失败 → throw → runner catch → status:'failed', error:'root-post-failed'
         │   ├─ inbound = {
         │   │     imProvider:'slack', channelId, channelName:<resolved>,
         │   │     threadTs:<root ts>, messageTs:<root ts>,
         │   │     userId:'scheduler', userName:'scheduler',
         │   │     text: rule.prompt
         │   │     // confirmSender 不携带（字段 optional，已确认）
         │   │   }
         │   ├─ sessionId = `slack:${channelId}:${rootTs}`（与 inbound 同构）
         │   │   不调 runQueue.enqueue（定时任务是孤立 turn，不参与多轮排队；
         │   │   shouldSuppressUsage 的 queueDepth=0 行为正确）
         │   └─ build SlackEventSink → orchestrator.handle(inbound, sink)
         │      派生效果：root 消息成为该 channel 的 thread 起点；
         │      用户在该 thread 里回复会被 app_mention/inbound 路径恢复为同一 sessionId 的会话——
         │      这是有意行为：定时播报变成可被人接力对话的入口
         ├─ Wechat 路径（hook.run 内部）：
         │   ├─ inbound = {
         │   │     imProvider:'wechat', channelId: target.to, channelName: target.to,
         │   │     threadTs: target.to, messageTs:<生成 id>,
         │   │     userId:'scheduler', userName:'scheduler',
         │   │     text: rule.prompt
         │   │   }
         │   ├─ contextToken = ''   // 见 §6.4 风险条目
         │   └─ build WechatEventSink({ api, contextToken: '' }) → orchestrator.handle
         ├─ 成功：history.append({ runId, status:'success', endedAt, durationMs, finalSummary })
         └─ 异常：history.append({ runId, status:'failed', endedAt, error: <message> })
            EventSink 已经把错误渲染到目标会话；history 不二次外发
```

`confirmSender` 留空时，`createApplication.ts:111` 处的 toolsBuilder 不会把 confirm tool 挂载到 agent —— 这意味着 agent **从工具列表里就看不到 ask-confirm**，不会调用它（不是"调用后抛错"）。

### 5.3 CLI 手动触发链路

```
agent-slack scheduled-tasks run <id>
└─ createApplication()  // 独立进程
   ├─ load yaml → 找 rule by id
   │   未找到 → exit code 2
   ├─ 依据 rule.target.im 准备依赖：
   │   slack: 用 SLACK_BOT_TOKEN 直接 new WebClient(token)，**不启动 Bolt App**
   │           （避免与 daemon 抢 SocketMode 同 app token；也省去 Bolt 启动延迟）
   │   wechat: 调 wechatHandle.loadCredentialsOnly(credentialsFile) 拿 creds
   │           creds 不存在 → exit code 3，提示用户先 daemon 跑一次完成扫码
   │           **若 creds.baseUrl 与配置 baseUrl 不同，须先 api.baseUrl = creds.baseUrl**
   │           （扫码时服务端可能返回主域切换，见 WechatApi.ts:115）
   │           然后 api.setToken(creds.token)
   └─ 直接调 runScheduled{Slack|Wechat}Session（纯函数，不经 daemon hook）
      runner 共用一份；trigger 标 'manual'
      复用同一份 history jsonl
   exit
```

**CLI exit code 表**（用户可见契约，不要随便加新值）：

| code | 触发 |
|---|---|
| 0 | 成功（含 agent 跑出 final 的失败也算 0，因为已落 history failed） |
| 1 | 一般运行时错误（未捕获异常） |
| 2 | rule 不存在（拼错 id） |
| 3 | wechat 凭证缺失（且 target.im=wechat） |
| 4 | target.im 对应 IM 在 config.im.enabled 中未启用 |
| 5 | yaml schema 错（顶层 enabled 但加载失败） |

CLI 与 daemon 互不感知；同一时刻撞上偶发会发两条，按已确认接受。Slack 这边 CLI 不起 Bolt App 因此无 socket 冲突；只是消息渲染时无"沙漏 reaction"等 Bolt 派生交互（无影响，因为定时任务本就不参与多轮排队）。

### 5.4 history jsonl 记录

每行一个 `ScheduledTaskRunRecord`（§4.6 类型）。同一次 run 通常写两行：`started` + 终态（`success`/`failed`）；`skipped` 单行；`runId` 串联两端。

## 6. 错误处理与边界

| 场景 | 行为 |
|---|---|
| yaml 不存在 | 模块禁用，无报错（同 channelTasks 风格） |
| yaml schema 错 | daemon 启动阶段抛，拒起 |
| 顶层 `enabled:false` | scheduler 不创建，也不写 history |
| 单条 `enabled:false` | scheduler 跳过该条，不注册 cron；CLI run 仍可手动触发（manual 不受 enabled 字段限制） |
| `target.im` 对应 adapter 未启用 | yaml 加载阶段拦下（§4.3） |
| 同任务正在跑，cron 又到点 | skip + 写 jsonl |
| 纯函数 `runScheduled<IM>Session` 抛错 | runner catch；EventSink 已渲染失败到会话；写 failed |
| Slack 根消息 postMessage 失败（仅 Slack 路径） | 不进入 orchestrator；写 `error:'root-post-failed'`。Wechat 路径无对应"前置发根消息"步骤，首次失败直接落在 sink 内 |
| Wechat 凭证失效 | sendText 失败由 EventSink 处理（如能渲染）；history failed |
| daemon 收到 SIGTERM | scheduler.stop() 取消所有 cron；in-flight 的 run **会被进程退出中断**，不写 success/failed（日志里只有 `started`，便于后续排查"为什么半截"）。**不做 graceful drain**——LLM 调用可能很长，强制等待会阻塞 daemon 退出。**用户可见副作用**：目标会话里可能残留半截渲染消息，README 须提醒 |
| ask-confirm 工具 | confirmSender=undefined → toolsBuilder 不挂载 confirm tool → agent 看不到这个工具 |
| cron 跨夏令时跳过 | 由 croner 处理；不专门补救 |

### 6.1 Slack WebClient 来源

- **daemon mode**：`SlackAdapter` 内部维护 Bolt App，`app.client` 即 WebClient。adapter 暴露的 `slackScheduledHook.run()` 闭包直接捕获 `app.client`。
- **CLI mode**：`createApplication()` 在 CLI 模式下不启动 Bolt App；改为直接 `new WebClient(env.SLACK_BOT_TOKEN)`。CLI 进程不订阅事件，只发消息——这与 Bolt App 的事件订阅是正交的。

### 6.2 Wechat 凭证 / 登录

- `WechatAdapter.start()` 现在的行为是凭证缺失则进 QR 登录主循环。CLI 不能走这条——会卡 8 分钟扫码或要求终端交互。
- 新增 `wechatAdapter.loadCredentialsOnly(credentialsFile): Promise<WechatCredentials>`：仅读凭证文件并 `setToken`，不存在直接抛 `MissingWechatCredentialsError`。
- CLI 收到错就 `exit code 3` 并打印"先用 `agent-slack daemon start` 完成微信扫码登录"。

### 6.3 `confirmSender` 字段

- `InboundMessage.confirmSender` 已是 `?` 可选（`src/im/types.ts:81`）。
- toolsBuilder 在 `imContext.confirm` 不存在时跳过挂载 confirm tool（`src/application/createApplication.ts:111`）。
- 因此定时任务不携带 confirmSender 是与现有类型/装配兼容的"自然降级"，无需改类型。

### 6.4 ⚠️ Wechat `context_token` 风险（已知未验证项）

**问题**：`WechatApi.sendText(to, text, contextToken)` 总是把 `context_token` 字段塞进请求体（`src/im/wechat/WechatApi.ts:90`）。当前实现里 `contextToken` 来自对方上一条入站消息，缓存在 `runLongPollLoop` 的闭包 `contextTokens` Map 中（`WechatAdapter.ts:173`）。

定时任务**没有对方入站消息**作上下文锚——`contextToken` 必然为空字符串 `''`。能否成功投递取决于服务端实现，已知信息不足以在 spec 阶段断言。

**一期决策**：
- 仍以 `contextToken: ''` 调 `sendText`，先发再说。
- `filehelper`（微信文件助手特殊账号）按经验对 `context_token` 不敏感，预期可用——但 spec 不在此处保证。
- **强制要求**：实现完成后必须有一次 `filehelper` 实发 E2E 验证（手动），才认为 wechat target 可用；非 filehelper 联系人作为**未支持**写进 README，等真实测过再放开。
- 若 `sendText` 在空 token 下被服务端拒绝（错误码 / 体），由现有错误处理路径（runner catch + history failed）兜底，不需要新增 fallback。

**长期**：若需要稳定支持非 filehelper 联系人，可考虑在收到对方任意入站消息时把 `contextToken` 持久化到磁盘（per-peer），定时任务起跑时优先读最新缓存。这条**不在本期范围**，仅备忘。

### 6.5 daemon 关停语义

按 §6 表，定时任务 in-flight 不做 graceful drain。后果：长 LLM 调用被 SIGTERM 中断，history 留 `started` 无终态。这是显式接受的代价，避免阻塞 daemon 退出。

## 7. 测试策略

按 AGENTS.md：vitest，`*.test.ts` 与源文件同目录，跨模块集成测试放 `tests/`。

### 7.1 单测

| 文件 | 覆盖点 |
|---|---|
| `src/scheduledTasks/config.test.ts` | 合法解析、缺字段、id 重复、cron 非法（含 `new Cron(v, { paused: true })` 不留副作用）、target 缺字段、im 与 enabled IMs 交叉校验 |
| `src/scheduledTasks/scheduler.test.ts` | fake timers 推进 + 断言 `runner.runOnce` 触发；in-flight skip；start/stop 幂等；多 task 并发不互锁 |
| `src/scheduledTasks/runner.test.ts` | hook 路由（slack vs wechat vs 缺失 hook 失败）；history 事件序列（started → success/failed/skipped 共享 runId）；hook 抛错仍写 failed；'manual' trigger 标签 |
| `src/scheduledTasks/runHistory.test.ts` | jsonl 追加格式；并发写不交错丢行 |

### 7.2 IM 内部纯函数测试

| 文件 | 覆盖点 |
|---|---|
| `src/im/slack/scheduled.test.ts` | mock WebClient：root postMessage 调用参数、threadTs 链路、orchestrator.handle 入参、root-post 失败传播 |
| `src/im/wechat/scheduled.test.ts` | 合成 InboundMessage 字段、`contextToken: ''` 传进 EventSink |

### 7.3 集成测

- 扩 `src/application/createApplication.test.ts`：一条 enabled task + 假 hook（spy 是否被调用），fake timers 推进，断言 history jsonl 写入路径正确；schedule 顶层 enabled=false 时 scheduler 不创建。

### 7.4 已有 adapter 测试守护重构

- `src/im/slack/SlackAdapter.test.ts` / `src/im/wechat/WechatAdapter.test.ts`：抽 `runInbound<IM>Session` 是无行为变更重构，现有测试不应改断言。这是回归保险。
- 注：`git status` 当前显示这两份测试有未提交修改，那是 wechat MVP 落地阶段的改动（与本 spec 无关）。本 spec 实施时基线以那次合并后版本为准；plan 阶段须先确认基线干净再开始 refactor。

### 7.5 CLI 测

- `src/cli/commands/scheduledTasks.test.ts`：`run <id>` 命令——rule 未找到（exit 2）、wechat 凭证缺失（exit 3）、slack 走 WebClient 直连（mock 验证不起 Bolt）、成功路径调用对应纯函数 + history `trigger:'manual'`。

### 7.6 Live E2E

- **Slack**：建议加 `src/e2e/live/run-scheduled-task-slack.ts`，发到指定测试频道，肉眼验消息发出。非强制（按 AGENTS.md 仅 Slack 交互/UI 变更必须）。
- **Wechat（必做）**：加 `src/e2e/live/run-scheduled-task-wechat.ts`，target 设为 `filehelper`，验证空 contextToken 发送链路真的通——这是 §6.4 标识的未验证风险点，spec 强制要求一期上线前手动跑一次。

## 8. 依赖与库选择

新增 npm 依赖：

- **`croner`**（轻量、无依赖、IANA tz 支持完善）。MIT。

替代候选：`node-cron`（不支持 tz override）、`cron`（依赖 luxon，重）。**选 croner**。

## 9. 文档与上游联动

- 本 spec：`docs/superpowers/specs/2026-05-10-scheduled-tasks-design.md`
- README 加一节 "Scheduled Tasks"，给最简启用步骤；同节明确 wechat 目标当前仅 `filehelper` 验证过。
- `docs/superpowers/specs/2026-04-17-agent-slack-architecture-design.md` 在"模块组成"段落补一条 `scheduledTasks` 模块引用。

## 10. 已知风险与权衡

| 决策 | 权衡 |
|---|---|
| 不做失败重试 | 失败大多是 prompt / LLM / 凭证类，重试无济于事；自动外发错误会刷屏。先观察 |
| CLI 与 daemon 不互锁 | 跨进程加锁成本高，撞同一时刻概率低；可接受偶发双发 |
| in-flight skip 而非排队 | 排队会破坏定时语义；并发会双发到 IM；skip 行为最直观 |
| 单目标而非 fan-out | schema 干净，复杂度低；多处需要复制任务 |
| 各 IM 各自的 `runScheduled<IM>Session` 纯函数 | 形参/依赖各异，强行统一一个 IMAdapter 方法会让形参变 union 或 unknown；保持各自具名类型 |
| daemon SIGTERM 不 graceful drain | LLM 调用可长达数十秒；阻塞退出更糟。已在 history 中以"started 无终态"显式可观察 |
| `contextToken: ''` 走 wechat sendText | spec 阶段无法断言，强制 E2E filehelper 验证；非 filehelper 暂列未支持 |
| jsonl 单文件不滚动 | 体积可控（每天最多几十次跑）；按天滚是后续可加的优化 |
