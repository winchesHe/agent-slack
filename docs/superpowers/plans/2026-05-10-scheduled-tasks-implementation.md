# 定时任务模块实施计划

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**关联 spec：** [docs/superpowers/specs/2026-05-10-scheduled-tasks-design.md](../specs/2026-05-10-scheduled-tasks-design.md)（v2 已应对两轮 review）

**Goal:** 给 daemon 装上时间驱动入口——yaml 配 cron+prompt+IM 目标，daemon 自动跑、CLI 可手动跑、结果写 jsonl 历史。

**Architecture:** 新增 `src/scheduledTasks/` 模块（config / runner / scheduler / history）；各 IM 内部新增 `runScheduled<IM>Session` 纯函数与原 inbound 路径共享底层 helper；`createSlackAdapter` / `createWechatAdapter` 返回类型由 `IMAdapter` 升级为 `{ adapter, scheduledHook, ... }` handle 结构；CLI 加 `scheduled-tasks run <id>` 子命令独立进程触发。

**Tech Stack:** TypeScript / Node / vitest / Zod / croner（新依赖）/ Bolt SDK（仅 daemon）/ Slack WebClient（CLI 直连）。

**实施约束：**
- 按 CLAUDE.md：**代码 → 测试文件 → 设计文档 → memory/process.md** 顺序推进；每片必须可运行、可观察、可验证。
- **每片落地后必须跑相关 vitest 并校验输出**（@superpowers:verification-before-completion）；不允许凭"应该没问题"提交。
- **频繁提交**：每个切片至少一个 commit；切片内部测试失败→实现→通过也鼓励拆 commit。
- **不擅自扩范围**：本计划只做 spec §1 目标列表里的事；spec 标 YAGNI 的（fan-out、重试、graceful drain 等）一律不做。

**spec 与现状已核实差异（实施时必处理）：**
1. `src/workspace/_assets.ts` 当前硬编码加载 4 个 example；本期必须新增 `SCHEDULED_TASKS_EXAMPLE` 条目。
2. `package.json` 缺 `croner` 依赖；Slice 0 安装。
3. `createSlackAdapter` / `createWechatAdapter` 当前返回单一 `IMAdapter`；Slice 5 改 handle 结构（最大改动点，影响 `createApplication`）。

---

## 文件结构

### 新建

| 文件 | 职责 |
|---|---|
| `src/scheduledTasks/types.ts` | `ScheduledTaskTarget` / `ScheduledTaskRunRecord` 等 TS 类型 |
| `src/scheduledTasks/config.ts` | Zod schema + `loadScheduledTasksConfigFile()` |
| `src/scheduledTasks/config.test.ts` | schema 单测 |
| `src/scheduledTasks/runHistory.ts` | jsonl 追加 `appendScheduledTaskRun(file, record)` |
| `src/scheduledTasks/runHistory.test.ts` | jsonl 写入单测 |
| `src/scheduledTasks/runner.ts` | `createScheduledTaskRunner({ slackHook?, wechatHook?, history, logger })` 暴露 `runOnce(rule, trigger)` |
| `src/scheduledTasks/runner.test.ts` | hook 路由、状态转换、history 序列 |
| `src/scheduledTasks/scheduler.ts` | `createScheduledTaskScheduler({ rules, runner, logger })` 基于 croner 注册/启停 + in-flight skip |
| `src/scheduledTasks/scheduler.test.ts` | fake timers / in-flight skip |
| `src/scheduledTasks/index.ts` | 模块导出 |
| `src/im/slack/scheduled.ts` | `runScheduledSlackSession()` 纯函数 |
| `src/im/slack/scheduled.test.ts` | mock WebClient 单测 |
| `src/im/wechat/scheduled.ts` | `runScheduledWechatSession()` 纯函数 |
| `src/im/wechat/scheduled.test.ts` | 单测 |
| `src/cli/commands/scheduledTasks.ts` | CLI `scheduled-tasks run <id>` 子命令 |
| `src/cli/commands/scheduledTasks.test.ts` | CLI 退出码与路由测试 |
| `examples/scheduled-tasks.example.yaml` | 模板（带"启用最少步骤"引导） |
| `src/e2e/live/run-scheduled-task-slack.ts` | 可选 live 验证脚本 |
| `src/e2e/live/run-scheduled-task-wechat.ts` | 必做 filehelper 实发脚本 |

### 修改

| 文件 | 变更 |
|---|---|
| `package.json` | 加 `croner` 依赖 |
| `src/workspace/_assets.ts` | 加 `SCHEDULED_TASKS_EXAMPLE` 条目 |
| `src/workspace/upgrade.ts` | 注册新顶层 yaml（如框架需要） |
| `src/workspace/templates/` | 加 generator（若现有框架按 _assets 自动派发则跳过；plan 阶段已发现需显式注册） |
| `src/im/slack/SlackAdapter.ts` | 抽 `runInboundSlackSession` helper；改 `createSlackAdapter` 返回 handle |
| `src/im/wechat/WechatAdapter.ts` | 抽 `runInboundWechatSession` helper；改返回 handle；加 `loadCredentialsOnly` 路径 |
| `src/im/wechat/WechatAdapter.test.ts` / `src/im/slack/SlackAdapter.test.ts` | 调用方调整（重构无行为变更，断言保持原样） |
| `src/application/createApplication.ts` | load yaml → 装配 runner/scheduler；adapters 解构 handle；顶层 `scheduledTasks` 字段 |
| `src/application/createApplication.test.ts` | 加 scheduled task 装配集成测试 |
| `src/cli/index.ts`（或主 CLI 路由） | 注册 `scheduled-tasks` 子命令 |
| `README.md` | 加 "Scheduled Tasks" 一节，附 wechat 限 filehelper 警告 |
| `docs/superpowers/specs/2026-04-17-agent-slack-architecture-design.md` | 模块组成补一条 |

