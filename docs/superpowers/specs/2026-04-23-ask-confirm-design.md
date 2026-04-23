# ask_confirm 通用按钮确认 tool 设计

- 创建日期：2026-04-23
- 依赖前置：`docs/superpowers/specs/2026-04-22-self-improve-design.md`（SlackConfirm / ConfirmSender 已就绪）

## 1. 目标

为所有业务 skill 提供**阻塞式按钮确认**能力：主 Agent 在需要用户 confirm 时调一次 `ask_confirm` tool，tool 内部发送 Slack Block Kit 按钮卡片并阻塞，直到用户点完所有按钮（或超时）才返回 `{ decisions }`，主 Agent 拿到结果后继续后续业务逻辑。

**替代场景**：当前 LLM 需要用户确认时只能发一段大白话，用户用文字回复。本 tool 用按钮替代，美观且无歧义，仍保留阻塞语义让业务逻辑留在 LLM 侧。

**非目标**：
- 不做 tool 执行前的危险操作拦截（那是另一个方向，属于 permission gating）
- 不替代 `self_improve_confirm`（后者副作用在 onDecision 写文件，不需要 LLM 等结果）

## 2. 触发方式

- 主 Agent 在 assistant 回合调用 `ask_confirm({ title, items, timeoutMs? })`
- 仅在 Slack 环境有效（`ctx.confirm` 存在）；其他 IM 或 CLI 场景返回 `{ reason: 'no_confirm_channel' }`

## 3. 架构概览

```
Main Agent (assistant 回合)
  │
  │ tool call: ask_confirm({ title, items, timeoutMs? })
  ▼
ask_confirm tool
  │
  ├─ 1. 并发检查：confirmBridge.hasPending(threadTs) → throw '已有 pending'
  │
  ├─ 2. ctx.confirm.send({
  │        namespace: `ask:${toolCallId}`,
  │        items, title,
  │        onDecision: (item, decision) =>
  │          confirmBridge.resolveOne({ toolCallId, itemId: item.id, decision })
  │     })
  │
  └─ 3. await confirmBridge.awaitAllDecisions({
           threadTs, toolCallId, itemIds,
           timeoutMs, signal
         })
       │
       │ 用户点击 → SlackAdapter.app.action(/^confirm:/) → 
       │  slackConfirm.getCallback → onDecision → bridge.resolveOne
       │ 所有 item 收齐或 timeoutMs 到 → resolve / reject
       │
       └─ 结束后：
          - 对每个 decision：chat.postMessage thread 回帖 "✅ 已采纳 xxx" / "❌ 已忽略 xxx"
          - return { decisions: [{ id, decision }, ...], timedOut?: true }
  │
  ▼
Main Agent 拿到 decisions 继续执行业务（如调"开白名单" API）
```

## 4. 核心模块设计

### 4.1 `src/im/slack/ConfirmBridge.ts`（新增）

参照 kagura `SlackUserInputBridge`，但按 toolCallId 而非单纯 threadTs 管理，同时强制 thread-level 单 pending。

```typescript
export interface ConfirmBridgeDeps {
  logger: AppLogger
}

export interface ConfirmPending {
  toolCallId: string
  threadTs: string
  itemIds: Set<string>              // 待收集
  decisions: Map<string, ConfirmDecision>  // 已收到
  resolve: (decisions: Map<string, ConfirmDecision>) => void
  reject: (err: Error) => void
  cleanup: () => void
}

export class ConfirmBridge {
  private pendingByThread = new Map<string, ConfirmPending>()

  hasPending(threadTs: string): boolean

  awaitAllDecisions(params: {
    toolCallId: string
    threadTs: string
    itemIds: string[]
    timeoutMs: number
    signal?: AbortSignal
  }): Promise<Map<string, ConfirmDecision>>

  /** 由 onDecision 回调驱动，每收到一个 item 的决定就调一次 */
  resolveOne(params: {
    toolCallId: string
    itemId: string
    decision: ConfirmDecision
  }): void

  /** 人为取消（例如新调用 tool 冲突）*/
  cancel(threadTs: string, reason?: string): void
}
```

**关键行为**：
- `awaitAllDecisions` 注册 pending + 启动 setTimeout + 监听 AbortSignal
- 所有 itemIds 收齐 → resolve(decisions)
- 任一超时/abort → reject(TimeoutError)，当前已收集的决定丢弃
- resolveOne 命中非当前 toolCallId 直接忽略（防止错位）

