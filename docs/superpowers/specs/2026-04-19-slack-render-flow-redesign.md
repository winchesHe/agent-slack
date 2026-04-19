# Slack Render Flow 重设计

**日期**：2026-04-19
**状态**：已实装
**替代**：`docs/superpowers/specs/2026-04-17-agent-slack-architecture-design.md` §2.2 / §4 中 `EventSink` / `AgentExecutionEvent` / SlackRenderer 相关段落；作废 `docs/superpowers/plans/2026-04-18-M2-renderer.md`

---

## 1. 背景与动机

### 1.1 现状

- 原 architecture spec（2026-04-17）定义了 `AgentExecutionEvent` 为 AI SDK 细粒度事件（`text_delta` / `tool_input_delta` / `tool_call_*` / `step_*` / `done`）。
- 原 M2 plan（2026-04-18）基于这套细粒度事件设计了"占位消息编辑流"——一切（thinking / tool / 正文 / cost）都通过 `chat.update` 改写同一条 placeholder 消息。
- 实际实装（M1 已落、M2 部分已落）和参考实现 kagura 的 `slackRender` 差异巨大，UX 体验不符合预期。

### 1.2 与 kagura 的核心差异（根因）

| 维度 | kagura（参考） | 当前设计 | 后果 |
|---|---|---|---|
| **UI 载体** | 3 个分工：状态条 + progress message + reply messages | 1 个 placeholder 通吃 | 过程态与结果态混在同一条消息，不干净 |
| **thinking 显示** | `assistant.threads.setStatus` 原生状态条 + `loading_messages` 轮换 | placeholder 文本直接 update | 非原生体验 |
| **tool 展示** | 收敛到 `toolHistory: Map<name, count>`，聚合显示 | 每个 tool 事件即时刷 blocks | 噪音多、难读 |
| **最终回复** | 每个 `assistant-message` 事件 = 一条**新** thread reply，`splitBlocksWithText` 自然分批 | 累积到同一 buffer，最终 update 同一条 | 多轮回复无法自然呈现 |
| **usage** | finalize 时独立 post 一条 context message | 附加到 placeholder 末尾 | 不易跨 turn 累计 |
| **事件粒度** | Agent SDK 粗粒度事件（`activity-state` / `assistant-message` / `lifecycle`） | AI SDK 细粒度事件 | 驱动模型错位 |
| **节流** | 基于 state key 变化幂等去重 | 基于时间 debounce | 易抖易卡 |

**症结**：当前设计把"过程态"和"结果态"挤在同一条消息里编辑；kagura 把两者分开（状态条/progress 显示过程 → 过程结束后删除/收尾 → 最终消息独立 post）。

### 1.3 本次设计的 3 条核心决策

1. **UI 三载体模型**（对齐 kagura）：状态条 + progress message + reply messages 分工；本项目运行环境已确认启用 Slack Assistant feature，状态条直接使用 `assistant.threads.setStatus`，不保留降级开关。
2. **聚合层下沉到 Executor**：对外事件改为粗粒度 4 类（`activity-state` / `assistant-message` / `lifecycle` / `usage-info`），AI SDK 细粒度流只在 `AiSdkExecutor` 内部处理。
3. **Renderer 无状态、Sink 有状态**：`SlackRenderer` 是纯 I/O 门面；`SlackEventSink` 持有该 turn 本地状态（progress ts、toolHistory、lastStateKey 等），消费事件并编排 renderer 调用。

---

## 2. 事件 Schema（粗粒度，替换原 spec §2.2 细粒度定义）

```ts
// src/core/events.ts —— 重写

export type AgentExecutionEvent =
  | { type: 'activity-state'; state: ActivityState }
  | { type: 'assistant-message'; text: string }
  | { type: 'usage-info'; usage: SessionUsageInfo }
  | { type: 'lifecycle'; phase: LifecyclePhase; reason?: StopReason;
      error?: { message: string };
      finalMessages?: import('ai').ModelMessage[] }   // completed 必带；stopped 可带（有则代表有部分已完成 step 的消息）

export type LifecyclePhase = 'started' | 'completed' | 'stopped' | 'failed'
export type StopReason = 'user' | 'superseded' | 'shutdown'

export interface ActivityState {
  status: string                   // 主文案：'思考中…' / '回复中…' / '推理中…' / '正在 <tool>…'
  activities: string[]             // Slack loading_messages 池（客户端轮换）
  composing?: boolean              // 是否进入"出文本"阶段
  clear?: boolean                  // 清空状态条 / 删除 progress message
  newToolCalls?: string[]          // 累计 toolHistory 用（不参与 key diff）。值为 display label（bash 工具带命令：`bash(cat config.yaml)`；其他工具保持原名）
  reasoningTail?: string           // 当前 reasoning 末尾摘要，≤80 char
}

export interface SessionUsageInfo {
  durationMs: number
  totalCostUSD: number             // 0 表示未能从 providerMetadata 读到 cost
  modelUsage: Array<{
    model: string
    inputTokens: number
    outputTokens: number
    cachedInputTokens: number
    cacheHitRate: number           // 0–1，total=0 时为 0
  }>
}
```

### 2.1 设计要点