---

## 切片划分（共 4 个 chunk / 12 片）

| Chunk | Slice | 目标 | 验证点 |
|---|---|---|---|
| 1：基础设施 | 0 | croner 依赖 + types | `npm install` 成功；types 文件 tsc 通过 |
| | 1 | example yaml + 模板/upgrade 注册 | `agent-slack workspace init` 在空工作区放出该文件 |
| | 2 | config schema + 加载 | `config.test.ts` 通过；非法 yaml/cron/id 重复都被拦下 |
| | 3 | runHistory jsonl | `runHistory.test.ts` 通过；并发写不交错 |
| 2：IM 集成 | 4 | 抽 `runInbound<IM>Session` 重构 | 现有 `SlackAdapter.test.ts` / `WechatAdapter.test.ts` 不改断言全过 |
| | 5 | adapter handle 返回类型改造 | `createApplication.test.ts` 通过 + 现有 adapter 测试通过 |
| | 6 | `runScheduledSlackSession` | `src/im/slack/scheduled.test.ts` 通过 |
| | 7 | `runScheduledWechatSession` | `src/im/wechat/scheduled.test.ts` 通过 |
| 3：调度与运行 | 8 | runner | `runner.test.ts` 通过；状态/路由/history 序列正确 |
| | 9 | scheduler + croner | `scheduler.test.ts` 通过（fake timers）；in-flight skip 验证 |
| | 10 | createApplication 装配 + daemon 生命周期 | 集成测试通过；手动跑 `agent-slack daemon start` 启停无栈 |
| 4：CLI 与收尾 | 11 | CLI `scheduled-tasks run <id>` | CLI 测试覆盖 exit code 0/2/3/4；本机能跑通 slack target |
| | 12 | live E2E + 文档 | filehelper 实发成功；README/架构 spec 更新；memory/process.md 归档 |

---

## Chunk 1：基础设施

### Slice 0：croner 依赖 + types

**Files:**
- Modify: `package.json`
- Create: `src/scheduledTasks/types.ts`

- [ ] **Step 0.1：安装 croner**

执行：

```bash
npm install croner@^9
```

观察点：`package.json` 出现 `"croner": "^9.x"`，`package-lock.json` 同步。

- [ ] **Step 0.2：写 types.ts**

```ts
// src/scheduledTasks/types.ts
export type ScheduledTaskTarget =
  | { im: 'slack'; channelId: string }
  | { im: 'wechat'; to: string }

export type ScheduledTaskTrigger = 'cron' | 'manual'
export type ScheduledTaskStatus = 'started' | 'success' | 'failed' | 'skipped'

export interface ScheduledTaskRunRecord {
  runId: string
  taskId: string
  trigger: ScheduledTaskTrigger
  status: ScheduledTaskStatus
  startedAt: string
  endedAt?: string
  durationMs?: number
  target: ScheduledTaskTarget
  skippedReason?: 'in-flight'
  error?: string
  finalSummary?: string
}
```

- [ ] **Step 0.3：验证类型可编译**

```bash
npx tsc --noEmit
```

期望：无新报错（types.ts 与既有代码独立，应 0 错）。

- [ ] **Step 0.4：commit**

```bash
git add package.json package-lock.json src/scheduledTasks/types.ts
git commit -m "feat(scheduledTasks): scaffold types + add croner dep"
```

---

### Slice 1：example yaml + 模板/upgrade 注册

**Files:**
- Create: `examples/scheduled-tasks.example.yaml`
- Modify: `src/workspace/_assets.ts`
- Modify: `src/workspace/upgrade.ts`（若需要）
- Modify: `src/workspace/upgrade.test.ts`（若需要）
- Modify: `src/workspace/templates/`（若现有框架按 _assets 派发则跳过；plan 阶段需先打开看一眼）

- [ ] **Step 1.1：先把 _assets.ts、upgrade.ts、templates/ 读一遍**

执行：

```bash
cat src/workspace/_assets.ts
cat src/workspace/upgrade.ts
ls src/workspace/templates/
```

观察：现有 4 个 example 是如何分发到工作区的；找出"新增一个 yaml 模板"的最小改动面。

- [ ] **Step 1.2：写 example yaml**

参考 spec §4.1：

