# Orchestrator Streaming 架构研究 notes

**日期**：2026-04-28
**目的**：为 Multi-Agent P0 plan Chunks 4-5 重写打底。把 `AiSdkExecutor` + `ConversationOrchestrator` + `SessionRunQueue` + `AbortRegistry` 现状吃透，回答 plan 中所有"该怎么挂钩"的问题。

## 1. AgentExecutor 接口（async generator）

[`src/agent/AgentExecutor.ts`](../../../src/agent/AgentExecutor.ts)：

```ts
export interface AgentExecutor {
  execute(req: AgentExecutionRequest): AsyncGenerator<AgentExecutionEvent>
}
```

`execute` 是 **async generator**，按需 yield 事件。消费方用 `for await (const event of executor.execute(req)) { ... }` 拿事件。

不存在同步 `run() → {finalText, steps, usage}` 接口。**plan 之前写错了**。

## 2. AgentExecutionEvent 序列

[`src/core/events.ts`](../../../src/core/events.ts)：

```ts
type AgentExecutionEvent =
  | { type: 'activity-state'; state: ActivityState }
  | { type: 'assistant-message'; text: string }       // 每个 non-empty step 发一次
  | { type: 'usage-info'; usage: SessionUsageInfo }
  | LifecycleEvent

type LifecycleEvent =
  | { type: 'lifecycle'; phase: 'started' }
  | { type: 'lifecycle'; phase: 'completed'; finalMessages: LifecycleFinalMessage[] }
  | { type: 'lifecycle'; phase: 'stopped'; reason: StopReason; finalMessages?: ...; summary?: string }
  | { type: 'lifecycle'; phase: 'failed'; error: { message: string } }

type LifecycleFinalMessage = (CoreAssistantMessage | CoreToolMessage) & { id: string }
```

### 典型 happy path 序列

```
lifecycle.started
activity-state(thinking)
[text-delta 累积到 stepTextBuffer，不直接 yield]
[tool-call-streaming-start → activity-state(input)]
[tool-call → activity-state(running) + newToolCalls]
[tool-result → activity-state(thinking 或下一 tool)]
step-finish
  ↳ 如 stepTextBuffer.trim() 非空：yield assistant-message(stepText)
[多 step 循环……]
finish (finishReason='stop' 或 'tool-calls')
usage-info
lifecycle.completed { finalMessages: [...] }
```

### maxSteps 触达序列

```
... step-finish (stepCount === maxSteps)
finish (finishReason='tool-calls', stepCount >= maxSteps)
  ↳ yield assistant-message(buildMaxStepsSummary)
  ↳ yield usage-info
  ↳ yield lifecycle.stopped { reason: 'max_steps', summary }
[执行流提前 break]
```

### abort 序列

```
... 任意中间事件
catch (AbortError):
  yield activity-state(clear)
  yield lifecycle.stopped { reason: 'user', finalMessages?: ... }
```

### 关键事实

- **`assistant-message` 事件按 step 发**，每个 step 的最终累积文本作为一次。一个 turn 通常发 1 条（最后的纯文本回复）；如果模型边调 tool 边输出文本，可能多条。
- **`finalMessages` 只在 `lifecycle.completed` 或 `lifecycle.stopped`（已 settle 时）携带**。它是 `await result.response` 得到的 `messages` 数组，包含本 turn 所有 assistant + tool 消息（含 toolCall / toolResult）。
- **`finalText`（纯字符串）不存在**。要拿"模型本 turn 最终输出文本"，得从 `finalMessages` 里筛 `role === 'assistant'`、最后一条、`content` 中 `type === 'text'` 的部分。
- **abort 是控制流**：通过 `req.abortSignal` 传入，executor 内 catch AbortError 后 yield stopped。

## 3. ConversationOrchestrator.handle 的事件消费

[`src/orchestrator/ConversationOrchestrator.ts:299-356`](../../../src/orchestrator/ConversationOrchestrator.ts) 关键代码：

```ts
for await (const event of executor.execute({
  systemPrompt: systemPromptWithMemory,
  messages: modelMessages,
  abortSignal: ctrl.signal,
})) {
  await sink.onEvent(event)                      // 立刻 forward 给 sink

  if (event.type === 'usage-info') {
    // 累计 token / cost 到 sessionStore
  }

  if (event.type === 'lifecycle') {
    if (event.phase === 'completed') {
      for (const m of event.finalMessages ?? []) {
        await deps.sessionStore.appendMessage(session.id, m)  // 落盘消息
      }
      await deps.sessionStore.setStatus(session.id, 'idle')
    } else if (event.phase === 'stopped') { ... }
    else if (event.phase === 'failed') { ... }
  }
}
```