- **`activity-state` 是快照 + key diff 去重**：每次状态变化 emit 完整 `ActivityState`；IM 侧 `JSON.stringify(state without newToolCalls)` 做 diff，相同则跳过。`newToolCalls` 不参与 diff（每次有新 tool 都该累加）。
- **`assistant-message` 按 step 边界切**：AI SDK 一个 step 内的全部 text-delta 累积后，`step-finish` 时作为**一段完整消息** emit。
- **`lifecycle { completed }` 必带 `finalMessages`**：`streamText().response.messages` 的完整 ModelMessage 数组，供 Orchestrator 整批写 jsonl（含 assistant text / tool-call / tool-result）。
- **`lifecycle { stopped }` 可带 `finalMessages`**：abort 时若已有若干个 step-finish 的完整消息，executor 仍携带已完成 step 对应的 ModelMessage（从 `result.response` 提取，best-effort；不可得则 undefined）；未完成 step 的 text buffer 丢弃。这保证记忆在中断后仍正确。
- **`error` 事件已删除**：所有错误经 `lifecycle { failed, error: { message } }`。
- **流式 token 不对外**：不做"文本逐字浮现"，过程感由 progress message 承担。
- **Reasoning 一期就做**：但经 `reasoningTail` 字段表达，不单独加事件类型；无显式 reasoning 结束事件，由后续 `text-delta` / `tool-call-streaming-start` / `step-finish` 隐式结束（见 §6.2）。
- **`toolDisplayLabel` 与 Sink 聚合**：Executor 的 `toolDisplayLabel(toolName, args)` 为 bash 工具生成 `bash(cmd_truncated)` 格式 label（自动剥去 `cd <path> && ` 前缀，截断 40 字符），其他工具原名不变。Sink 侧 `toolHistory` 按 base name 聚合计数（`extractBaseToolName()` 从 display label 提取 base name），`toolLatestLabel` 记录每个 base name 的最新 display label。渲染时 `toDisplayToolHistory()` 将 base name 计数转为 display label 版本，最终呈现如 `🔧 bash(cat config.yaml) x3 · edit_file x1`。
- **`clear` emit 时机**：executor 不在流正常完成时 emit `{ clear: true }`（让 sink 的 `finalize()` 统一管理 progress 消息终态）；仅在 abort 时 emit（让 sink 停止所有状态显示后再由 orchestrator 触发 finalize）。

---

## 3. 架构分层

```
┌─────────────────────────────────────────────────────┐
│  SlackAdapter                                       │
│    解析 app_mention → sourceMessageTs + userName    │
│    入队 SessionRunQueue → ConversationOrchestrator  │
└──────────────────────┬──────────────────────────────┘
                       ▼
┌─────────────────────────────────────────────────────┐
│  ConversationOrchestrator                           │
│    per-handle 构建 SlackEventSink                   │
│    per-handle 构建 AiSdkExecutor（注入 tools）      │
│    AbortRegistry.create / delete                    │
│    for await event of executor.execute():          │
│        sink.onEvent(event)                          │
│        (lifecycle:completed → 整批落盘 finalMessages) │
│        (lifecycle:stopped/failed → 追加占位消息)    │
│    finally: sink.finalize()                         │
└──────────────────────┬──────────────────────────────┘
                       ▼
┌─────────────────────────────────────────────────────┐
│  AiSdkExecutor                                      │
│    消费 streamText().fullStream 细粒度事件          │
│    内部 AggregatorState：stepTextBuffer /           │
│      activeTools /                                  │
│      modelUsage / currentReasoning / composing      │
│    yield 4 类粗粒度事件                             │
└─────────────────────────────────────────────────────┘
                       │（事件流）
                       ▼
┌─────────────────────────────────────────────────────┐
│  SlackEventSink（有状态协调器）                     │
│    SinkLocalState：progressMessageTs /              │
│      progressActive / toolHistory /                 │
│      lastStateKey / terminalPhase / pendingUsage    │
│    事件 → renderer 方法调用                         │
└──────────────────────┬──────────────────────────────┘
                       ▼
┌─────────────────────────────────────────────────────┐
│  SlackRenderer（无状态门面）                        │
│    所有方法 = 一次 Slack API 调用，内置 safeRender  │
│    瞬态错误（429/网络）吞掉 + warn；无 feature flag │
└─────────────────────────────────────────────────────┘
```

---

## 4. SlackRenderer 接口

`src/im/slack/SlackRenderer.ts`