```yaml
# .agent-slack/scheduled-tasks.example.yaml
# 定时任务示例。
# 复制为 .agent-slack/scheduled-tasks.yaml；删除本注释后改 enabled: true 即启用。

version: 1
enabled: false   # 启用：改为 true

tasks:
  - id: daily-standup
    enabled: false   # 启用：改为 true
    description: 示例：工作日 9 点总结仓库变更并发到 Slack 频道。
    cron: '0 9 * * 1-5'
    # timezone: 'Asia/Shanghai'   # 可选；默认本机时区
    prompt: |
      请总结最近 24 小时仓库的关键变更，列 3-5 条要点。
    target:
      im: slack
      channelId: C0123456789
      # im=wechat 时改为以下两行（删 channelId 行）：
      # im: wechat
      # to: filehelper
```

- [ ] **Step 1.3：在 _assets.ts 加 SCHEDULED_TASKS_EXAMPLE 条目**

按 _assets.ts 既有模式增加导出，引用 `examples/scheduled-tasks.example.yaml`。

- [ ] **Step 1.4：若 upgrade.ts 需要显式注册新模板，加上**

观察 step 1.1 输出决定。可能：模板分发表加一项 `scheduled-tasks.yaml` → `SCHEDULED_TASKS_EXAMPLE`。

- [ ] **Step 1.5：跑现有 workspace 测试守护漂移**

```bash
npx vitest run src/workspace
```

期望：全部通过。若 `templates.test.ts` 失败，按断言提示补 fixture。

- [ ] **Step 1.6：手动验证 init 行为**

```bash
mkdir -p /tmp/agent-slack-plan-verify && cd /tmp/agent-slack-plan-verify && rm -rf .agent-slack
node $OLDPWD/dist/cli/index.js workspace init     # 若有 build；否则用 ts-node 入口
ls .agent-slack/
```

期望：`.agent-slack/scheduled-tasks.example.yaml`（或类似命名）出现。若工作流不一致，按实际 CLI 入口调整。

- [ ] **Step 1.7：commit**

```bash
git add examples/scheduled-tasks.example.yaml src/workspace/
git commit -m "feat(workspace): register scheduled-tasks.yaml template"
```

---

### Slice 2：config schema + 加载

**Files:**
- Create: `src/scheduledTasks/config.ts`
- Create: `src/scheduledTasks/config.test.ts`

- [ ] **Step 2.1：写测试（先红）**

按 spec §4.2 / §4.3 / §4.4 写以下用例（全部必须先红）：

```ts
// src/scheduledTasks/config.test.ts
import { describe, it, expect } from 'vitest'
import { parseScheduledTasksConfig } from './config'

describe('parseScheduledTasksConfig', () => {
  it('parses minimal slack target', () => { /* ... */ })
  it('parses minimal wechat target', () => { /* ... */ })
  it('rejects duplicate task id', () => { /* ... */ })
  it('rejects invalid cron expression', () => { /* ... */ })
  it('rejects illegal channelId format', () => { /* ... */ })
  it('rejects empty prompt', () => { /* ... */ })
  it('rejects target.im=foo', () => { /* ... */ })
  it('cron parse does not register a real job (no side effect)', () => {
    // 关键：调用 parse 后等待 1 秒，确认没有任何 cron 真的在跑
    // 用 spy 监视 setTimeout / 或检查 croner 内部状态
  })
  it('defaults version=1 / enabled=false / tasks=[]', () => { /* ... */ })
})
```

跑 `npx vitest run src/scheduledTasks/config.test.ts`，期望失败。

- [ ] **Step 2.2：实现 config.ts**

按 spec §4.2 写 Zod schema。关键：

```ts
cron: z.string().min(1).superRefine((v, ctx) => {
  try {
    const c = new Cron(v, { paused: true })
    c.stop()
  } catch (e) {
    ctx.addIssue({ code: 'custom', message: `非法 cron: ${(e as Error).message}` })
  }
}),
```

`loadScheduledTasksConfigFile(path)`：文件不存在 → `undefined`；存在 → 解析 + 校验 → 抛或返回。

- [ ] **Step 2.3：跑测试**

```bash
npx vitest run src/scheduledTasks/config.test.ts
```

期望：全绿。

- [ ] **Step 2.4：commit**

```bash
git add src/scheduledTasks/config.ts src/scheduledTasks/config.test.ts
git commit -m "feat(scheduledTasks): config schema + loader"
```

---

### Slice 3：runHistory jsonl

**Files:**
- Create: `src/scheduledTasks/runHistory.ts`
- Create: `src/scheduledTasks/runHistory.test.ts`

- [ ] **Step 3.1：测试先红**

```ts
// 用例：
//  1. 不存在的目录会自动创建
//  2. 写入后文件每行一条合法 JSON，等于传入对象
//  3. 并发 10 个 append 不丢行（用 Promise.all），每行仍是合法 JSON（不交错）
```

- [ ] **Step 3.2：实现 appendScheduledTaskRun(file, record)**

并发安全策略：用 `fs.promises.appendFile` + 单进程内 Promise 链串行化（一个 module-scoped Map<file, lastPromise> 排队）。spec 不要求多进程并发安全，单进程内串行足够。

- [ ] **Step 3.3：跑测试 → 绿 → commit**