handle 完成后：
- `finalize()` 由 SlackAdapter 在外层调（参见 [`createApplication.ts`](../../../src/application/createApplication.ts) 装配 SlackEventSink）；orchestrator 的 finalize 是通过 sink 的 lifecycle.completed/stopped/failed 触达 SlackEventSink 内部状态机自动收尾。

### 拦截点（关键）

要在 turn 末尾"做点什么"，最自然的位置：

```ts
if (event.type === 'lifecycle' && event.phase === 'completed') {
  // 此处可以拿到完整 finalMessages，做 marker 检测、写 envelope 等
  const lastAssistantMsg = [...event.finalMessages].reverse().find(m => m.role === 'assistant')
  const finalText = extractText(lastAssistantMsg)
  // ... <waiting/> / <final/> 检测
  for (const m of event.finalMessages ?? []) {
    await deps.sessionStore.appendMessage(session.id, m)
  }
  await deps.sessionStore.setStatus(session.id, 'idle')
}

await sink.onEvent(event)  // ← 注意：原代码先 forward 再处理 lifecycle；
                            //    multi-agent 改造后顺序仍可保留
```

### `extractText` 注意事项

`CoreAssistantMessage.content` 在 ai-sdk 里有两种形态：
- `string`（旧风格）
- `Array<{ type: 'text'; text: string } | { type: 'tool-call'; ... }>`（新风格 multi-modal）

提取最后一段纯文本：

```ts
function extractAssistantText(msg: CoreAssistantMessage): string {
  if (typeof msg.content === 'string') return msg.content
  return msg.content
    .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
    .map((p) => p.text)
    .join('')
}
```

## 4. SessionRunQueue 现状（无 pause）

[`src/orchestrator/SessionRunQueue.ts`](../../../src/orchestrator/SessionRunQueue.ts) 是 **tail Promise 链**：

```ts
const runPromise = state.tail.then(() => runner())
state.tail = runPromise.then(() => {}, () => {})  // 吞错确保链路
```

每个 sessionId 一条 tail。enqueue 把 runner 接到 tail 后面，tail 一个接一个跑。

**没有 pause 概念**。要加 pause/resume：在 tail 链路里插入一个"gate Promise"——pause 时把 tail 改为 `tail.then(() => gatePromise)`；resume 时 resolve gatePromise。

具体实现思路：

```ts
class SessionRunQueue {
  private gates = new Map<string, { promise: Promise<void>; resolve: () => void }>()

  pause(sessionId: string): void {
    if (this.gates.has(sessionId)) return  // 已 paused
    let resolve!: () => void
    const promise = new Promise<void>((r) => { resolve = r })
    this.gates.set(sessionId, { promise, resolve })
    const state = this.states.get(sessionId)
    if (state) {
      state.tail = state.tail.then(() => promise)  // 阻断后续 runner
    }
  }

  resume(sessionId: string): void {
    const gate = this.gates.get(sessionId)
    if (gate) {
      this.gates.delete(sessionId)
      gate.resolve()
    }
  }

  isPaused(sessionId: string): boolean {
    return this.gates.has(sessionId)
  }

  hasPending(sessionId?: string): boolean {
    if (sessionId) return (this.states.get(sessionId)?.depth ?? 0) > 0
    return [...this.states.values()].some((s) => s.depth > 0)
  }
}
```

注意：**pause 后已经在执行的 runner 不会被打断**。pause 只阻塞"还没开始的"runner。如果当前 runner 正在跑（比如 PM 当前 turn 还没 yield 完所有事件），pause 不会中止它。这正符合 spec §5.2 语义："paused 期间不消费新 InboundMessage"。

## 5. AbortRegistry 现状（按 key 单 controller）

[`src/orchestrator/AbortRegistry.ts`](../../../src/orchestrator/AbortRegistry.ts)：每个 messageTs 一个 AbortController。`create(key)` 重复抛错；`abort(key)` 静默 no-op；`abortAll()` 清空。

要加 task-level abort：扩 `taskGroups: Map<taskId, Set<key>>`，新增 `associateTask(taskId, key)` / `abortTask(taskId, reason)`。`delete(key)` 同步清理 taskGroups 里对应项。

## 6. EventSink 现状