```ts
import type { WebClient } from '@slack/web-api'
import type { Logger } from '@/logger/logger.ts'
import type { SessionUsageInfo } from '@/core/events.ts'

export interface SlackRendererDeps {
  logger: Logger
  // Note: Slack Assistant feature 在本项目部署环境已确认启用（assistant:write scope + Assistant 已开启），
  // 不再保留 feature flag / 首次失败自动降级逻辑。setStatus/clearStatus 单次失败仅 logger.warn 吞掉，
  // 由 safeRender 统一兜底，不触发进程级开关。
}

export interface ProgressUiState {
  status: string
  activities: string[]
  toolHistory: Map<string, number>
  composing?: boolean
  reasoningTail?: string
}

export interface SlackRenderer {
  // ── 反应 ─────────────────────────────────
  addAck(client: WebClient, channelId: string, messageTs: string): Promise<void>       // 👀
  addDone(client: WebClient, channelId: string, messageTs: string): Promise<void>      // ✅
  addError(client: WebClient, channelId: string, messageTs: string): Promise<void>     // ❌
  addStopped(client: WebClient, channelId: string, messageTs: string): Promise<void>   // ⏹️

  // ── 状态条 (Slack Assistant，直接调用；瞬态失败由 safeRender 吞掉) ──
  setStatus(client: WebClient, channelId: string, threadTs: string,
            status: string, loadingMessages?: string[]): Promise<void>
  clearStatus(client: WebClient, channelId: string, threadTs: string): Promise<void>

  // ── Progress message ──
  upsertProgressMessage(client: WebClient, channelId: string, threadTs: string,
                        state: ProgressUiState, prevTs?: string): Promise<string | undefined>
  finalizeProgressMessageDone(client: WebClient, channelId: string, threadTs: string,
                              prevTs: string, toolHistory: Map<string, number>): Promise<void>
  finalizeProgressMessageStopped(client: WebClient, channelId: string, threadTs: string,
                                 prevTs: string): Promise<void>
  finalizeProgressMessageError(client: WebClient, channelId: string, threadTs: string,
                               prevTs: string, errorMessage: string): Promise<void>
  deleteProgressMessage(client: WebClient, channelId: string, threadTs: string,
                        prevTs: string): Promise<void>

  // ── Reply messages（自动 markdown 分块） ──
  // 用 markdown-to-slack-blocks + splitBlocksWithText 自然分批
  postThreadReply(client: WebClient, channelId: string, threadTs: string,
                  text: string, options?: { workspaceLabel?: string }): Promise<void>

  // ── Usage info ──
  postSessionUsage(client: WebClient, channelId: string, threadTs: string,
                   usage: SessionUsageInfo): Promise<void>
}

export function createSlackRenderer(deps: SlackRendererDeps): SlackRenderer
```

### 4.1 Renderer 内部设计要点

- **每个方法一个 `safeRender(label, fn)` 包装**：catch 所有 Slack API 错误 → `logger.warn` → return undefined。调用方零 try/catch 负担。
- **`setStatus` / `clearStatus` 直接调用**：Slack Assistant feature 在本项目环境确认启用（`assistant:write` scope + Assistant 已装配），单次失败由 `safeRender` 吞掉并 warn，不触发任何进程级降级或开关。
- **`postThreadReply` 内部分块**：`markdownToBlocks(normalizeUnderscoreEmphasis(text), { preferSectionBlocks: false })` → `splitBlocksWithText(blocks)` → 多次 `chat.postMessage(thread_ts)`。`workspaceLabel` 作为第一段 blocks 的前缀 context block（仅一期可不用）。
- **`upsertProgressMessage` 渲染顺序**：
  ```
  [context] 🔧 toolHistory 行（如 "🔧 bash(cat config.yaml) x2 · edit_file x1"），空则跳过
  [context] 🤔 reasoningTail 行，缺则跳过
  [context] 最新 activity 行（取 activities 最后一条去重）
  ```
- **`finalizeProgressMessage*` 三个变体**：done → `✅ 完成 · <toolHistory>`；stopped → `已被用户中止`；error → `⚠️ 出错：<msg>`。保留 ts 不删，用户可回看。
- **`postSessionUsage` 格式**（沿用 kagura）：
  `11.2s · $0.0676 · sonnet-4-6: 424 non-cached in+out (62% cache)`
  - 无 cost → 跳过 `$X.XXXX` 段
  - 无 cacheHit → 跳过 `(62% cache)` 段

---

## 5. SlackEventSink 状态机

`src/im/slack/SlackEventSink.ts`

```ts
export interface SlackEventSinkDeps {
  web: WebClient
  channelId: string
  threadTs: string
  sourceMessageTs: string              // 用户原 @mention 的 ts
  workspaceLabel?: string
  renderer: SlackRenderer
  logger: Logger
}

interface SinkLocalState {
  progressMessageTs?: string
  progressActive: boolean
  toolHistory: Map<string, number>      // key = base tool name（如 "bash"），按 base name 累加计数
  toolLatestLabel: Map<string, string>  // key = base tool name，value = 最新一次的 display label（如 "bash(cat config.yaml)"）
  lastStateKey?: string
  hasSentToolbarInTurn: boolean
  terminalPhase?: 'completed' | 'stopped' | 'failed'
  terminalStopReason?: StopReason
  terminalErrorMessage?: string
  pendingUsage?: SessionUsageInfo
}

export interface SlackEventSink {
  onEvent(event: AgentExecutionEvent): Promise<void>
  finalize(): Promise<void>
  readonly terminalPhase: 'completed' | 'stopped' | 'failed' | undefined
}

export function createSlackEventSink(deps: SlackEventSinkDeps): SlackEventSink
```

### 5.1 事件 → 动作映射