```bash
npx vitest run src/scheduledTasks/runHistory.test.ts
git add src/scheduledTasks/runHistory.ts src/scheduledTasks/runHistory.test.ts
git commit -m "feat(scheduledTasks): jsonl run history"
```

---

### 🚦 Chunk 1 退出检查

```bash
npx vitest run src/scheduledTasks src/workspace
npx tsc --noEmit
```

期望：全绿；目录里产出 types / config / history 三层。examples 模板可被 init 派发。

---

## Chunk 2：IM 集成

### Slice 4：抽 `runInbound<IM>Session` 重构

**目的：** 把 SlackAdapter / WechatAdapter 闭包里"建 InboundMessage → 建 EventSink → orchestrator.handle"的段，抽成 module-private helper，**不改任何行为**，为 Slice 6/7 引入定时版本铺路。

**Files:**
- Modify: `src/im/slack/SlackAdapter.ts`（193-253 行附近）
- Modify: `src/im/wechat/WechatAdapter.ts`（242-316 行附近）

- [ ] **Step 4.1：Slack 重构**

抽出函数（仍放在 `SlackAdapter.ts` 内部）：

```ts
async function runInboundSlackSession(args: {
  inbound: InboundMessage
  channelName: string
  web: WebClient
  deps: { orchestrator; sessionStore; runQueue; abortRegistry; renderer; workspaceLabel?; logger }
  confirmSender?: ConfirmSender
  // 注意：保持 inbound 路径所需的所有 closure 状态
}): Promise<void>
```

把现有 handler 中的 sink 构造 + orchestrator.handle 段挪进去，handler 改为构造 inbound + 调这个 helper。

- [ ] **Step 4.2：Wechat 重构同上**

抽 `runInboundWechatSession()`，把 processMessage() 里 contextToken 读取后传 sink 那段挪进去。

- [ ] **Step 4.3：跑现有 adapter 测试守护行为不变**

```bash
npx vitest run src/im/slack/SlackAdapter.test.ts src/im/wechat/WechatAdapter.test.ts
```

期望：现有断言**不改**全过。若任何断言挂了，是重构有行为变更——回退到本片起点重做。

- [ ] **Step 4.4：commit**

```bash
git add src/im/slack/SlackAdapter.ts src/im/wechat/WechatAdapter.ts
git commit -m "refactor(im): extract runInbound<IM>Session helpers (no behavior change)"
```

---

### Slice 5：adapter 返回 handle 结构

**目的：** spec §3 的核心改动点。

**Files:**
- Modify: `src/im/slack/SlackAdapter.ts`
- Modify: `src/im/wechat/WechatAdapter.ts`
- Modify: `src/application/createApplication.ts`（adapters 装配点）
- Modify: `src/application/createApplication.test.ts`（如装配契约测试需要）

- [ ] **Step 5.1：Slack handle**

```ts
export interface SlackAdapterHandle {
  adapter: IMAdapter
  scheduledHook: {
    run: (args: { taskId: string; channelId: string; prompt: string }) => Promise<void>
  }
}
export function createSlackAdapter(deps): SlackAdapterHandle
```

`scheduledHook.run` 闭包暂时抛 `not-implemented` —— Slice 6 才填实现（先保返回类型契约，让上层装配能编译）。

- [ ] **Step 5.2：Wechat handle**

```ts
export interface WechatAdapterHandle {
  adapter: IMAdapter
  scheduledHook: {
    run: (args: { taskId: string; to: string; prompt: string }) => Promise<void>
  }
  loadCredentialsOnly: (file: string) => Promise<WechatCredentials>
}
```

`scheduledHook.run` 同样先 throw。`loadCredentialsOnly` 现在就实现（CLI 模式独立用到）：仅读凭证文件，缺失抛 `MissingWechatCredentialsError`，不触发 QR 登录。

- [ ] **Step 5.3：createApplication 解构**

```ts
const slackHandle = createSlackAdapter(...)
const wechatHandle = createWechatAdapter(...)
const adapters = [slackHandle.adapter, wechatHandle.adapter].filter(...)
// hooks 先在内存里持有，Slice 10 再传给 runner
```

- [ ] **Step 5.4：跑全量测试**

```bash
npx vitest run src/im src/application
```

期望：全过。若有调用方因返回值变化挂了，调整调用方（不应有，因为 adapter 仅在 createApplication 内消费）。

- [ ] **Step 5.5：commit**

```bash
git add src/im/slack/SlackAdapter.ts src/im/wechat/WechatAdapter.ts src/application/createApplication.ts src/application/createApplication.test.ts
git commit -m "feat(im): adapters return handle (adapter + scheduledHook) for daemon-mode wiring"
```

---

### Slice 6：`runScheduledSlackSession`

**Files:**
- Create: `src/im/slack/scheduled.ts`
- Create: `src/im/slack/scheduled.test.ts`
- Modify: `src/im/slack/SlackAdapter.ts`（`scheduledHook.run` 内部调本片纯函数）

- [ ] **Step 6.1：测试先红**