[`src/im/types.ts:63-67`](../../../src/im/types.ts)：

```ts
interface EventSink {
  onEvent(event: AgentExecutionEvent): Promise<void>
  finalize(): Promise<void>
  readonly terminalPhase: 'completed' | 'stopped' | 'failed' | undefined
}
```

`onEvent` 转发事件；`finalize` 在 handle 末尾或 orchestrator finalizeSink() 调；`terminalPhase` 由 sink 内部 lifecycle 事件追踪。

P0 不接 Slack，A2A 路径用 noopSink：

```ts
const noopSink: EventSink = {
  async onEvent() {},
  async finalize() {},
  terminalPhase: undefined,
}
```

注意 `terminalPhase` 是 readonly 字段；mock 时直接给 undefined 即可（事件不影响 sink 状态机）。

## 7. tools 全局共享 + ToolContext.multiAgent 注入路径

[`src/agent/tools/index.ts:25-44`](../../../src/agent/tools/index.ts) 的 `buildBuiltinTools(ctx, deps)` 在 orchestrator handle 入口被调用：

```ts
// ConversationOrchestrator.ts:291-294
const imContext: IMContext = {
  ...(input.confirmSender ? { confirm: input.confirmSender } : {}),
}
const tools = deps.toolsBuilder(currentUser, imContext)
```

`toolsBuilder` 是 application 层注入的闭包：

```ts
// createApplication.ts:98-118
const toolsBuilder = (currentUser, imContext) =>
  buildBuiltinTools(
    { cwd, logger, currentUser, ...(imContext.confirm ? { confirm: imContext.confirm } : {}) },
    { memoryStore, ... }
  )
```

multi-agent 注入路径设计：
1. `IMContext` 类型加可选 `multiAgent?` 字段（[`src/orchestrator/...`](../../../src/orchestrator) 看具体定义；如果没有 IMContext 类型，就在 orchestrator 内部 inline）
2. orchestrator handle 入口拿到 taskId 后构造 `imContext.multiAgent = { agentId, taskId, bus, taskBoard }`
3. application 层 toolsBuilder 闭包把 `imContext.multiAgent` 透传给 `buildBuiltinTools` 的 ctx

## 8. 关键设计修订（替换 plan 旧设计）

### 8.1 用 tool 替代 `<waiting/>` 文本标记

旧设计：模型输出含 `<waiting/>` 文本 → orchestrator 检测 → pause。
**问题**：text-delta 流式期间已 emit assistant-message 给 sink；text 被 Slack 看到（P1 集成时）；提取最终文本要从 finalMessages 反算。

新设计：**新增 `mark_waiting(reason?)` tool**。任何 agent 用，PM/Coding/CS 都可。tool 调用时：
- 写一个 sentinel 字段到本 turn 的处理状态里（orchestrator 通过观察 finalMessages 中 toolCall 检测）
- 实际"暂停"行为由 orchestrator 在 turn 末尾根据 sentinel 决定

具体：finalMessages 中扫 toolCall 即可知道是否调过 mark_waiting：

```ts
function detectWaiting(finalMessages: LifecycleFinalMessage[]): boolean {
  for (const m of finalMessages) {
    if (m.role !== 'assistant') continue
    const content = Array.isArray(m.content) ? m.content : []
    if (content.some((p) => p.type === 'tool-call' && p.toolName === 'mark_waiting')) {
      return true
    }
  }
  return false
}
```

`mark_waiting` 实现纯 no-op（仅留痕）：

```ts
export function markWaitingTool() {
  return tool({
    description: '声明本 turn 在等待其他 Agent 回复或外部输入，不要 finalize 此 turn。' +
                 '调用后请直接结束输出。',
    parameters: z.object({ reason: z.string().optional() }),
    execute: async () => ({ ok: true as const }),
  })
}
```

### 8.2 用 tool 替代 `<final/>` 文本标记 + 复用 `say_to_thread`

旧设计：PM 输出含 `<final/>` 文本 → 写 `to='thread' intent='final'` envelope。
新设计：扩 `say_to_thread(content, isFinal?: boolean)` 工具。`isFinal=true` 写 `intent='final'` + task.state→done；否则 `intent='broadcast'`。

Coding/CS 不该直接发 thread；它们用 auto-reply 机制（见 8.3）。

### 8.3 自动 reply envelope 承运（仅非 PM）