| 事件 | Sink 行为 |
|---|---|
| `lifecycle { started }` | `renderer.addAck(sourceMessageTs)`；`renderer.setStatus('思考中…', shuffled loading pool)` |
| `activity-state { state }` | **先 key diff 去重**（仅当 `state.newToolCalls` 为空时才因 key 相同跳过；有 newToolCalls 必处理）；若有 `state.newToolCalls` → 累加到 `toolHistory`；<br>若 `state.clear` → 删 progress（删除后立即将 `progressMessageTs = undefined`、`progressActive = false`）+ `clearStatus`；<br>若已有 progress：`upsertProgressMessage(..., mergedState, prevTs)` → 仅当返回 ts 非 undefined 时才覆写 `progressMessageTs`（safeRender 失败时保留旧值避免丢失引用）；<br>若无 progress 且状态"有意义"（§5.3）→ 先 `clearStatus`（让状态条让位），再 `upsertProgressMessage`（首次激活），进而 `progressActive = true`；<br>其他情况：调 `setStatus(state.status, loadingMessagesWithReasoning)`，其中 `loadingMessagesWithReasoning = state.reasoningTail ? [...state.activities, '🤔 ' + state.reasoningTail] : state.activities`（即 reasoningTail 作为最后一条 loading_message 追加） |
| `assistant-message { text }` | `renderer.postThreadReply(text, { workspaceLabel? })`（仅第一段带 workspaceLabel，随后 `hasSentToolbarInTurn = true`）；若 progress 存在 → `deleteProgressMessage`，`progressActive = false`，`progressMessageTs = undefined`；**toolHistory 不清**（跨 step 累计，finalize 时一起展示；这是相对 kagura 的**刻意偏离**——kagura 每发一条 reply 清一次 toolHistory，我们不清，因为 kagura 依赖 Claude SDK 的 activity 叙事，单轮 reply 即"收尾"语义；我们是按 step 发，累计更利于用户最终看到一 turn 内完整工具轨迹）；`lastStateKey = undefined`（下一轮重新上画）；`setStatus('思考中…', ...)` 让下一 step 继续有状态 |
| `usage-info { usage }` | 暂存 `pendingUsage = usage`（仅 completed 用；stopped/failed 不发 usage） |
| `lifecycle { completed, finalMessages }` | `terminalPhase = 'completed'`；finalMessages 不在 sink 里消费（orchestrator 在同一事件里直接读并落盘——见 §7.1）；真正的 UI finalize 在 orchestrator finally 调 `sink.finalize()` |
| `lifecycle { stopped, reason }` | `terminalPhase = 'stopped'`；`terminalStopReason = reason` |
| `lifecycle { failed, error }` | `terminalPhase = 'failed'`；`terminalErrorMessage = error.message` |

**状态转移幂等性**：`terminalPhase` **首次写入后不再改写**（first-write-wins）。避免在流正常 finish 后，外层再发生 abort/error 导致重复转移。

### 5.2 `finalize()`

```
clearStatus()

if progressMessageTs:
  switch terminalPhase:
    'completed' → finalizeProgressMessageDone(prevTs, toolHistory)
    'stopped'   → finalizeProgressMessageStopped(prevTs)
                  (reason = 'superseded' 时改 deleteProgressMessage)
    'failed'    → finalizeProgressMessageError(prevTs, terminalErrorMessage)

if terminalPhase == 'completed' && pendingUsage:
  postSessionUsage(pendingUsage)

switch terminalPhase:
  'completed' → addDone(sourceMessageTs)       // ✅
  'stopped'   → addStopped(sourceMessageTs)    // ⏹️
  'failed'    → addError(sourceMessageTs)      // ❌
```

### 5.3 "有意义状态"判定

`activity-state` 触发"首次激活 progress"的条件（避免 thinking 默认态就开 progress）：

```ts
function isMeaningful(state: ActivityState): boolean {
  if (state.clear) return false
  if (state.composing) return true
  if (state.reasoningTail) return true
  // status 非默认思考态（含 tool 文案或"推理中…"/"回复中…"等）
  if (state.status && state.status !== STATUS.thinking) return true
  // 或 newToolCalls 非空
  if (state.newToolCalls && state.newToolCalls.length > 0) return true
  return false
}
```

**快照 → meaningful 判定对照表**（pin 行为，便于单测）：

| 快照 | meaningful |
|---|---|
| `{ status:'思考中…', activities: POOL }` | ❌ |
| `{ status:'思考中…', activities: POOL, composing: true }` | ✅ |
| `{ status:'回复中…', activities: POOL }` | ✅（status ≠ 思考中） |
| `{ status:'推理中…', activities: POOL, reasoningTail:'...' }` | ✅ |
| `{ status:'正在 read_file…', activities: [...], newToolCalls:['read_file'] }` | ✅ |
| `{ status:'思考中…', activities: POOL, newToolCalls:['bash'] }` | ✅ |
| `{ clear: true }` | ❌（且触发 delete 分支，不走激活路径） |

**Progress 一旦进入 finalized 状态（completed/stopped/error），其 ts 不再存于 sink state**——finalize 后 sink 直接清空引用，后续再来的事件（理论上不该有，但防御性）不会尝试 upsert 到已 finalized 的消息。

---

## 6. AiSdkExecutor 聚合算法

`src/agent/AiSdkExecutor.ts`

### 6.1 AggregatorState