```ts
// 用例：
//  1. root postMessage 被调用，channel/text 正确，text 模板含 taskId
//  2. orchestrator.handle 被调用，inbound.threadTs === root.ts，userId='scheduler'
//  3. confirmSender 不传（spec §6.3）
//  4. root postMessage 失败 → 抛出原始错（runner 负责 catch）
//  5. orchestrator.handle 抛错 → 直接传播
//  6. sessionId === `slack:${channelId}:${rootTs}`（与 inbound 同构）
```

- [ ] **Step 6.2：实现 runScheduledSlackSession**

按 spec §5.2 Slack 路径：

```ts
export async function runScheduledSlackSession(args: RunScheduledSlackArgs) {
  const root = await args.web.chat.postMessage({
    channel: args.channelId,
    text: `[定时任务: ${args.taskId}] 启动…`,
  })
  if (!root.ok || !root.ts) throw new Error('root-post-failed')

  const inbound: InboundMessage = {
    imProvider: 'slack',
    channelId: args.channelId,
    channelName: /* 复用 deps.resolveChannelName 或落 channelId */,
    threadTs: root.ts,
    messageTs: root.ts,
    userId: 'scheduler',
    userName: 'scheduler',
    text: args.prompt,
  }

  // 复用 Slice 4 抽出的 runInboundSlackSession 内部逻辑（不走 runQueue.enqueue）
  // 直接构造 sink + orchestrator.handle
}
```

- [ ] **Step 6.3：在 SlackAdapter.ts 把 scheduledHook.run 接通**

去掉 Slice 5.1 留的 throw，闭包调本片纯函数。

- [ ] **Step 6.4：跑测试**

```bash
npx vitest run src/im/slack
```

期望：全过。

- [ ] **Step 6.5：commit**

```bash
git add src/im/slack/scheduled.ts src/im/slack/scheduled.test.ts src/im/slack/SlackAdapter.ts
git commit -m "feat(slack): runScheduledSlackSession + wire scheduledHook"
```

---

### Slice 7：`runScheduledWechatSession`

**Files:**
- Create: `src/im/wechat/scheduled.ts`
- Create: `src/im/wechat/scheduled.test.ts`
- Modify: `src/im/wechat/WechatAdapter.ts`

- [ ] **Step 7.1：测试先红**

```ts
// 用例：
//  1. inbound 字段正确，contextToken: '' 传给 sink
//  2. orchestrator.handle 入参 inbound.threadTs === to
//  3. orchestrator 抛错 → 传播
//  4. messageTs 生成是确定性的（用注入的 nowMs 工厂）
```

- [ ] **Step 7.2：实现 runScheduledWechatSession**

按 spec §5.2 Wechat 路径，contextToken 显式空串。

- [ ] **Step 7.3：在 WechatAdapter.ts 把 scheduledHook.run 接通**

- [ ] **Step 7.4：测试 → 绿 → commit**

```bash
npx vitest run src/im/wechat
git add src/im/wechat/scheduled.ts src/im/wechat/scheduled.test.ts src/im/wechat/WechatAdapter.ts
git commit -m "feat(wechat): runScheduledWechatSession + wire scheduledHook"
```

---

### 🚦 Chunk 2 退出检查

```bash
npx vitest run src/im src/application src/scheduledTasks
npx tsc --noEmit
```

期望：全绿。两个 adapter 已具备 daemon-mode 定时调用能力，但还没有 scheduler 在驱动它们。

---

## Chunk 3：调度与运行

### Slice 8：runner

**Files:**
- Create: `src/scheduledTasks/runner.ts`
- Create: `src/scheduledTasks/runner.test.ts`

- [ ] **Step 8.1：测试先红**

```ts
// 用例：
//  1. rule.target.im='slack' → slackHook.run 被调；wechatHook 不被调
//  2. rule.target.im='wechat' → wechatHook.run 被调
//  3. 对应 hook 未注入（adapter-not-enabled）→ history 写 failed + error='adapter-not-enabled'
//  4. hook 抛错 → history 写 failed + error=message；不再外发
//  5. 成功路径 → history 序列：started + success；同 runId
//  6. trigger='manual' 透传到 history
//  7. status='started' 行 endedAt/durationMs 都不写
```

- [ ] **Step 8.2：实现 createScheduledTaskRunner**

按 spec §5.2 runOnce 流程，try/catch + 两行 history。

- [ ] **Step 8.3：测试 → 绿 → commit**

```bash
npx vitest run src/scheduledTasks/runner.test.ts
git add src/scheduledTasks/runner.ts src/scheduledTasks/runner.test.ts
git commit -m "feat(scheduledTasks): runner with hook routing + history"
```

---

### Slice 9：scheduler + croner

**Files:**
- Create: `src/scheduledTasks/scheduler.ts`
- Create: `src/scheduledTasks/scheduler.test.ts`

- [ ] **Step 9.1：测试先红（fake timers）**

```ts
// 用例：
//  1. start() 后到点（fake advance）→ runner.runOnce 被调，trigger='cron'
//  2. start() 是幂等的（重复 start 不会注册两次）
//  3. stop() 后到点 → runner 不再被调
//  4. in-flight：runOnce 返回 pending Promise 时再次到点 → history 写 skipped；runner 不二次调
//  5. in-flight 完成后下次到点恢复正常
//  6. 多 task 并发各自独立 in-flight 状态（A 在跑不阻 B）
//  7. timezone 默认 = Intl.DateTimeFormat().resolvedOptions().timeZone
```