### 4.2 tool 定义：`src/agent/tools/askConfirm.ts`

```typescript
export interface AskConfirmDeps {
  confirmBridge: ConfirmBridge
  webClient: WebClient        // 用于 thread 回帖反馈
  logger: AppLogger
}

export function askConfirmTool(ctx: ToolContext, deps: AskConfirmDeps) {
  return tool({
    description:
      '向用户发送 Slack 按钮请求确认并阻塞等待用户点击。返回每个 item 的 accept/reject 决定。' +
      '当你需要用户对某些具体条目逐一确认（例如"这些人要开白名单，确认吗？"）时调用。' +
      'tool 会等用户全部点完或 10 分钟超时才返回。',
    parameters: z.object({
      title: z.string().describe('确认卡片顶部总标题（例如"以下 3 位用户即将开白名单，请逐一确认"）'),
      items: z.array(z.object({
        id: z.string().describe('条目唯一 id，用于回传决定'),
        title: z.string().describe('条目主标题，显示在卡片上'),
        description: z.string().optional().describe('条目说明，显示为灰色辅助文本'),
      })).min(1).max(20),
      timeoutMs: z.number().int().positive().optional()
        .describe('超时毫秒数，默认 600000 (10 分钟)。超时后未点击的按钮视为 timeout'),
    }),
    async execute({ title, items, timeoutMs = 600_000 }, toolCallCtx) {
      if (!ctx.confirm || !ctx.imContext?.threadTs) {
        return { reason: 'no_confirm_channel', decisions: [] }
      }
      const threadTs = ctx.imContext.threadTs
      const toolCallId = toolCallCtx.toolCallId

      // 1. 并发检查
      if (deps.confirmBridge.hasPending(threadTs)) {
        return { reason: 'concurrent_pending', decisions: [] }
      }

      // 2. 发送按钮卡片
      await ctx.confirm.send({
        namespace: `ask:${toolCallId}`,
        title,
        items,
        onDecision: ({ id, decision }) =>
          deps.confirmBridge.resolveOne({ toolCallId, itemId: id, decision }),
      })

      // 3. 等待
      let decisions: Map<string, ConfirmDecision>
      let timedOut = false
      try {
        decisions = await deps.confirmBridge.awaitAllDecisions({
          toolCallId, threadTs,
          itemIds: items.map(i => i.id),
          timeoutMs,
          signal: toolCallCtx.abortSignal,
        })
      } catch (err) {
        if (err instanceof ConfirmTimeoutError) {
          timedOut = true
          decisions = err.partialDecisions   // 已收集的
        } else throw err
      }

      // 4. thread 回帖反馈
      await postDecisionFeedback(deps.webClient, ctx.imContext, items, decisions, timedOut)

      return {
        decisions: items.map(i => ({
          id: i.id,
          decision: decisions.get(i.id) ?? 'timeout',
        })),
        ...(timedOut ? { timedOut: true } : {}),
      }
    },
  })
}
```

### 4.3 SlackConfirm 复用（无改动）

现有 `SlackConfirm.send` + `app.action(/^confirm:/)` 路由直接复用。
- `namespace: ask:<toolCallId>` 隔离，不和 self_improve 冲突
- `onDecision` 回调由 tool 注入（→ `bridge.resolveOne`）
- 按钮点击后 `chat.update` 替换 blocks 为"已采纳/已忽略"结果态（既有行为）

### 4.4 SlackAdapter 小改（支持超时 fallback）

`app.action(/^confirm:/)` handler 在调用 `slackConfirm.getCallback(namespace)` 返回的 onDecision 之前，多一步：
- 若 namespace 以 `ask:` 开头 **且** `confirmBridge.hasPending(threadTs)` 为 false：
  - `await respond({ response_type: 'ephemeral', replace_original: false, text: '⏱ 此确认已超时，请重新请求' })`
  - `return`，不再调 onDecision
- 其他 namespace（如 `self_improve:*`）走原路径不变

需要在 SlackAdapter 装配时注入 `confirmBridge` 依赖（只读 `hasPending`）。

### 4.5 thread 回帖反馈

`postDecisionFeedback` 工具函数：