```ts
interface AggregatorState {
  // per-turn
  turnStartedAt: number
  modelUsage: Map<string, {
    inputTokens: number
    outputTokens: number
    cachedInputTokens: number
    costUSD?: number
  }>
  lastEmittedActivityKey?: string
  defaultLoadingMessages: string[]       // shuffle 取 8 条

  // per-step
  stepTextBuffer: string
  activeTools: Map<string, { toolName: string; status: 'input' | 'running' }>
  composing: boolean

  // reasoning
  currentReasoning: string
  lastReasoningEmitAt: number
}
```

### 6.2 AI SDK fullStream → 粗粒度事件映射

> **已核实**：当前依赖 `ai@4.3.19`，`fullStream` 的 `TextStreamPart<TOOLS>` 联合类型（见 `node_modules/ai/dist/index.d.ts` ~L2819）包含下列 part：
> `text-delta` / `reasoning` / `reasoning-signature` / `redacted-reasoning` / `source` / `file` / `tool-call` / `tool-call-streaming-start` / `tool-call-delta` / `tool-result` / `step-start` / `step-finish` / `finish` / `error`。
> **无** `start` / `text-start` / `text-end` / `reasoning-end` / `tool-input-start` 等 v5 名字。本表按 v4 实际 part 名映射。

| fullStream part | 行为 |
|---|---|
| （executor `execute()` 入口，fullStream 开始前） | `turnStartedAt = Date.now()`；shuffle `defaultLoadingMessages`；emit `lifecycle { started }`；emit `activity-state { status: '思考中…', activities: defaultLoadingMessages }` |
| `step-start` | reset `stepTextBuffer`，`composing = false`；`activeTools` 跨 step 持有，`tool-result` 才删；不 emit 事件 |
| `text-delta` { textDelta } | `stepTextBuffer += textDelta`；若 `currentReasoning` 非空 → 视为 reasoning 结束：`currentReasoning = ''`；若 `composing === false` → `composing = true`，emit `activity-state { status: '回复中…', activities: [...defaultLoadingMessages, '正在整理回复…'], composing: true }` |
| `reasoning` { textDelta } | `currentReasoning += textDelta`；节流：累计自上次 emit ≥ 30 chars 或距上次 ≥ 800ms → emit `activity-state { status: '推理中…', activities: defaultLoadingMessages, reasoningTail: currentReasoning.replace(/\s+/g,' ').trim().slice(-80) }` |
| `reasoning-signature` / `redacted-reasoning` | 忽略 |
| `source` / `file` | 一期忽略（非 codex 场景不涉及） |
| `tool-call-streaming-start` { toolCallId, toolName } | `activeTools.set(callId, { toolName, status: 'input' })`；reasoning 视为结束（`currentReasoning = ''`）；emit `activity-state { status: '正在 ' + toolName + '…', activities: ['准备调用 ' + toolName + '…', ...defaultLoadingMessages.slice(0, 4)] }`。**注意：`newToolCalls` 延迟到 `tool-call` 事件发出**（此时尚无 args，无法构建 display label） |
| `tool-call-delta` | 不 emit（内部 partial 累计不需要外化） |
| `tool-call` { toolCallId, toolName, args } | `activeTools.set(callId, { toolName, status: 'running' })`；通过 `toolDisplayLabel(toolName, args)` 生成 display label（bash 工具 → `bash(cmd_truncated)`，自动剥去 `cd <path> &&` 前缀；其他工具原名）；emit `activity-state { status: '正在 ' + toolName + '…', activities: ['正在 ' + toolName + '…', ...defaultLoadingMessages.slice(0, 4)], newToolCalls: [displayLabel] }` |
| `tool-result` { toolCallId, toolName, result } | `activeTools.delete(callId)`；若 `activeTools` 空 → emit `activity-state { status: '思考中…', activities: defaultLoadingMessages }`；否则按剩余 activeTools 的第一个构造 activities 文案 |
| `step-finish` { usage, providerMetadata, finishReason } | 累加 `modelUsage`（`costUSD = extractCostFromMetadata(providerMetadata)`）；若 `stepTextBuffer.trim()` 非空 → emit `assistant-message { text: stepTextBuffer.trim() }`；reset stepTextBuffer；`composing = false` |
| `error` { error } | emit `lifecycle { phase: 'failed', error: { message: redact(String(error)) } }`；从 fullStream 循环 break；**不再处理后续 part**；**不再 emit 其它事件** |
| `finish`（stream 顶层终止，整个 streamText 结束时仅发一次） | **不 emit** `activity-state { clear: true }`；构建 `SessionUsageInfo` → emit `usage-info`；读 `await result.response` 的 `messages`（AI SDK v4 的 `result.response` 是 Promise），emit `lifecycle { phase: 'completed', finalMessages }` |
| `AbortError`（包住整个 `for await` 的 try/catch 捕获） | emit `activity-state { clear: true }`；best-effort 读 `await result.response.catch(() => undefined)`.messages → emit `lifecycle { phase: 'stopped', reason: 'user', finalMessages? }`；不 emit `usage-info` |
| 其他未知异常（捕获但非 AbortError） | 与 `error` part 同路径：emit `lifecycle { phase: 'failed', error: { message: redact(...) } }` |

### 6.3 `emitActivity` helper（key diff）

```ts
function* emitActivity(state: ActivityState): Generator<AgentExecutionEvent> {
  const diffKey = JSON.stringify({ ...state, newToolCalls: undefined })
  if (diffKey === lastEmittedActivityKey && !state.newToolCalls?.length) return
  lastEmittedActivityKey = diffKey
  yield { type: 'activity-state', state }
}
```