注意 croner 与 vitest fake timers 协作可能需要 `vi.useFakeTimers({ shouldAdvanceTime: true })` 或 croner 暴露的 `next()` API。**实施时先快速验证 croner 在 fake timers 下能否被推进**——若不能，转用注入"now 工厂 + tick"自实现的最小调度（spec §8 没限定必须用 croner 的内部 tick）。这点在 step 9.1 前 5 分钟内验证完。

- [ ] **Step 9.2：实现 createScheduledTaskScheduler**

```ts
export function createScheduledTaskScheduler(deps: {
  rules: ScheduledTaskRule[]
  runner: ScheduledTaskRunner
  logger: Logger
}) {
  const inFlight = new Map<string, Promise<void>>()
  const jobs: Cron[] = []
  let started = false
  return {
    start() {
      if (started) return
      started = true
      for (const rule of deps.rules) {
        if (!rule.enabled) continue
        const tz = rule.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone
        const job = new Cron(rule.cron, { timezone: tz }, async () => {
          if (inFlight.has(rule.id)) {
            await runner.recordSkip(rule, 'in-flight') // 走 history
            return
          }
          const p = runner.runOnce(rule, 'cron').finally(() => inFlight.delete(rule.id))
          inFlight.set(rule.id, p)
          await p
        })
        jobs.push(job)
      }
    },
    stop() { jobs.forEach(j => j.stop()); jobs.length = 0; started = false },
  }
}
```

注：`runner.recordSkip` 或 runner 暴露 `appendSkippedRun(rule)` 都行，Slice 8 时若没加在 8.2 里要补一个公共方法或让 scheduler 直接拼 record 写 history。**实施时按更干净的方案选**（建议 scheduler 不直接碰 history，由 runner 暴露 `skip(rule)`）。

- [ ] **Step 9.3：测试 → 绿 → commit**

```bash
npx vitest run src/scheduledTasks/scheduler.test.ts
git add src/scheduledTasks/scheduler.ts src/scheduledTasks/scheduler.test.ts src/scheduledTasks/runner.ts src/scheduledTasks/runner.test.ts
git commit -m "feat(scheduledTasks): scheduler with in-flight skip"
```

---

### Slice 10：createApplication 装配 + daemon 生命周期

**Files:**
- Modify: `src/application/createApplication.ts`
- Modify: `src/application/createApplication.test.ts`
- Modify: `src/scheduledTasks/index.ts`（确保导出齐全）
- Modify: daemon 入口（若 scheduler.start/stop 不在 createApplication 自动接入，则需要 daemon 入口显式调）

- [ ] **Step 10.1：在 createApplication 装配**

按 spec §5.1：

```ts
const scheduledTasksConfig = await loadScheduledTasksConfigFile(...)
let scheduledTasks: { runner; scheduler? } | undefined
if (scheduledTasksConfig?.enabled) {
  // IM 启用交叉校验（spec §4.3）
  for (const t of scheduledTasksConfig.tasks.filter(r => r.enabled)) {
    if (!config.im.enabled.includes(t.target.im)) throw new Error(`task ${t.id} 目标 IM ${t.target.im} 未在 config.im.enabled 中启用`)
  }
  const history = createScheduledTaskRunHistory({ file: paths.scheduledTasksLog })
  const runner = createScheduledTaskRunner({
    slackHook: config.im.enabled.includes('slack') ? slackHandle.scheduledHook : undefined,
    wechatHook: config.im.enabled.includes('wechat') ? wechatHandle.scheduledHook : undefined,
    history, logger,
  })
  const scheduler = createScheduledTaskScheduler({ rules: scheduledTasksConfig.tasks.filter(r => r.enabled), runner, logger })
  scheduledTasks = { runner, scheduler }
}
return { ..., scheduledTasks }
```

- [ ] **Step 10.2：daemon 入口调 scheduler.start/stop**

找到 daemon 启动/停止入口（一般在 `src/daemon/` 或 `src/cli/commands/daemon*`），在合适位置：

```ts
app.scheduledTasks?.scheduler?.start()
// ... 在 SIGINT/SIGTERM handler 中：
app.scheduledTasks?.scheduler?.stop()
```

- [ ] **Step 10.3：集成测试**

在 `createApplication.test.ts` 补：

```ts
it('wires scheduled tasks runner + scheduler when enabled', async () => { /* ... */ })
it('skips scheduledTasks when top-level enabled=false', async () => { /* ... */ })
it('throws if a task targets a disabled IM', async () => { /* ... */ })
```

- [ ] **Step 10.4：手工 smoke test**

```bash
# 临时往 .agent-slack/scheduled-tasks.yaml 写一条 "每分钟跑一次 echo" 风格任务
# 启 daemon：
node ./dist/cli/index.js daemon start
# 观察日志和 .agent-slack/logs/scheduled-tasks.jsonl
# ctrl+c 停
```

观察点：到点真触发；history 写入；停 daemon 不留残栈。

- [ ] **Step 10.5：commit**

