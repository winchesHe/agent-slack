# 定时任务模块（scheduledTasks）设计

- 作者: winches
- 日期: 2026-05-10
- 状态: draft

## 1. 背景与目标

agent-slack 目前的"任务"都是入站事件驱动：
- `app_mention` / DM 由用户主动发起
- `channelTasks` 由 Slack 频道里他人消息匹配规则触发
- 微信单聊由对端消息触发

缺少**时间驱动**的入口：用户希望"工作日早上 9 点跑一段 prompt，把结果发到某个频道 / 微信会话"。本模块补这一段。

### 目标

- 通过 yaml 配置一组定时任务，每条任务独立配置 `cron`、`prompt`、投递目标 IM。
- daemon 进程启动时自动加载并按 cron 触发；停 daemon 即停调度。
- CLI `agent-slack scheduled-tasks run <id>` 支持手动触发同一任务（独立进程，不依赖 daemon 在跑）。
- 复用现有 IM 适配器的入站会话渲染管线，定时任务的进度 / 工具调用 / 最终回复用 SlackRenderer / WechatRenderer 已有路径输出。
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
┌────────────────── daemon process ──────────────────────────┐
│                                                            │
│  ScheduledTaskScheduler  ── cron fire ──┐                  │
│  (croner-based)                         │                  │
│                                         ▼                  │
│                              ScheduledTaskRunner.runOnce   │
│                                         │                  │
│                  ┌──────────────────────┴─────┐            │
│                  ▼                            ▼            │
│         SlackAdapter.runInboundSession   WechatAdapter.    │
│         (合成 InboundMessage)            runInboundSession │
│                  │                            │            │
│                  ▼                            ▼            │
│         existing pipeline: orchestrator → agent → EventSink│
│         → Renderer → IM API                                │
│                                                            │
│  ScheduledTaskRunHistory ── 包裹 fire/success/fail ──>     │
│  .agent-slack/logs/scheduled-tasks.jsonl                   │
└────────────────────────────────────────────────────────────┘

CLI: agent-slack scheduled-tasks run <id>
  └─ 独立进程 createApplication() → 直接调 runner.runOnce(rule, 'manual')
      不经过 cron，不感知 daemon 是否在跑
```

### 模块边界

新增 `src/scheduledTasks/`：

| 文件 | 职责 |
|---|---|
| `config.ts` | Zod schema、`loadScheduledTasksConfigFile()` |
| `scheduler.ts` | `createScheduledTaskScheduler({ rules, runner, logger })` 基于 `croner` 注册/启停 jobs；in-flight skip |
| `runner.ts` | `createScheduledTaskRunner({ adapters, history, logger })` 暴露 `runOnce(rule, trigger)`；路由到对应 adapter；包 try/catch；写 history |
| `runHistory.ts` | `appendScheduledTaskRun(file, record)` jsonl 追加 |
| `index.ts` | 公开导出 |
| `*.test.ts` | 同目录 vitest |

### 现有模块改动

- **`src/im/IMAdapter.ts`**：接口扩一个 `runInboundSession(args): Promise<void>`。Slack/Wechat 各自实现是把现有 `app_mention` / wechat 入站闭包里"建 sink + orchestrator.handle"那段（约 10-30 行）原地剪贴出来，无行为变更。
- **`src/im/slack/SlackAdapter.ts`**：`app_mention` 闭包改为"解析 Slack event → 组装 inbound（含 confirmSender） → 调 runInboundSession"。`runInboundSession` 内部不构造 confirmSender；由 caller 传入 inbound 时已绑定。
- **`src/im/wechat/WechatAdapter.ts`**：同上，针对入站 polling 闭包。
- **`src/application/createApplication.ts`**：load yaml → 装配 history / runner / scheduler；daemon 启动时 `scheduler.start()`，停止时 `scheduler.stop()`。
- **`src/workspace/templates/scheduledTasks.ts`**（新）：仿 `channelTasks.ts` generator，模板正文源在 `examples/scheduled-tasks.example.yaml`。
- **`src/workspace/templates/templates.test.ts`**：新增 generator 字节一致性守护。
- **`src/workspace/upgrade.ts`**：自动追加缺失顶层 key（generator 默认能力，通常不需要手改）。
- **`src/workspace/paths.ts` 或等价**：新增路径 `scheduledTasksFile`、`scheduledTasksRunsFile`。
- **`src/cli/commands/`**：新增 `scheduledTasks.ts` 命令（`run <id>`）；在 `src/cli/index.ts` 注册。

## 4. 配置与 Schema

### 4.1 yaml 模板（`examples/scheduled-tasks.example.yaml`）

```yaml
version: 1
enabled: false

tasks:
  - id: daily-standup
    enabled: false
    description: 示例：工作日早上 9 点总结仓库变更并发到 Slack 频道。
    cron: '0 9 * * 1-5'
    # timezone: 'Asia/Shanghai'
    prompt: |
      请总结最近 24 小时仓库的关键变更，列 3-5 条要点。
    target:
      im: slack
      channelId: C0123456789
      # im=wechat 改为：
      # im: wechat
      # to: filehelper