### 6.4 Cost 提取

```ts
// src/agent/litellm-cost.ts
export function extractCostFromMetadata(metadata: unknown): number | undefined {
  // 实测 @ai-sdk/openai-compatible 走 LiteLLM 时 providerMetadata 形态
  // 常见路径候选（按优先级）：
  //   metadata.litellm.cost
  //   metadata.litellm.response_cost
  //   metadata.openaiCompat.cost
  // 读不到 → return undefined
  // 实装期以真实响应为准；路径确定后写入 README 或注释
}
```

兜底：读不到 → `costUSD = undefined` → 最终 `SessionUsageInfo.totalCostUSD = 0`，renderer 省略 `$X.XXXX` 段。

### 6.5 文案池

`src/im/slack/thinking-messages.ts`（跨 executor / sink 共享）：

```ts
export const STATUS = {
  thinking: '思考中…',
  composing: '回复中…',
  reasoning: '推理中…',
} as const

export const LOADING_POOL = [
  '正在组织思路…',
  '梳理脉络中…',
  '权衡各种角度…',
  '追溯问题根源…',
  '勾勒答案轮廓…',
  '编织片段中…',
  '让答案浮现…',
  '换个角度看看…',
  '仔细品味问题…',
  '寻找合适的措辞…',
  '把碎片连成整体…',
  '专注于关键所在…',
  '在可能性中漫游…',
  '层层构建理解…',
  '感知问题轮廓…',
  '小心地落子…',
  '让思绪沉淀片刻…',
  '从静默中汲取…',
] as const

export function getShuffledLoadingMessages(count = 8): string[] { /* Fisher–Yates */ }

export const TOOL_PHRASE = {
  input: (name: string) => `准备调用 ${name}…`,
  running: (name: string) => `正在 ${name}…`,
}
```

---

## 7. 持久化映射（Orchestrator 层）

### 7.1 ModelMessage 写入时机

| 时机 | 写入 |
|---|---|
| `handle()` 入口 | append user message |
| `assistant-message` 事件 | **不写**（避免与下方 finalMessages 重复；见下"abort 场景特例"） |
| `lifecycle { completed, finalMessages }` | 整批 append `finalMessages`（含 assistant text / tool-call / tool-result 的完整闭环） |
| `lifecycle { stopped, finalMessages? }` | 若 `finalMessages` 非空 → 整批 append（保存已完成 step 的消息，保障会话记忆）；随后 append `{ role: 'assistant', content: [{ type: 'text', text: '[stopped]' }] }` 作为中止标记 |
| `lifecycle { failed, error }` | append `{ role: 'assistant', content: [{ type: 'text', text: '[error: ' + redact(error.message) + ']' }] }`；**不尝试读 finalMessages**（error 路径可能伴随 response 不可用） |

**abort 场景特例说明**：Q3c 决策了"不发独立工具消息"、"流式 token 不对外"，配合本表：用户 turn 中途按 🛑 → 若已有完整 step（对应一条或多条 `assistant-message` 已发到 Slack）→ `stopped` 事件的 `finalMessages` 会携带这些 step 的 ModelMessage → jsonl 仍完整。下一轮历史重放时模型能看到已发出的回复，不会断记忆。

### 7.2 `meta.json` 更新

- `lifecycle { completed }` → `status = 'completed'`，`usage` 字段累加（turn-level 和 session-level 都累加）
- `lifecycle { stopped }` → `status = 'stopped'`
- `lifecycle { failed }` → `status = 'error'`
- `usage-info` → 累加 usage（即使 lifecycle 尚未到达 completed 也先记 usage；stopped 无 usage）
- `lastTurnAt` = 每轮完成时的 ISO 时间

### 7.3 Executor 终态 messages 的来源

```ts
// AiSdkExecutor 内部
const result = streamText({ ... })
for await (const part of result.fullStream) { /* yield 粗粒度事件 */ }
// 流结束后：
const finalMessages = (await result.response).messages
// 此时 emit：
yield { type: 'lifecycle', phase: 'completed', finalMessages }
```

---

## 8. Abort / Queue / 错误流

### 8.1 Abort

- Orchestrator 入口 `AbortRegistry.create(messageTs) → AbortController`
- `executor.execute({ abortSignal: controller.signal })`
- SlackAdapter 监听 `reaction_added`，🛑 → `registry.abort(messageTs, reason)`
- AI SDK 抛 AbortError → executor try/catch 外层捕获 → emit `activity-state { clear: true }` + `lifecycle { stopped, reason: 'user', finalMessages? }`（best-effort 读已完成 step）
- Sink 处理 `stopped` → finalize 走 stopped 分支
- Orchestrator finally：`registry.delete(messageTs)`；按 §7.1 处理 finalMessages + `[stopped]` 占位；`await sink.finalize()`

### 8.2 SessionRunQueue

- 同 `sessionId` 的多条消息严格 FIFO 串行
- 排队中：SlackAdapter 可选地给用户消息加 `⏳` reaction（出队开始前移除）
- 进程崩溃 → 队列丢失（一期接受）
- 不同 sessionId 完全并行