```bash
git add src/application/createApplication.ts src/application/createApplication.test.ts src/daemon/* src/scheduledTasks/index.ts
git commit -m "feat(scheduledTasks): wire runner/scheduler into createApplication + daemon lifecycle"
```

---

### 🚦 Chunk 3 退出检查

```bash
npx vitest run
npx tsc --noEmit
```

daemon 模式下定时任务完整闭环已通。剩 CLI 与文档。

---

## Chunk 4：CLI 与收尾

### Slice 11：CLI `scheduled-tasks run <id>`

**Files:**
- Create: `src/cli/commands/scheduledTasks.ts`
- Create: `src/cli/commands/scheduledTasks.test.ts`
- Modify: `src/cli/index.ts`（或主路由文件）

- [ ] **Step 11.1：测试先红**

按 spec §5.3 exit code 表：

```ts
// 用例：
//  1. rule id 不存在 → exit 2
//  2. rule.target.im='wechat' 且凭证缺失 → exit 3
//  3. rule.target.im 对应 IM 未在 config.im.enabled → exit 4
//  4. yaml schema 错 → exit 5
//  5. slack target 成功 → exit 0；mock 验证：
//     - 用 WebClient 直连（不启 Bolt App）
//     - 调 runScheduledSlackSession
//     - history 写入 trigger='manual'
//  6. wechat target 成功（mock loadCredentialsOnly + api）→ exit 0；history trigger='manual'
//  7. 不带 args 或带错参数 → 友好错误退出（exit 1 或子命令自身的 usage 路径）
```

- [ ] **Step 11.2：实现 commands/scheduledTasks.ts**

```ts
export async function runScheduledTaskCli(taskId: string) {
  // 1. 加载 config（yaml schema 错 → exit 5）
  // 2. 找 rule（找不到 → exit 2）
  // 3. 交叉校验 enabled IM（未启用 → exit 4）
  // 4. 按 target.im 准备依赖：
  //    - slack: new WebClient(env.SLACK_BOT_TOKEN)；构造 deps（不启 Bolt App）
  //    - wechat: wechatHandle.loadCredentialsOnly(creds)（缺失 → exit 3）
  //              api.baseUrl = creds.baseUrl（spec §5.3 强调）
  //              api.setToken(creds.token)
  // 5. 直接调 runScheduled{Slack|Wechat}Session（纯函数，不经 daemon hook）
  // 6. 复用 history（trigger='manual'）
  // 7. exit 0
}
```

注意：CLI 模式下 `createApplication()` 也会被调（要拿 orchestrator / sessionStore / renderer）。是否启动 Bolt App 需要在 `createApplication` 加一个 `mode: 'daemon' | 'cli'` 参数，或在 SlackAdapter 内部按一个 flag 决定是否真的 `app.start()`。**实施时优先看现有 createApplication 有没有这种模式开关**；没有就加一个最小的（`{ startInbound: boolean }`，CLI=false / daemon=true）。

- [ ] **Step 11.3：注册到主 CLI 路由**

`src/cli/index.ts`（或 commander/cac 入口）：

```ts
cli.command('scheduled-tasks run <id>', '手动触发一个定时任务').action(async (id) => {
  const code = await runScheduledTaskCli(id)
  process.exit(code)
})
```

- [ ] **Step 11.4：测试 → 绿**

```bash
npx vitest run src/cli/commands/scheduledTasks.test.ts
```

- [ ] **Step 11.5：本机 smoke**

```bash
# 配 enabled=true + 一条 slack task，channelId 用测试频道
node ./dist/cli/index.js scheduled-tasks run daily-standup
# 期望：频道收到 [定时任务: daily-standup] 启动… 与后续 agent 回复
# 检查 .agent-slack/logs/scheduled-tasks.jsonl 末尾两行 trigger='manual'
```

- [ ] **Step 11.6：commit**

```bash
git add src/cli/commands/scheduledTasks.ts src/cli/commands/scheduledTasks.test.ts src/cli/index.ts src/application/createApplication.ts
git commit -m "feat(cli): scheduled-tasks run <id> + cli-mode createApplication"
```

---

### Slice 12：live E2E + 文档

**Files:**
- Create: `src/e2e/live/run-scheduled-task-slack.ts`（可选）
- Create: `src/e2e/live/run-scheduled-task-wechat.ts`（**必做**）
- Modify: `README.md`
- Modify: `docs/superpowers/specs/2026-04-17-agent-slack-architecture-design.md`
- Modify: `memory/process.md`

- [ ] **Step 12.1：Wechat filehelper 实发脚本**

```ts
// src/e2e/live/run-scheduled-task-wechat.ts
// 调 runScheduledTaskCli('<id>')，target=filehelper，prompt 短
// 跑前必须在 .agent-slack/scheduled-tasks.yaml 配好一条 filehelper 任务
```

- [ ] **Step 12.2：手动跑 filehelper 实发**

```bash
node ./dist/e2e/live/run-scheduled-task-wechat.js
```

**spec §6.4 强制要求**：必须真实看到 filehelper 收到消息，否则 wechat target 不上线。
观察点：
- filehelper 实际收到消息（手机/PC 微信端肉眼）
- jsonl 末尾两行 `started + success`
- contextToken='' 在 sendText 调用日志中可见