```typescript
async function postDecisionFeedback(
  web: WebClient,
  imContext: IMContext,
  items: AskConfirmItem[],
  decisions: Map<string, ConfirmDecision>,
  timedOut: boolean,
): Promise<void> {
  const lines = items.map(i => {
    const d = decisions.get(i.id)
    if (d === 'accept') return `✅ 已采纳: ${i.title}`
    if (d === 'reject') return `❌ 已忽略: ${i.title}`
    return `⏱ 超时未决: ${i.title}`
  })
  await web.chat.postMessage({
    channel: imContext.channelId,
    thread_ts: imContext.threadTs,
    text: lines.join('\n'),
  })
}
```

## 5. 接入

### 5.1 依赖装配 (`src/application/createApplication.ts`)

```typescript
const confirmBridge = new ConfirmBridge({ logger: logger.withTag('confirm-bridge') })

// toolsBuilder 里注册
tools.ask_confirm = askConfirmTool(ctx, {
  confirmBridge,
  webClient: slackWeb,
  logger: logger.withTag('tool:ask_confirm'),
})
```

### 5.2 ToolContext 扩展

`imContext` 已有 `threadTs/channelId`；`toolCallCtx.toolCallId` 由 vercel ai SDK 传入。不需要新增字段。

## 6. 文件清单

| 文件 | 状态 | 说明 |
|---|---|---|
| `src/im/slack/ConfirmBridge.ts` | 新增 | Promise 桥 + 超时 + 单 pending |
| `src/im/slack/ConfirmBridge.test.ts` | 新增 | 单测：resolve / reject / timeout / abort / 并发禁止 |
| `src/agent/tools/askConfirm.ts` | 新增 | tool 定义 |
| `src/agent/tools/index.ts` | 修改 | 注册 `ask_confirm` |
| `src/application/createApplication.ts` | 修改 | 装配 ConfirmBridge + 注入 toolsBuilder + 传给 SlackAdapter |
| `src/im/slack/SlackAdapter.ts` | 修改 | action handler 加 `ask:*` 超时 fallback 分支 |

不改：SlackConfirm / self_improve_confirm。

## 7. 交互流程（时序图）

```
[User]  @bot "把这 3 个人开白名单"
  │
  ▼
[MainAgent]  (LLM 推理) → 判定需用户确认
  │
  │ tool call: ask_confirm({ items: [{id: u1, title: 'Alice'}, {id: u2...}] })
  ▼
[ask_confirm] 
  ├ bridge.hasPending? → 无
  ├ slackConfirm.send → Slack Block Kit 卡片出现 (按钮: Accept/Reject)
  └ bridge.awaitAllDecisions  ← 阻塞，等 3 个决定
  │
[User] 在 Slack 点 "Accept Alice"
  │
  ▼
[SlackAdapter] app.action(/^confirm:ask:<tid>:accept:u1/) → 
  slackConfirm.getCallback('ask:<tid>') → onDecision({id: 'u1', decision: 'accept'}) → 
  bridge.resolveOne({ toolCallId, itemId: 'u1', decision: 'accept' })
  │
[User] 点 "Reject Bob" 点 "Accept Carol"  (类似路径)
  │
[ConfirmBridge] 3 个都到齐 → resolve
  │
[ask_confirm] 
  ├ chat.postMessage "✅ 已采纳: Alice  ❌ 已忽略: Bob  ✅ 已采纳: Carol"
  └ return { decisions: [{id:'u1', decision:'accept'}, ...] }
  │
[MainAgent]  拿到 decisions → 下一轮 LLM：调业务 tool 对已 accept 的执行开白，对 reject 的跳过，对用户回文字报告结果
```

## 8. 关键设计决策

### 8.1 为什么新增 tool 而非扩展 `self_improve_confirm`

两者语义根本不同：
- `self_improve_confirm`：**发完即返**，副作用（写 system.md）在 onDecision 里
- `ask_confirm`：**阻塞等待**，决定返给 LLM，业务逻辑在 LLM 侧

把它们合并成一个 tool 会让参数/返回/是否阻塞都需要开关切换，主 Agent 决策成本高。分成两个 tool，描述清晰，LLM 选择准确。

### 8.2 为什么禁止同 thread 并发 ask_confirm