### 8.3 错误三层（清晰划分 executor / orchestrator / renderer 各自负责的错误）

| 层级 | 触发场景 | 捕获方 | 处理 |
|---|---|---|---|
| Fatal（启动期） | 缺凭证、config 解析失败、目录权限 | `createApplication` / CLI | 日志输出原因 + 修复建议 → `exit(1)`；`start` 主动引导 `onboard` |
| Agent Errors — fullStream 内部 error | 模型拒答、内容审查错误 | **AiSdkExecutor**：fullStream for-await 循环中见到 `error` part | emit `lifecycle { failed, error: { message: redact(String(part.error)) } }`，break loop，不读 finalMessages |
| Agent Errors — streamText async throw | 网络失败、鉴权过期、tool invocation 抛错、abortSignal AbortError | **AiSdkExecutor**：包住整个 for-await 的外层 try/catch | AbortError → `lifecycle { stopped, reason: 'user', finalMessages? }`；其他 → `lifecycle { failed, error: { message: redact(...) } }` |
| Agent Errors — Orchestrator 级别异常 | sink 本身抛错、持久化写盘失败、Orchestrator 代码 bug | **ConversationOrchestrator**：`handle()` 外层 try/catch | 调 helper `emitSyntheticFailed(sink, message)`（sink 合成一个 `lifecycle { failed }` 经标准路径进入 sink）；不再让 sink 暴露独立的 `fail()` 方法，保证 finalize 路径唯一 |
| Slack API 瞬态 | 429 / 网络抖动 / 权限变化 | **SlackRenderer** 内置 `safeRender` | 吞掉 + `logger.warn`；不冒泡。Assistant feature 已确认启用，不再有 feature flag / 进程级降级分支 |

**`emitSyntheticFailed` helper**（确保 orchestrator 发出的 failed 事件 shape 与 executor 自发的一致）：

```ts
// src/orchestrator/emitSyntheticFailed.ts
export async function emitSyntheticFailed(sink: SlackEventSink, message: string): Promise<void> {
  await sink.onEvent({
    type: 'lifecycle',
    phase: 'failed',
    error: { message: redact(message) },
  })
}
```

---

## 9. Slack Assistant 状态条（无降级）

本项目运行环境已确认满足 Slack Assistant feature 的全部前置条件：
- App Manifest 声明 `assistant` scopes（含 `assistant:write`）
- Workspace App 已启用 Assistant feature
- 所有入站 thread 均非 "new Assistant" 边界情况

因此 `renderer.setStatus(...)` / `renderer.clearStatus(...)` 直接调用 `client.assistant.threads.setStatus(...)`，不保留进程级 feature flag、不识别错误码、不关闭开关。瞬态失败（429 / 网络）由 `safeRender` 统一 `logger.warn` 吞掉，不影响 progress / reply 主路径。

> **若未来需要容忍未开启 Assistant 的新环境**：再引入进程级开关，参照 git 历史恢复本节曾设计的 `assistantFeatureAvailable` + `isAssistantFeatureError` 模式。一期不做。

---

## 10. 迁移路径（从当前 M1 代码到新设计）

### 10.1 需要重写的文件

| 文件 | 操作 | 说明 |
|---|---|---|
| `src/core/events.ts` | **重写** | `AgentExecutionEvent` 改为粗粒度 4 类；删 `StepUsage` / 原 TotalUsage，新增 `ActivityState` / `SessionUsageInfo` / `LifecyclePhase` / `StopReason` |
| `src/agent/AiSdkExecutor.ts` | **重写内部事件映射** | 从细粒度 yield 改为粗粒度；加 AggregatorState + `emitActivity` helper + cost extractor 接入 |
| `src/im/slack/SlackEventSink.ts` | **重写** | 现仅 24 行的简化版删除，按 §5 实装 |
| `src/im/slack/SlackRenderer.ts` | **新建** | 按 §4 实装 |
| `src/im/slack/thinking-messages.ts` | **新建** | 中文文案池 + helper |
| `src/im/slack/SlackAdapter.ts` | **小改** | 构建 sink 时注入 renderer；原来调 `client.reactions.add({name:'eyes'})` 由 `renderer.addAck` 接管；其余逻辑保留 |
| `src/orchestrator/ConversationOrchestrator.ts` | **改** | 消费新事件类型；按 §7.1 写 jsonl；`await sink.finalize()` 在 finally；兜底异常调用 §8.3 的 `emitSyntheticFailed(sink, message)`（向 sink 注入一条合成 `lifecycle { failed }` 后再 `finalize`），sink 不暴露独立的 `fail()` 方法 |
| `src/application/createApplication.ts` | **小改** | 装配 `createSlackRenderer`（Assistant feature 已确认启用，不装 feature flag） |

### 10.2 可复用

- `src/logger/*`、`src/store/*`、`src/workspace/*` 不动
- `src/core/usage.ts` → 并入 `src/core/events.ts` 作为 `SessionUsageInfo` 后删
- M1 已有的"👀 reaction 加到 sourceMessageTs"逻辑 → 保留，但改走 `renderer.addAck`

### 10.3 不做的