若失败：记录失败信息到 spec §6.4 末尾 + README "未支持" 段，wechat 不上线本期（但模块依然可以发布给 slack）。

- [ ] **Step 12.3：Slack live 脚本（可选）**

按 AGENTS.md，slack 交互/UI 没变更（沿用既有 renderer），非强制。

- [ ] **Step 12.4：README "Scheduled Tasks" 段**

最简启用步骤：

```markdown
## Scheduled Tasks（定时任务）

agent-slack 支持时间驱动入口：在 `.agent-slack/scheduled-tasks.yaml` 配 cron + prompt + IM 目标，daemon 跑起就会到点触发。

1. 拷贝模板：`cp .agent-slack/scheduled-tasks.example.yaml .agent-slack/scheduled-tasks.yaml`
2. 顶层 `enabled: true`；至少一条 task 也 `enabled: true`。
3. 重启 daemon。

CLI 立刻跑一次：`agent-slack scheduled-tasks run <id>`

历史在 `.agent-slack/logs/scheduled-tasks.jsonl`。

**已知限制**：
- Wechat target 当前仅 `filehelper` 经过验证；其他联系人可能因 `context_token` 缺失被服务端拒绝。
- daemon SIGTERM 不 graceful drain；在跑的任务会被打断（history 留 `started` 无终态）。
- CLI 与 daemon 同时刻撞同一任务会双发，已知不修。
```

- [ ] **Step 12.5：架构 spec 补条目**

在 `2026-04-17-agent-slack-architecture-design.md` "模块组成"段加一行 `scheduledTasks/` 引用。

- [ ] **Step 12.6：更新 memory/process.md**

把本次实施结果落到 `memory/process.md`，包括：
- 完成的切片清单
- 实施过程中与 spec 出入的决策点（如 croner+fake timers 是否换 own scheduler、createApplication 模式开关命名）
- 待办（若 filehelper 实发不通，记录 follow-up）

- [ ] **Step 12.7：最终 commit + push 前自检**

```bash
npx vitest run
npx tsc --noEmit
git status
git log --oneline -20
```

期望：测试全绿；commit 历史可读、可分；无未跟踪文件。

```bash
git add README.md docs/superpowers/specs/2026-04-17-agent-slack-architecture-design.md memory/process.md src/e2e/live/
git commit -m "docs(scheduledTasks): README + architecture doc + memory; live filehelper script"
```

---

## 验证矩阵（每片落地后必跑）

| 切片 | 必跑命令 | 期望 |
|---|---|---|
| 0 | `npx tsc --noEmit` | 0 错 |
| 1 | `npx vitest run src/workspace` + 手工 init 看模板 | 全绿；模板落地 |
| 2 | `npx vitest run src/scheduledTasks/config.test.ts` | 全绿 |
| 3 | `npx vitest run src/scheduledTasks/runHistory.test.ts` | 全绿 |
| 4 | `npx vitest run src/im/slack/SlackAdapter.test.ts src/im/wechat/WechatAdapter.test.ts` | 全绿（断言未改） |
| 5 | `npx vitest run src/im src/application` | 全绿 |
| 6 | `npx vitest run src/im/slack/scheduled.test.ts` | 全绿 |
| 7 | `npx vitest run src/im/wechat/scheduled.test.ts` | 全绿 |
| 8 | `npx vitest run src/scheduledTasks/runner.test.ts` | 全绿 |
| 9 | `npx vitest run src/scheduledTasks/scheduler.test.ts` | 全绿 |
| 10 | `npx vitest run` + 手工 daemon smoke | 全绿 + 频道/微信里能看到产出 |
| 11 | `npx vitest run src/cli/commands/scheduledTasks.test.ts` + 手工 cli smoke | 全绿 + exit code 正确 |
| 12 | filehelper 实发 + 全量 vitest + tsc | 实发成功；测试全绿 |

---

## 失败回退策略

- **任一切片"测试先红"未真红**：怀疑测试本身有问题（用例 mock 错、断言写反）。停手分析，不要进入实现。
- **任一切片实现后某个**既有**测试挂了**（不是新加的）：是行为变更，回退本切片 commit，缩小改动面或拆更小切片。
- **filehelper 实发失败**（Slice 12.2）：按 spec §6.4 决议，wechat target 标记"未支持"，README 写明；slack 单独上线本期；wechat 留 follow-up task。
- **croner + fake timers 配合不顺**（Slice 9.1）：转用 own scheduler 最小实现（`setInterval` + cron 表达式解析库），spec §8 没强约束实现方式，行为契约不变即可。

---

## 提交规范

每个切片至少一个 commit。message 格式：

```
feat(模块): 一句话动作
refactor(模块): 一句话动作（无行为变更必标 "no behavior change"）
docs(模块): 一句话动作
```

不写 emoji、不写 Claude 署名（项目 git log 风格沿用现状）。

---

## 与现有 process.md 的对接

实施开始前，把"当前正在执行该 plan"写入 `memory/process.md`（最简一行 + 链接到本文件）。Slice 12.6 完成后归档到 `memory/archive/process-2026-05-10-scheduled-tasks.md`。