非 PM agent 在 turn 末尾如果不是 paused（没调 mark_waiting）：runtime 自动写 reply envelope 给 `replyTo`（来自合成 InboundMessage 的 envelope.from）。content = 提取 finalMessages 最后一条 assistant text。

```ts
if (!isWaiting && agentId !== 'pm' && input.replyTo && input.replyTo !== 'thread') {
  const finalText = extractLastAssistantText(event.finalMessages)
  if (finalText) {
    await deps.multiAgent.bus.post({
      id: newEnvelopeId(),
      taskId,
      from: agentId,
      to: input.replyTo,
      intent: 'reply',
      content: finalText,
      ...(input.parentEnvelopeId ? { parentId: input.parentEnvelopeId } : {}),
      createdAt: new Date().toISOString(),
    })
  }
}
```

PM 不走自动承运：PM 显式调 `say_to_thread` / `delegate_to`，运行时不替它写 envelope。

### 8.4 Marker 检测时机

在 `for await` 循环内拦 `lifecycle.completed`：

```ts
for await (const event of executor.execute(...)) {
  let suppressLifecycleEmit = false

  if (event.type === 'lifecycle' && event.phase === 'completed' && deps.multiAgent && taskId) {
    const isWaiting = detectWaiting(event.finalMessages)
    if (isWaiting) {
      // pause runQueue（由 turn 末尾的 SessionRunQueue 控制；当前 turn 已经在跑，
      // pause 影响下一个 enqueue 的 runner —— 即 reply envelope 来时不会立即消费）
      deps.runQueue.pause(sessionKey)
    } else if (agentId !== 'pm') {
      // 自动 reply envelope（见 8.3）
      const finalText = extractLastAssistantText(event.finalMessages)
      if (finalText && input.replyTo && input.replyTo !== 'thread') {
        await postReplyEnvelope(...)
      }
    }
    // PM 不需要 auto-envelope（依赖 say_to_thread / delegate_to 显式调用）

    // 落盘 messages 与原代码一致
    for (const m of event.finalMessages ?? []) {
      await deps.sessionStore.appendMessage(session.id, m)
    }
    await deps.sessionStore.setStatus(session.id, 'idle')
  } else if (event.type === 'lifecycle') {
    // 走原 stopped/failed 分支（不动）
  }

  // 其他事件原样 forward
  if (!suppressLifecycleEmit) await sink.onEvent(event)
}
```

### 8.5 subscribeA2A 唤醒 paused

reply envelope 到达 subscribeA2A handler 时：

```ts
return ma.bus.subscribe(agentId, async (envelope) => {
  const board = await ma.taskBoard.read(envelope.taskId)
  if (!board) return
  const synthetic: InboundMessage = { ... }
  // resume runQueue（如果之前 paused）
  const sessionKey = `${synthetic.imProvider}:${synthetic.channelId}:${synthetic.threadTs}:${agentId}`
  if (deps.runQueue.isPaused(sessionKey)) {
    deps.runQueue.resume(sessionKey)
  }
  await orchestrator.handle(synthetic, noopSink)
})
```

### 8.6 mock executor for tests

按真实接口写 mock，按"事件序列脚本"驱动：

```ts
type MockEventScript = AgentExecutionEvent[]

export function mockExecutorFromEvents(events: MockEventScript): AgentExecutor {
  return {
    async *execute() {
      for (const e of events) yield e
    },
  }
}

// 也提供一个 high-level helper：从"模型本 turn 想做什么"自动生成 events
type MockTurnIntent =
  | { kind: 'text'; text: string }                                          // 纯文本回复
  | { kind: 'tool'; toolName: string; args: Record<string, unknown> }      // 调一个 tool
  | { kind: 'mark_waiting' }                                                 // 调 mark_waiting tool
  | { kind: 'say_to_thread'; content: string; isFinal?: boolean }           // PM 用

export function mockExecutorFromTurns(
  turns: MockTurnIntent[],
  tools: ToolSet,
): AgentExecutor {
  return {
    async *execute() {
      yield { type: 'lifecycle', phase: 'started' }
      const finalMessages: LifecycleFinalMessage[] = []
      for (const turn of turns) {
        if (turn.kind === 'text') {
          yield { type: 'assistant-message', text: turn.text }
          finalMessages.push({
            id: 'mock-' + finalMessages.length,
            role: 'assistant',
            content: [{ type: 'text', text: turn.text }],
          })
        } else if (turn.kind === 'tool') {
          // 真调 tool.execute；把结果包成 toolCall + toolResult 加进 finalMessages
          const toolDef = (tools as any)[turn.toolName]
          if (!toolDef?.execute) throw new Error('未知 tool ' + turn.toolName)
          const toolCallId = 'mock-tc-' + finalMessages.length
          const result = await toolDef.execute(turn.args, { toolCallId, messages: [] })
          finalMessages.push({
            id: 'mock-' + finalMessages.length,
            role: 'assistant',
            content: [{ type: 'tool-call', toolCallId, toolName: turn.toolName, args: turn.args }],
          })
          finalMessages.push({
            id: 'mock-' + (finalMessages.length + 1),
            role: 'tool',
            content: [{ type: 'tool-result', toolCallId, toolName: turn.toolName, result }],
          })
        } else if (turn.kind === 'mark_waiting') {
          // 同 'tool' 走 mark_waiting
        } else if (turn.kind === 'say_to_thread') {
          // 同 'tool' 走 say_to_thread + isFinal 字段
        }
      }
      yield { type: 'usage-info', usage: { durationMs: 0, totalCostUSD: 0, modelUsage: [] } }
      yield { type: 'lifecycle', phase: 'completed', finalMessages }
    },
  }
}
```