- 不引入 `splitBlocksWithText` 的手卷替代方案——直接用 `markdown-to-slack-blocks` 原生 `splitBlocksWithText` export
- 不做 status probe / analytics store（kagura 有，一期 YAGNI）
- 不做 user-input bridge（interactive modal 交互一期不做）
- 不做 generated-files / generated-images（非 codex 场景，一期不用）

---

## 11. 测试策略

### 11.1 Unit tests

- `SlackRenderer.test.ts`：mock WebClient，断言每个方法对应的 `chat.*` / `reactions.*` / `assistant.threads.*` 调用 shape；safeRender 失败断言 warn + 不抛
- `SlackEventSink.test.ts`：
  - mock renderer，按事件序列驱动，断言 renderer 方法调用顺序和参数
  - 关键 case：
    1. `lifecycle {started}` → `activity-state` (default thinking) → 直接 `lifecycle {completed, finalMessages}`：progress 从未激活，无 upsertProgressMessage 调用
    2. `activity-state (with tool)` → 激活 progress；多个 tool → toolHistory 累加
    3. `activity-state` key 相同 → 跳过 upsert
    4. `assistant-message` 来时删 progress + post reply
    5. `lifecycle {stopped}` → finalize 走 stopped 分支 + addStopped reaction
    6. `lifecycle {failed}` → finalize 走 error 分支 + addError reaction
    7. `assistant.threads.setStatus` 单次失败（mock 注入） → `safeRender` warn 吞掉，不影响后续 progress/reply 路径（无开关关闭）
- `AiSdkExecutor.test.ts`：用 AI SDK 的 `MockLanguageModel` 喂入 stream parts 序列，断言 yield 出的粗粒度事件序列 + finalMessages 完整

### 11.2 Integration tests

- `tests/integration/slack-render-flow.test.ts`：mock WebClient + mock LLM，从 SlackAdapter 入口触发，断言最终 Slack 侧收到的完整 API 调用序列

### 11.3 E2E（二期）

- 真 slack + 真 litellm 跑完整对话（Assistant feature 已确认启用；不覆盖未开场景）

---

## 12. 待决事项（实装期确认）

1. ~~**AI SDK fullStream part 名称**~~ ✅ 已核实：当前 `ai@4.3.19`，part 名按 §6.2 表内列出（v4 风格），实装直接按此表对齐
2. **LiteLLM cost 读取路径**：实测 `providerMetadata.litellm` 真实 shape，`extractCostFromMetadata` 确定后写进注释 + 简单 unit test；一期实装前先用 `streamText` 打印一次 `providerMetadata` 落实路径
3. ~~**Slack `assistant.threads.setStatus` 错误码列表**~~ ❌ 本期不做：Assistant feature 已确认启用，不需要识别 feature 相关错误码，瞬态错误由 `safeRender` 统一 warn 吞掉
4. **workspace_label 一期要不要启用**：设计里保留接口，默认 undefined；若一期要"每条 reply 显示 workspace 目录名"可开启
5. ~~**`markdown-to-slack-blocks` 的 `splitBlocksWithText` 是否默认 export**~~ ✅ 已核实：`markdown-to-slack-blocks@1.5.0` 从 `./splitter` re-export `splitBlocksWithText`，可直接 `import { markdownToBlocks, splitBlocksWithText } from 'markdown-to-slack-blocks'`
6. **`AgentExecutor.drain()` 接口是否保留**：原 spec 定义但 M1 未用，本次设计删除

---

## 13. 与原 architecture spec 的对齐

本文件**替换**原 spec（`2026-04-17-agent-slack-architecture-design.md`）以下内容：

- §2.2 `AgentExecutionEvent` 细粒度定义 → 以本文 §2 为准
- §2.2 `EventSink` 接口 → 以本文 §5 的 `SlackEventSink` 为准
- §2.3 "`EventSink` 的节流/批处理在 IM 侧"描述 → 改为"key diff 幂等去重"，删时间窗 debounce 描述
- §4 数据流 `SlackEventSink → SlackRenderer` 段 → 以本文 §3 + §5 + §6 为准
- §4.1 Cost 路径 → 仍有效，但 `onFinish` 改为 `providerMetadata` 在 `finish-step` 里读取
- §7.1 M2 里程碑描述保留，但具体 plan 改为本 spec 对应的新 M2 plan（待另行编写）

**本文件新增**的内容（原 spec 未覆盖）：

- Reasoning 活动摘要
- ActivityState 快照 + key diff 去重
- finalMessages 随 lifecycle 完成态携带给 orchestrator

---

## 14. 名词表（补充）

- **Progress message**：thread 内一条独立 `chat.postMessage` 消息，显示 tool history 聚合和最近活动；turn 内 upsert，终态 finalize 成"✅ 完成"或"⚠️ 出错"
- **Reply message**：每个 `assistant-message` 事件对应的独立 thread reply，`markdown-to-slack-blocks` 自动分块
- **Status bar**：Slack Assistant feature 提供的 thread 输入框上方状态条；需要 `assistant:write` scope
- **Activity state**：executor 对外暴露的进程态快照事件；IM 侧 key diff 幂等去重
- **Tool history**：`Map<toolName, count>` 累计 turn 内工具调用次数，显示在 progress 和最终"✅ 完成"文案
- **Reasoning tail**：model reasoning 输出流末尾 80 字符摘要，显示在 progress 消息和状态条 loading_messages 尾部