kagura 的 `SlackUserInputBridge` 也是单 pending。理由：
- 用户心智上一次只能处理一个确认场景
- 两个 ask_confirm 同时在等，用户点的按钮归属哪一个？namespace 隔离能区分但用户会混乱
- 禁止后实现极简：Map<threadTs, pending>

### 8.3 为什么默认超时 10 分钟

- 用户可能离开工位，1 分钟太短（kagura 没设超时但靠 signal，我们加默认是为了避免内存泄漏）
- 10 分钟是经验值，长到覆盖常见 AFK，短到不会挂太久
- 允许 tool 参数 `timeoutMs` 覆盖（业务场景可以要求更长/更短）

### 8.4 为什么点击后回帖 thread

- 按钮点击改卡片是无痕的（kagura 文字回复本身留言，天然可见）
- 回帖让整个对话历史可审计："机器人发起 → 用户决定 → 机器人执行"
- 回帖也让 LLM 下一轮回看 thread 时有上下文（它不仅能从 tool return 看到 decisions，也能从消息历史看到）

### 8.5 超时的分两类

- **硬超时** `timeoutMs`：tool 层面，到了就 reject，partial decisions 仍可返回（timeout 条目填 'timeout'）
- **AbortSignal**：vercel ai SDK 传下来（例如用户说"算了"触发新一轮 LLM，旧 tool 被取消）

### 8.7 超时后按钮 fallback 选 C（adapter 分支 + ephemeral 提示）

对比：
- A 不做：用户点击无反馈，体验差
- B `chat.update` 改静态文案：要加 `SlackConfirm.markExpired`，且 update 抢占所有 item 的按钮状态（已决定的条目按钮会被抹掉）
- **C adapter 分支 + ephemeral**：代价最小（只在 adapter handler 加一个分支），点击者有感知（ephemeral 只他自己看见），已决定的 item 按钮状态保留

代价：SlackAdapter 需注入 `confirmBridge.hasPending` 依赖。

## 9. 未解决问题

1. **回帖权限**：直接用 `webClient.chat.postMessage` 需要 bot 有 `chat:write`。onboard 文档应说明。
2. **timeout 的用户端感知**：10 分钟无操作 tool 已返，但 Slack 的 `app.action` 路由一直在，`slackConfirm` 的 onDecision 回调也还在 registry。用户点按钮 → 回调 → `bridge.resolveOne` 发现 pending 不在直接忽略，UI 完全没变化（像死了）。
   **方案 C**：按钮保留。SlackAdapter action handler 里在调 `onDecision` 前判定：若 `confirmBridge` 无 pending 但 namespace 以 `ask:` 开头，用 `respond({ replace_original: false, response_type: 'ephemeral', text: '⏱ 此确认已超时，请重新请求 @bot' })` 给点击者一条 ephemeral 提示。卡片不改动（避免抢其他 item 按钮的更新）。
   实现点：`SlackAdapter.handleConfirmAction` 加分支；需要一种方式让 adapter 知道"当前无 pending"——可用 `confirmBridge.hasPending(threadTs)` 暴露给 adapter。
3. **LLM 幻觉**：如果 LLM 在 ask_confirm 返回前自行假设"用户肯定同意"继续执行其他 tool，就绕过了确认。靠 prompt 约束（类似 kagura processors.ts 的 "CRITICAL USER-CONFIRMATION RULES"）。一期先写在 tool description。

## 10. 实施计划

| 阶段 | 内容 | 状态 |
|---|---|---|
| Q0 | `ConfirmBridge` 类 + 单测（resolve/reject/timeout/abort/并发） | ✅ |
| Q1 | `askConfirm` tool | ✅ |
| Q2 | 接入 createApplication + tools/index.ts | ✅ |
| Q3 | 端到端联调（真实 Slack）| ✅ |

**联调结果**（2026-04-23）：
- 发现 namespace 含冒号导致 `parseConfirmActionId` 拆错的 bug，已修（namespace 分隔符改 `-`）
- 用户反馈 thread 回帖反馈多余，已去掉 `postFeedback`（接口 + 实现 + 调用 + helper 全删）

完成标准（已验证）：
- 主 Agent `@bot 帮我确认开白名单给 [A, B, C]` 能触发 ask_confirm，收到按钮卡片
- 逐一点击后卡片分别更新
- Tool 返回后 LLM 看到 decisions，继续执行后续业务