## 9. 用户消息与 reply envelope 优先级（spec 真空）

paused 期间用户在同 thread 又发 mention，会和后到的 reply envelope 一起在 SessionRunQueue 排队。

**P0 决议**：FIFO，先到先消费。如果 reply envelope 先到 → resume → 消费 reply。如果用户消息先到 → enqueue 但被 paused 阻塞 → reply 后到时 enqueue → resume → 按顺序消费用户消息（先）+ reply（后）。

**结果**：用户消息打断 PM 的"等 CS 回复"逻辑，PM 收到的是"用户新输入"（不是 CS 回复），模型可能把它当成"用户改主意了"。

**P0 接受这个语义**，记录在 plan 里。P1 可以加优先级（reply envelope 优先于用户消息），但需要扩 SessionRunQueue 加 priority 概念。

## 10. 单 Agent 回归 = 不要走 multi 分支

所有 multi-agent 行为都包在 `if (deps.multiAgent && taskId)` 守卫内。`deps.multiAgent` 缺失时（单 agent 模式）：
- detectWaiting / 自动 reply envelope / pause 全部跳过
- handle 与今天行为完全一致

测试断言基础不变：单 Agent 路径 `event.type === 'lifecycle' && event.phase === 'completed'` 仍走原 forEach appendMessage + setStatus 'idle'。

## 11. 给 Plan Chunks 4-5 重写的具体输入

写新 plan 时直接引用本 notes：
- §3 / §4 → orchestrator 改造点
- §4 (extractText 工具函数) → 新增 helper
- §5 → SessionRunQueue.pause/resume 实现
- §6 → noopSink 形态
- §7 → IMContext.multiAgent 字段 + toolsBuilder 透传
- §8.1-8.6 → 关键设计修订（mark_waiting tool 替代 `<waiting/>`、say_to_thread 加 isFinal、auto-reply、subscribeA2A resume）
- §9 → P0 接受用户消息与 reply 同 FIFO，不做 priority
- §10 → 单 agent 守卫位置

## 12. 影响范围（plan 必须改的事）

1. ❌ `<waiting/>` / `<final/>` 文本标记 → ✅ `mark_waiting` tool + `say_to_thread(isFinal)` 扩展
2. ❌ "modelFinalText" 同步变量 → ✅ `extractLastAssistantText(event.finalMessages)`
3. ❌ "执行器 run() 同步返回" → ✅ AsyncGenerator 事件序列消费
4. ❌ "假设有 modelFinalText" → ✅ 在 `lifecycle.completed` 拦截点处理
5. ❌ "auto-envelope 通用规则" → ✅ 仅非 PM 自动 reply；PM 全靠显式 tool（say_to_thread / delegate_to）
6. ✅ SessionRunQueue.pause/resume：保留，需新写实现（gate Promise 模式）
7. ✅ AbortRegistry task-level group：保留，新增 `associateTask` / `abortTask`
8. ✅ subscribeA2A 直接用 envelope.taskId：保留（plan 已修）
9. ✅ envelope.references 透传到 InboundMessage.a2aReferences：保留（plan 已修）
10. ✅ subscribeA2A 可选方法：保留（plan 已修）

下一步：基于本 notes，**重写 Plan Chunks 4-5**，把上面 1-5 全部修正，6-10 保留。