```

模板必须包含"启用最少步骤"引导（按 AGENTS.md §Env/Config 模板源规则）：顶层 `enabled: false` + 单条 `enabled: false`，注释指出"改 `enabled: true` 即启用"，并给一个 wechat target 的注释行供切换。

### 4.2 Zod schema 关键约束

```ts
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
  id: idSchema,                    // [a-zA-Z0-9_-]+
  enabled: z.boolean().default(true),
  description: z.string().optional(),
  cron: z.string().min(1).superRefine((v, ctx) => {
    try { new Cron(v) } catch (e) {
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

### 4.4 `cron` 早失败

`superRefine` 调 `new Cron(v)` 试解析；失败立刻 schema 阶段报错。

### 4.5 `timezone` 默认值

`runner` 使用 `rule.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone`。schema 阶段不强校验 IANA 字符串，croner 会在 register job 时抛错暴露。

### 4.6 配置联动检查（按 AGENTS.md §Env/Config 变更联动规则）

| 项 | 是否涉及 |
|---|---|
| 1. Schema | ✅ `src/scheduledTasks/config.ts:ScheduledTasksConfigSchema` |
| 2. 模板源 | ✅ `examples/scheduled-tasks.example.yaml` + generator `src/workspace/templates/scheduledTasks.ts` |
| 3. `agent-slack upgrade` | ✅ generator 自动追加缺失顶层 key（无需手改 upgrade.ts） |
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
   │   各自暴露 runInboundSession(args)
   ├─ if config?.enabled:
   │   ├─ build ScheduledTaskRunHistory(file)
   │   ├─ build ScheduledTaskRunner({ adapters, history, logger })
   │   └─ build ScheduledTaskScheduler({ rules: config.tasks.filter(enabled), runner, logger })
└─ daemon.start()
   ├─ slack.start() / wechat.start()
   └─ scheduler?.start()
```

### 5.2 cron fire 一次

```
croner job 按 task.cron + tz 触发
└─ scheduler 检查 in-flight Map<taskId, Promise>
   ├─ has(taskId) → history.append({ trigger:'cron', status:'skipped', skippedReason:'in-flight' })
   │                return
   └─ set(taskId, runPromise) + runner.runOnce(rule, 'cron') → 完成后 delete
      └─ runOnce(rule, trigger):
         ├─ history.append({ status:'started', trigger, startedAt })
         ├─ adapter = adapters[rule.target.im]
         │   adapter 不存在 / 未启用 → status:'failed', error:'adapter-not-available'
         ├─ Slack 路径：
         │   ├─ web.chat.postMessage({ channel, text:`[定时任务: ${rule.id}] 启动…` })
         │   │   失败 → status:'failed', error:'root-post-failed'
         │   ├─ inbound = {
         │   │     imProvider:'slack', channelId, channelName:<resolved>,
         │   │     threadTs:<root ts>, messageTs:<root ts>,
         │   │     userId:'scheduler', userName:'scheduler',
         │   │     text: rule.prompt
         │   │     // 不带 confirmSender
         │   │   }
         │   └─ adapters.slack.runInboundSession({ inbound, web })
         │       内部：build SlackEventSink → orchestrator.handle(inbound, sink)
         ├─ Wechat 路径：
         │   ├─ inbound = {
         │   │     imProvider:'wechat', channelId: target.to, channelName: target.to,
         │   │     threadTs: target.to, messageTs:<生成 id>,
         │   │     userId:'scheduler', userName:'scheduler',
         │   │     text: rule.prompt
         │   │   }
         │   └─ adapters.wechat.runInboundSession({ inbound })
         ├─ 成功：history.append({ status:'success', endedAt, durationMs, finalSummary? })
         └─ 异常：history.append({ status:'failed', endedAt, error: <message> })
            异常已由 EventSink 渲染到目标会话（sink 自带错误渲染）
```

### 5.3 CLI 手动触发

```
agent-slack scheduled-tasks run <id>
└─ createApplication()  // 独立进程
   ├─ load yaml → 找 rule by id
   │   未找到 → exit code 2
   ├─ 仅按 rule.target.im 启动一个 adapter
   │   slack: SocketMode 临时连 Bolt 拿 WebClient
   │   wechat: 复用已登录 session（依赖凭证）；未登录 → exit code 3
   └─ runner.runOnce(rule, 'manual')
      └─ 同 5.2 后半段，写同一份 history jsonl
   exit
```

CLI 与 daemon 互不感知；同时刻撞上偶发会发两条，按已确认接受。

### 5.4 history jsonl 记录格式

每行一个 JSON：

```json
{
  "taskId": "daily-standup",
  "trigger": "cron" | "manual",
  "status": "started" | "success" | "failed" | "skipped",
  "startedAt": "2026-05-10T01:00:00.000Z",
  "endedAt": "2026-05-10T01:00:23.451Z",
  "durationMs": 23451,
  "target": { "im": "slack", "channelId": "C0123" },
  "skippedReason": "in-flight",
  "error": "...",
  "finalSummary": "首句 / 前 200 字符截断"
}
```

`status:'started'` 也要写一行，方便排查跑了一半挂掉的进程（看不到对应的 success/failed）。

## 6. 错误处理

| 场景 | 行为 |
|---|---|
| yaml 不存在 | 模块禁用，无报错（同 channelTasks 风格） |
| yaml schema 错 | daemon 启动阶段抛，拒起 |
| 顶层 `enabled:false` | scheduler 不创建，也不写 history |
| 单条 `enabled:false` | 不注册 cron；CLI run 仍可手动触发（已 enabled 字段不限制 manual） |
| `target.im` 对应 adapter 未启用 | yaml 加载阶段拦下（4.3） |
| 同任务正在跑，cron 又到点 | skip + 写 jsonl |
| `runInboundSession` 抛错 | runner catch；EventSink 已渲染失败到会话；写 failed |
| Slack 根消息 postMessage 失败 | 不进入 orchestrator；写 `error:'root-post-failed'` |
| Wechat 凭证失效 | sendText 失败由 EventSink 处理（如能渲染）；history failed |
| daemon stop | scheduler.stop() 取消所有 cron；in-flight 自然跑完不强杀 |
| ask-confirm tool 在 scheduled run 中被调用 | confirmSender=undefined → tool 抛 → EventSink 渲染失败 → history failed |
| cron 跨夏令时跳过 | 由 croner 处理；不专门补救 |

## 7. 测试策略

按 AGENTS.md：vitest，`*.test.ts` 与源文件同目录，跨模块集成测试放 `tests/`。

### 7.1 单测

| 文件 | 覆盖点 |
|---|---|
| `src/scheduledTasks/config.test.ts` | 合法解析、缺字段、id 重复、cron 非法、target 缺字段、im 与 enabled IMs 交叉校验 |
| `src/scheduledTasks/scheduler.test.ts` | fake timers 推进 + 断言 runner.runOnce 触发；in-flight skip；start/stop 幂等；多 task 并发不互锁 |
| `src/scheduledTasks/runner.test.ts` | adapter 路由、history 事件序列、adapter 抛错仍写 failed、'manual' trigger 标签 |
| `src/scheduledTasks/runHistory.test.ts` | jsonl 追加格式；并发写不交错丢行 |

### 7.2 集成测

- 扩 `src/application/createApplication.test.ts`：一条 enabled task + 假 adapter（spy `runInboundSession`），fake timers 推进，断言合成 InboundMessage 字段 + jsonl 写入。

### 7.3 已有 adapter 测试守护重构

- `src/im/slack/SlackAdapter.test.ts` / `src/im/wechat/WechatAdapter.test.ts`：`runInboundSession` 抽出无行为变更，所有现有测试不应改断言。这是回归保险。

### 7.4 CLI 测

- `src/cli/commands/scheduledTasks.test.ts`：`run <id>` 命令未找到 rule、target IM 未启用、成功路径调用 runner.runOnce(_, 'manual')。

### 7.5 Live E2E（非强制）

- 按 AGENTS.md，仅 Slack 交互/UI 变更必须补 live E2E。本模块发出的是普通消息，渲染走已有路径。
- 建议加一个 `src/e2e/live/run-scheduled-task.ts` 手动触发 slack target 的 task，肉眼验消息发出。作为加分项。

## 8. 依赖与库选择

新增 npm 依赖：

- **`croner`**（轻量、无依赖、IANA tz 支持完善）。MIT。

替代候选：`node-cron`（不支持 tz override）、`cron`（依赖 luxon，重）。**选 croner**。

## 9. 文档与上游联动

- 本 spec：`docs/superpowers/specs/2026-05-10-scheduled-tasks-design.md`
- README 加一节 "Scheduled Tasks"，给最简启用步骤
- `docs/superpowers/specs/2026-04-17-agent-slack-architecture-design.md` 在"模块组成"段落补一条 `scheduledTasks` 模块引用

## 10. 风险与权衡

| 决策 | 权衡 |
|---|---|
| 不做失败重试 | 失败大多是 prompt / LLM / 凭证类，重试无济于事；自动外发错误会刷屏。先观察 |
| CLI 与 daemon 不互锁 | 跨进程加锁成本高，撞同一时刻概率低；可接受偶发双发 |
| in-flight skip 而非排队 | 排队会破坏定时语义；并发会双发到 IM；skip 行为最直观 |
| 单目标而非 fan-out | schema 干净，复杂度低；多处需要复制任务 |
| 抽 `runInboundSession` 而非伪造 Bolt 事件 | 不依赖第三方 SDK 内部形状；改动局限在 adapter 内部 |
| 不带 `confirmSender` | scheduled 无人在场，ask-confirm 失败优于无限等待 |
| jsonl 单文件不滚动 | 体积可控（每天最多几十次跑）；按天滚是后续可加的优化 |
