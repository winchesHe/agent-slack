# Self-Improve Tool 设计文档

> **状态**: Draft
> **创建日期**: 2026-04-22
> **关联**: 内置 Tool · Slack Block Kit 交互确认

---

## 1. 目标

为 agent-slack 新增 `self_improve` 内置 Tool，让用户通过 @mention 触发，agent 自动分析工作区内的 session 历史和 memory 数据，提取反复出现的模式、常见错误和用户偏好，生成高质量的 AGENTS.md 风格规则，并逐条发送到 Slack 由用户交互式确认后写入。

## 2. 触发方式

用户 @mention bot，自然语言表达意图（如 "总结经验"、"生成规则"、"自我改进"），agent 识别意图后调用 `self_improve` tool。

不需要 slash command，完全复用现有 `app_mention` 通路。

## 3. 架构概览

```
用户 @mention → Orchestrator → Agent（LLM）→ 调用 self_improve tool
                                                    │
                                    ┌───────────────┼───────────────┐
                                    ▼               ▼               ▼
                              读 sessions/    读 memory/       读 AGENTS.md
                              messages.jsonl  *.md             (现有规则)
                                    │               │               │
                                    └───────┬───────┘───────────────┘
                                            ▼
                                  LLM 分析 & 生成候选规则
                                            │
                                            ▼
                                  返回 JSON 规则列表给 Agent
                                            │
                                            ▼
                           self_improve_confirm 内 LLM 语义去重
                           （对照 experience.md + system.md 筛选 keep 集合；
                            失败降级为 Jaccard generator）
                                            │
                                            ▼
                                  Agent 逐条发 Block Kit 消息
                                  （✅ 采纳 / ❌ 跳过 按钮）
                                            │
                                            ▼
                                  app.action() 处理用户点击
                                  采纳 → 追加写入 AGENTS.md
                                  跳过 → 更新消息为已跳过
```

## 4. 数据源

| 数据源 | 路径 | 内容 |
|---|---|---|
| Session 对话记录 | `.agent-slack/sessions/slack/*/messages.jsonl` | 完整的 user/assistant/tool 消息 JSONL |
| Session 元数据 | `.agent-slack/sessions/slack/*/meta.json` | 状态、用量、时间戳 |
| 用户长期记忆 | `.agent-slack/memory/*.md` | agent 主动保存的用户偏好/知识 |
| 现有规则 | `.agent-slack/experience.md`（以及 `system.md` / 项目 `AGENTS.md`，供去重参考） | 避免生成重复规则 |

## 5. 核心模块设计

### 5.1 Tool 定义（双 tool 模式）

按 §9.1 结论，不在 tool 内调 LLM。拆成两个 tool：主 Agent 先调 `self_improve_collect` 拿数据，在自己的 assistant 回合里按 `AGENTS_RULE_WRITING_GUIDE` 生成候选规则 JSON，再调 `self_improve_confirm` 做后处理 + 发送确认。

```typescript
// src/agent/tools/selfImproveCollect.ts
// thin wrapper，核心 collector 在 src/agents/selfImprove/collectorAgent.ts
export function selfImproveCollectTool(ctx: ToolContext, deps: SelfImproveCollectDeps) {
  return tool({
    description:
      '收集当前工作区的 session 历史与 memory，返回摘要数据与 AGENTS.md 规则编写指南。调用后你需要基于返回的数据自行提炼候选规则，再调用 self_improve_confirm 做发送。',
    parameters: z.object({
      scope: z.union([z.literal('--all'), z.number().int().positive()]).optional().describe('分析范围：--all=全部历史（默认）；数字=最近 N 天'),
      focus: z.string().optional().describe('聚焦主题提示，仅透传到返回值的 focus 字段，供你自行参考'),
    }),
    async execute({ scope, focus }) {
      const data = await collector.collect(scope ?? '--all')
      return { ...data, guide: AGENTS_RULE_WRITING_GUIDE, focus: focus ?? null }
    },
  })
}

// src/agent/tools/selfImproveConfirm.ts
// thin wrapper，核心 generator 在 src/agents/selfImprove/generatorAgent.ts
export function selfImproveConfirmTool(ctx: ToolContext, deps: SelfImproveConfirmDeps) {
  return tool({
    description:
      '将你已生成的候选规则发送到 Slack 供用户逐条点击确认。tool 会做去重、排序、过滤后，再以按钮消息发送。',
    parameters: z.object({
      rules: z.array(z.object({
        id: z.string(),
        content: z.string(),
        category: z.string(),
        confidence: z.enum(['high', 'medium']),
        evidence: z.string(),
      })),
    }),
    async execute({ rules }) {
      const processed = generator.process(rules, existingRules)
      // 无 confirm 通道（非 Slack 场景）或全部被过滤时返回 reason
      if (!ctx.confirm) return { sent: 0, skipped: rules.length, reason: 'no_confirm_channel' }
      if (processed.length === 0) return { sent: 0, skipped: rules.length, reason: 'all_filtered' }
      await ctx.confirm.send({ ... })
      return { sent: processed.length, skipped: rules.length - processed.length }
    },
  })
}
```

### 5.2 Prompt 归口：`src/agents/selfImprove/prompts.ts`

将用户提供的 AGENTS.md 编写规则作为 **常量** 保存在 `src/agents/selfImprove/prompts.ts`，作为 LLM 生成规则时的约束 prompt。`src/agent/tools/*` 只保留 AI SDK tool wrapper，不再存放长 prompt。

核心内容包括：
- **好规则的标准**：帮助 agent 回答安装/构建/测试、目录结构、约定、禁止变更区域、完成前检查等问题
- **核心设计规则**：写最小完整操作文档
- **编写原则 P0-P6**：Token 成本、邻近性、具体性、护栏优先、密度、训练对齐、可验证性
- **决策规则**：具体事实 > 通用指导、短命令 > 解释、约束 > 愿望
- **自检清单**

### 5.3 数据收集器：`src/agents/selfImprove/collectorAgent.ts`

```typescript
export interface CollectedData {
  sessions: SessionSummary[]      // 从 messages.jsonl 提取的摘要
  memories: MemoryEntry[]         // 用户记忆内容
  existingRules: string           // 现有 experience.md + system.md + AGENTS.md 合并内容（去重参考）
}

export interface SessionSummary {
  sessionId: string
  channelName: string
  messageCount: number
  hasErrors: boolean              // 是否包含 [error:] 消息
  toolUsage: Record<string, number>
  createdAt: string
  updatedAt: string
  // 结构化按 API round 保留，借鉴 Claude Code compact 思路：user→assistant→tool 为一组
  rounds: SessionRound[]
  // confirm 按钮决策审计，来自 events.jsonl（自 P7 起）
  confirmActions: ConfirmActionSummary[]
}

export interface SessionRound {
  userMessage: string                                // 截 2000 字
  assistantTexts: string[]                           // 每条截 1000 字
  toolCalls: { name: string; error?: string }[]     // 成功只记 name，失败保留 error 片段
}

export interface ConfirmActionSummary {
  namespace: string                                  // ask-<toolCallId> | self_improve
  itemId: string
  decision: 'accept' | 'reject'
  timestamp: string
  callbackError?: string                             // 点击成功但业务 callback 失败时保留（截 500 字）
}
```

职责：
- 遍历 `.agent-slack/sessions/slack/` 下所有 session 目录
- 按 `scope` 参数过滤时间范围
- 从 `messages.jsonl` 按 user 消息分 round，结构化提取 user / assistant / tool 内容
- 从 `events.jsonl` 读 `confirm_action` 事件（其他类型忽略），供主 Agent 识别"哪些建议被用户拒绝 / 接受"等偏好信号
- 从 `memory/*.md` 读取用户记忆
- 读取现有 `experience.md`（以及 `system.md` / `AGENTS.md`）避免重复
- **Token 控制**：单 session rounds 序列化超过 `MAX_SESSION_CHARS = 12000`（~3000 tokens）时从最旧 round 往后丢
- **调试支持**：`collect()` 完成时打 `debug` 日志输出 `SessionSummary` 轻量视图（sessionId / channelName / messageCount / toolUsage / roundCount / confirmActionCount），便于 `LOG_LEVEL=debug` 时排障

### 5.4 规则后处理器（generator）：`src/agents/selfImprove/generatorAgent.ts`

**职责已变更**：本模块**不调 LLM**，纯代码后处理。由 `self_improve_confirm` tool 作为 **LLM 语义去重失败时的 fallback** 调用，负责在主 Agent 生成候选规则后做：

1. **字段校验 & 归一化**：剔除 `content` 为空、`id` 缺失的条目
2. **与现有规则去重**：用简化文本匹配（规范化空白 + 小写后做 `includes` / Jaccard 比较），命中 existingRules 的候选丢弃
3. **组内去重**：同一批候选里语义高度重复的合并保留首个
4. **排序**：按 `confidence`（high > medium） + `category` 稳定排序

```typescript
export interface CandidateRule {
  id: string
  content: string
  category: string
  confidence: 'high' | 'medium'
  evidence: string
}

export interface SelfImproveGenerator {
  /** 返回经过过滤/去重/排序的候选规则，供发送给用户确认 */
  process(rules: CandidateRule[], existingRules: string): CandidateRule[]
}

// 为便于白盒单测，额外导出：
export function tokenize(text: string): Set<string>
export function jaccard(a: Set<string>, b: Set<string>): number
```

**tokenize 细节**（顺序敏感）：
1. `toLowerCase()`：大小写归一
2. 去 Markdown 标点（` ` * _ > # [ ] ( ) ~ `）：避免 `**any**` ≠ `any`
3. `split(/[^\p{L}\p{N}]+/u)` Unicode-aware 切分：`\w` 不含中文，改用 Unicode 字母/数字类
4. 过滤长度 <2 的 token：剔除 "的" "a" "i" 之类噪音

**Jaccard 阈值 `JACCARD_THRESHOLD = 0.6`**：0.5 太松（"禁止使用 any" 和 "禁止使用 unknown" 误判重）；0.7 太严（"禁止 any，改用 unknown" 和 "不要用 any，用 unknown" 漏判）。0.6 是经验折中；兜底靠用户确认按钮。

**排序**：`confidence`（high > medium） + `category.localeCompare`，双键稳定排序。同输入始终同输出，便于测试与截图复现。

**`splitExistingRules`**：按 Markdown 标题（`#` 开头）和列表项（`-*+` 开头）切片 existingRules 原文，得到"规则单元"集合，避免整段文本被当成一个大 token 集合稀释 Jaccard。

职责边界：
- **不**调 LLM、不读文件；接收纯数据，返回纯数据
- 保证幂等：相同输入得到相同输出

### 5.5 通用 Slack 确认交互模块：`src/im/slack/SlackConfirm.ts`

Block Kit 确认交互抽成**通用模块**，不绑定 self-improve 业务。任何 tool 需要用户确认时都可复用。

#### 5.5.1 接口设计

```typescript
// src/im/slack/SlackConfirm.ts

import type { WebClient } from '@slack/web-api'
import type { App } from '@slack/bolt'
import type { Logger } from '@/logger/logger.ts'

// ── 通用类型 ──────────────────────────────────────────

/** 一个待确认条目（业务无关） */
export interface ConfirmItem {
  /** 唯一 ID，用于 action_id 路由 */
  id: string
  /** Section 区块的 mrkdwn 正文 */
  body: string
  /** 可选 context 区块（如证据、来源说明） */
  context?: string
}

/** 确认按钮文案，可由调用方自定义 */
export interface ConfirmLabels {
  accept?: string   // 默认 "✅ 采纳"
  reject?: string   // 默认 "❌ 跳过"
}

/** 用户点击后的回调 */
export type ConfirmDecision = 'accept' | 'reject'
export type ConfirmCallback = (
  itemId: string,
  decision: ConfirmDecision,
) => Promise<void>

/** SlackConfirm 实例 */
export interface SlackConfirm {
  /**
   * 向指定 channel/thread 发送一批待确认条目。
   * 每个条目一条消息，带 accept/reject 按钮。
   */
  send(opts: {
    web: WebClient
    channelId: string
    threadTs: string
    items: ConfirmItem[]
    labels?: ConfirmLabels
    onDecision: ConfirmCallback
  }): Promise<void>
}
```

#### 5.5.2 命名空间隔离

每个业务场景注册时使用 **namespace 前缀**，避免 action_id 冲突：

```
action_id = "confirm:<namespace>:<decision>:<itemId>"

示例：
  confirm:self_improve:accept:rule-abc123
  confirm:deploy:accept:pr-456
```

`app.action()` 只注册一个正则处理器，按 namespace 路由到对应的 `ConfirmCallback`。

#### 5.5.3 内部实现要点

```typescript
// createSlackConfirm 工厂函数
export function createSlackConfirm(deps: { logger: Logger }): SlackConfirm {
  // namespace → callback 的注册表
  const callbackRegistry = new Map<string, ConfirmCallback>()

  return {
    async send({ web, channelId, threadTs, items, labels, onDecision }) {
      const ns = generateNamespace()  // 或由调用方传入
      callbackRegistry.set(ns, onDecision)

      for (const item of items) {
        await web.chat.postMessage({
          channel: channelId,
          thread_ts: threadTs,
          blocks: buildConfirmBlocks(item, ns, labels),
          text: item.body,  // fallback
        })
      }
    },
  }
}

// Block Kit 构建（纯函数，可单测）
export function buildConfirmBlocks(
  item: ConfirmItem,
  namespace: string,
  labels?: ConfirmLabels,
): KnownBlock[] {
  const acceptLabel = labels?.accept ?? '✅ 采纳'
  const rejectLabel = labels?.reject ?? '❌ 跳过'

  const blocks: KnownBlock[] = [
    {
      type: 'section',
      text: { type: 'mrkdwn', text: item.body },
    },
  ]

  if (item.context) {
    blocks.push({
      type: 'context',
      elements: [{ type: 'mrkdwn', text: item.context }],
    })
  }

  blocks.push({
    type: 'actions',
    block_id: `confirm:${namespace}`,
    elements: [
      {
        type: 'button',
        action_id: `confirm:${namespace}:accept:${item.id}`,
        text: { type: 'plain_text', text: acceptLabel },
        style: 'primary',
        value: item.id,
      },
      {
        type: 'button',
        action_id: `confirm:${namespace}:reject:${item.id}`,
        text: { type: 'plain_text', text: rejectLabel },
        style: 'danger',
        value: item.id,
      },
    ],
  })

  return blocks
}
```

#### 5.5.4 Action Handler 注册

在 `SlackAdapter.ts` 中注册**一个**通用正则处理器，所有 confirm 场景共享：

```typescript
// SlackAdapter.ts 新增
app.action(/^confirm:/, async ({ action, ack, client, body }) => {
  await ack()

  // action_id 格式: confirm:<namespace>:<decision>:<itemId>
  const match = action.action_id.match(/^confirm:([^:]+):(accept|reject):(.+)$/)
  if (!match) return

  const [, namespace, decision, itemId] = match
  const callback = slackConfirm.getCallback(namespace)
  if (!callback) {
    log.warn('confirm callback not found', { namespace, itemId })
    return
  }

  // 执行业务回调
  await callback(itemId, decision as ConfirmDecision)

  // 更新消息：移除按钮，显示结果
  const resultText = decision === 'accept'
    ? `✅ 已采纳`
    : `❌ 已跳过`

  await client.chat.update({
    channel: body.channel.id,
    ts: body.message.ts,
    blocks: [
      body.message.blocks[0],                          // 保留原 section
      ...(body.message.blocks[1]?.type === 'context'   // 保留原 context（如有）
        ? [body.message.blocks[1]]
        : []),
      {
        type: 'context',
        elements: [{ type: 'mrkdwn', text: resultText }],
      },
    ],
    text: resultText,
  })
})
```

#### 5.5.5 self-improve 使用示例

> **透传方式**：tool 层不直接持有 `WebClient`。`ConfirmSender` 作为 IM-agnostic proxy 通过 `ToolContext.confirm` 注入。Slack 场景下由 SlackAdapter 在 `app_mention` 回调里构造一个绑定了 `web`/`channelId`/`threadTs` 的 `ConfirmSender` 实现，经 `InboundMessage.confirmSender` 流入 `ConversationOrchestrator.handle()`，再经 `ToolsBuilder` 带到 ToolContext。

```typescript
// IM-agnostic proxy，定义在 src/im/types.ts（或 src/agent/tools/bash.ts 的 ToolContext 旁边）
export interface ConfirmSender {
  send(opts: {
    items: ConfirmItem[]
    namespace: string
    labels?: ConfirmLabels
    onDecision: ConfirmCallback
  }): Promise<void>
}

// selfImproveConfirm.ts tool 内部
await ctx.confirm?.send({
  items: rules.map((r, i) => ({
    id: r.id,
    body: `*📝 候选规则 (${i + 1}/${rules.length})*\n分类：\`${r.category}\` · 置信度：${r.confidence === 'high' ? '🟢' : '🟡'} ${r.confidence}\n\n> ${r.content}`,
    context: `📎 *证据*：${r.evidence}`,
  })),
  namespace: 'self_improve',
  labels: { accept: '✅ 采纳', reject: '❌ 跳过' },
  onDecision: async (ruleId, decision) => {
    if (decision === 'accept') {
      const rule = rules.find(r => r.id === ruleId)
      if (rule) await appendToSystemMd(paths, rule)
    }
  },
})
```

`ctx.confirm` 为 optional：当 agent 运行在 IM 之外（如 CLI 测试、非 slack adapter）时，tool 直接 short-circuit 返回 `{ skipped: rules.length, reason: 'no_confirm_channel' }`。

#### 5.5.6 其他场景复用示例

```typescript
// 未来：部署确认
await slackConfirm.send({
  items: [{ id: 'deploy-1', body: '确认部署 `v2.3.1` 到 production？' }],
  labels: { accept: '🚀 部署', reject: '🛑 取消' },
  onDecision: async (id, decision) => { /* ... */ },
})

// 未来：危险操作确认
await slackConfirm.send({
  items: [{ id: 'delete-1', body: '确认删除 3 个过期 session？' }],
  labels: { accept: '确认删除', reject: '取消' },
  onDecision: async (id, decision) => { /* ... */ },
})
```

### 5.6 LLM 语义去重层（`self_improve_confirm` 内部，非 tool）

主 Agent 生成的 candidate rules 语义上可能与 `experience.md` / `system.md` 已有规则重复（Jaccard 捕获不到的同义改写）。在 `self_improve_confirm.execute` 中，**generator 之前**先走一层 LLM 语义去重。

**位置**：`src/agents/selfImprove/semanticDedupAgent.ts`（内部 helper，不作为 tool 暴露给主 Agent）。

**接口**：
```typescript
export interface SemanticDedupInput {
  rules: CandidateRule[]
  existingExperience: string
  existingSystem: string
}

export interface SemanticDedupDecision {
  id: string                  // candidate rule id
  action: 'keep' | 'drop'     // keep = 入选；drop = 被判为与已有规则或组内同义重复
  reason?: string             // 简要说明（日志用）
}

export interface SemanticDedupResult {
  decisions: SemanticDedupDecision[]
}

export interface SemanticDedup {
  process(input: SemanticDedupInput): Promise<SemanticDedupResult>
}

export function createSemanticDedup(deps: {
  model: LanguageModel
  logger: Logger
}): SemanticDedup
```

**实现要点**：
- 用 Vercel AI SDK `generateObject` + zod schema 约束输出，只要 `decisions`
- Prompt 说明：对照 existing（experience + system）和组内，判断每条是否与已有语义重复；要求给出每条的 keep/drop 决定
- 传入给 LLM 的 context：`rules`（id + content）+ `existingExperience`（原文）+ `existingSystem`（原文）
- 模型复用主 Agent `runtime.model`（通过 `SelfImproveConfirmDeps` 注入）

**在 `self_improve_confirm.execute` 中的调用顺序**：
1. 读 `experience.md` + `system.md`
2. `semanticDedup.process({ rules, existingExperience, existingSystem })`
3. 成功：取 `action === 'keep'` 的 rules，**不**再走 generator（直接进入排序 + 发送）
4. 失败（LLM 调用抛错 / schema 不合法 / 超时）：记 warn，fallback 到 `generator.process(rules, existingRules)`
5. 排序：AI 路径复用 generator 里的 `compareRules`（按 confidence + category）— 把排序提取为独立导出函数或重新实现一次，保证两条路径输出顺序一致

**职责边界**：
- 本模块**只做语义去重判决**，不负责排序/字段校验（字段校验由 tool 层 zod 做；排序由公用 `compareRules` 做）
- 失败路径必须安全 fallback，不能让 tool 报错导致用户侧体验断掉

```

## 6. Tool 注册接入

### 6.1 `src/agent/tools/index.ts`

```typescript
export function buildBuiltinTools(ctx: ToolContext, deps: BuiltinToolDeps): ToolSet {
  return {
    bash: bashTool(ctx),
    edit_file: editFileTool(ctx),
    save_memory: saveMemoryTool(ctx, { memoryStore: deps.memoryStore }),
    self_improve_collect: selfImproveCollectTool(ctx, { collector: deps.selfImproveCollector }),
    self_improve_confirm: selfImproveConfirmTool(ctx, {
      generator: deps.selfImproveGenerator,
      slackConfirm: deps.slackConfirm,
      paths: ctx.paths,
      logger: ctx.logger,
    }),
  }
}
```

### 6.2 依赖注入

通过 `createApplication` 注入：

| 依赖 | 来源 | 用途 |
|---|---|---|
| `paths: WorkspacePaths` | `ctx.paths` | 定位 sessions/memory/experience.md/system.md 目录 |
| `selfImproveCollector` | `createSelfImproveCollector({ paths, logger })` | 数据采集 |
| `selfImproveGenerator` | `createSelfImproveGenerator()` | 候选规则后处理（去重/排序/过滤，**语义去重失败时的 fallback**） |
| `semanticDedup` | `createSemanticDedup({ model, logger })` | LLM 语义去重（generator 之前执行，复用主 Agent 的 `runtime.model`） |
| `ctx.confirm?: ConfirmSender` | 每次 handle 由 SlackAdapter 绑定 web/channel/thread 构造，沿 `InboundMessage → Orchestrator → ToolsBuilder → ToolContext` 透传 | 通用确认交互 proxy（tool 层不接触 WebClient） |
| `logger` | ctx | 日志 |

> **透传链**：`SlackAdapter.app_mention` → 构造 `ConfirmSender` 实现 → 填入 `InboundMessage.confirmSender` → `ConversationOrchestrator.handle()` 转给 `toolsBuilder(currentUser, { confirm })` → 写入 `ToolContext.confirm` → `self_improve_confirm` 调 `ctx.confirm.send()`。
>
> `ConfirmSender` 在 `src/im/types.ts` 定义（IM-agnostic），Slack 具体实现在 `SlackAdapter.ts` 内部构造；未来其他 IM 可提供自己的 `ConfirmSender` 实现。

> **注意**：candidate rule 的生成由**主 Agent** 在自己的 assistant 回合里完成，**不**在 tool 内调 LLM。tool 只做纯代码处理与 IO。

## 7. 文件清单

| 文件 | 类型 | 职责 |
|---|---|---|
| `src/im/slack/SlackConfirm.ts` | **新增** | 通用 Block Kit 确认交互模块（IM 层，业务无关） |
| `src/im/slack/SlackConfirm.test.ts` | **新增** | `buildConfirmBlocks` 纯函数单测 + callback 路由单测 |
| `src/agents/selfImprove/prompts.ts` | **新增/迁移** | AGENTS.md 编写规则常量（`AGENTS_RULE_WRITING_GUIDE`）与 self-improve prompts |
| `src/agents/selfImprove/collectorAgent.ts` | **新增/迁移** | 数据收集器（读 sessions/memory/experience.md/system.md） |
| `src/agents/selfImprove/generatorAgent.ts` | **新增/迁移** | 规则后处理（去重/排序/过滤，**纯代码**，作为语义去重失败 fallback） |
| `src/agents/selfImprove/semanticDedupAgent.ts` | **新增/迁移** | LLM 语义去重 helper（`self_improve_confirm` 内部调用；失败降级到 generator） |
| `src/agent/tools/selfImproveCollect.ts` | **新增** | `self_improve_collect` tool 定义 |
| `src/agent/tools/selfImproveConfirm.ts` | **新增** | `self_improve_confirm` tool 定义 |
| `src/agents/selfImprove/*.test.ts` | **新增/迁移** | collector / generator / semantic dedup 单元测试 |
| `src/agent/tools/selfImprove.test.ts` | **新增** | tool wrapper 单元测试 |
| `src/agent/tools/index.ts` | 修改 | 注册两个 tool |
| `src/im/slack/SlackAdapter.ts` | 修改 | 注册通用 `app.action(/^confirm:/)` 处理器 |
| `src/application/createApplication.ts` | 修改 | 创建 SlackConfirm / collector / generator 并注入 |

## 8. 交互流程

```
用户: @bot 帮我总结一下最近的经验，生成规则
  │
  ▼
Agent: 调用 self_improve_collect({ scope: 7 })
  │
  ▼
Tool: 收集最近 7 天的 session 数据 + memory + existingRules，
      附带 AGENTS_RULE_WRITING_GUIDE 返回给 Agent
  │
  ▼
Agent: 基于返回数据 + guide，在自己的 assistant 回合里生成候选规则 JSON
  │
  ▼
Agent: 调用 self_improve_confirm({ rules: [...] })
  │
  ▼
Tool: semanticDedup.process() 对照 experience.md + system.md 做 LLM 语义去重
      ├─ 成功：取 keep 集合 → 排序
      └─ 失败：fallback 到 generator.process() 纯代码去重/排序
      ▼
      → slackConfirm.send() 每条一张 Block Kit 消息（✅采纳 / ❌跳过）
      → 返回 { sent, skipped, reason?, dedupMode: 'semantic' | 'generator' }
  │
  ▼
用户: 点击 ✅ 或 ❌
  │
  ▼
app.action(): 采纳 → 追加到 experience.md，更新消息为 "✅ 已采纳"
              跳过 → 更新消息为 "❌ 已跳过"
```

说明：`selfImproveConfirm` tool 启动时会执行一次性初始化：
- 若 `system.md` 未包含引用 experience.md 的固定标题（如 `## 经验`），在顶部注入一小段引用提示，要求 agent 每次任务前阅读 `.agent-slack/experience.md`（以可读标题做幂等去重，不用 HTML 注释锚点）
- `system.md` 里若已有旧的 `## 由 self_improve 产生的规则` 段**不做自动迁移**，保留由用户手动清理

## 9. 关键设计决策

### 9.1 Tool 内部不调 LLM，拆双 tool（最终结论）

self_improve 的核心工作是 "从对话历史中提取模式"，由 LLM 完成。两种方案：

**方案 A（最初设想）**：tool 内部调用 `generateText()`，通过 deps 注入 `model`，一次性产出 CandidateRule[]。
- 缺点：tool 新增 `model` 依赖，打破 "tool 只处理纯代码/IO" 的定位；可测性下降（单测要 mock LLM）。

**方案 B（最终采纳）**：拆两个 tool
- `self_improve_collect`：只收集数据 + 返回 `AGENTS_RULE_WRITING_GUIDE` 给主 Agent
- 主 Agent：在 assistant 回合里基于数据 + guide 生成候选规则 JSON
- `self_improve_confirm`：接收主 Agent 产出的 rules，generator 做纯代码后处理（去重/排序/过滤），再 `slackConfirm.send` 发送

**决策**：采用方案 B。理由：
- tool 只做纯代码 + IO，单测不需要 mock LLM
- 主 Agent 已有完整 LLM 能力 + session context + system prompt，生成规则质量更可信
- 和 save_memory 风格一致：tool 只负责写入，"什么值得保存" 由主 Agent 判断

### 9.1.1 Generator 内部 5 个子决策

1. **去重算法：Jaccard token 重叠**（备选：精确哈希 / 编辑距离）。精确哈希对改写失效；编辑距离 O(n²) 且对语序不稳定。Jaccard O(n+m)、对语序免疫、阈值直观。
2. **tool 返回格式：`{ sent, skipped, reason? }`**（备选：仅 number / 完整 rules 数组）。数字不够主 Agent 解释"为什么 0 条"；完整 rules 污染 context。`reason` 仅两个枚举 `'no_confirm_channel' | 'all_filtered'`，覆盖 sent=0 的两条真实路径。
3. **排序：confidence + category 字典序稳定排序**（备选：仅 confidence / 保留原序）。稳定性是测试可断言的前提；同 category 连排是附带体验收益。
4. **tool 命名：snake_case**（备选：camelCase）。与仓库现有 `bash` / `read_file` 等保持一致，降低主 Agent 选 tool 的认知负担。
5. **导出 tokenize + jaccard**（备选：只导 factory）。两者是算法基石且是纯函数，导出后可直接白盒单测（空字符串、纯 Markdown、中英混合、阈值边界 0.59/0.60/0.61）；不导出则必须通过构造 CandidateRule[] 间接触发，测试成本高 10 倍。代价是暴露内部 API，但两者语义极稳不会乱改。

### 9.2 Block Kit 交互 vs 纯文本确认

Block Kit 按钮优势：
- 用户体验好，一键操作
- 不占用对话上下文（按钮点击不是 app_mention）
- 可异步确认，不阻塞 agent

纯文本确认（用户回复 "采纳 1、3、5"）：
- 实现简单，不需要 `app.action()` 基础设施
- 但占用对话上下文，可能干扰后续对话

**选择**：Block Kit 按钮。虽然需要新增 `app.action()` 基础设施，但这是通用能力，后续其他交互场景也能复用。

### 9.3 规则写入位置

写入 `.agent-slack/experience.md`（独立于 `system.md`），原因：
- `experience.md` 是纯经验沉淀文件，`system.md` 是 agent 专属的系统提示文件
- 两者分离后 `system.md` 保持稳定（手写配置），`experience.md` 可以被频繁追加而不影响主 prompt 结构
- `experience.md` 由 `system.md` 中的一段**引用**激活：agent 每次任务前读取 `.agent-slack/experience.md` 吸收历史经验
- 引用注入与条目写入均用可读文本做幂等去重，**不使用 HTML 注释**（避免占用 context token）
  - 注入去重：`system.md.includes('## 经验')` 为 true 则跳过注入
  - 条目去重：`experience.md.includes(rule.content.trim())` 为 true 则跳过写入
- 旧版本写在 `system.md` 的内容**不做自动迁移**，保留由用户手动清理

### 9.4 语义去重：LLM 判决为主，Jaccard generator 为 fallback

主 Agent 生成的候选规则和已有规则经常语义相同但措辞不同（同一用户偏好被重复总结）。Jaccard 阈值 0.6 对这类改写仍会漏判，导致重复卡片堆积。

**选择**：在 `self_improve_confirm` 内、发送前，先走一层 LLM 语义去重（`createSemanticDedup`，复用主 Agent 的 `runtime.model`），输出每条 candidate 的 keep/drop 决定；只把 keep 集合交给排序 → 发送。

**fallback**：LLM 调用抛错 / 输出不合 schema / 超时 时，降级到 `generator.process(rules, existingRules)` 纯 Jaccard 去重，保证体验不会因 LLM 故障断掉。

**不在 fallback 成功路径上叠加 Jaccard generator**：LLM 已经基于完整语义做出判决，再叠加 Jaccard 反而引入多余假阳性。两条路径在 tool 返回值中用 `dedupMode: 'semantic' | 'generator'` 区分，供调试。

### 9.5 确认决策审计（log + events.jsonl）

`self_improve` 与 `ask-*` 共用 `SlackAdapter.handleConfirmAction` 路径，确认决策落到两处：

- **log**：callback 成功打 `info('confirm 决策已处理')`、失败打 `error`，tag `slack:confirm`，带 `namespace / itemId / decision / userId / channelId / messageTs`
- **session events.jsonl**：在 `<sessionDir>/events.jsonl` 追加 `ConfirmActionEvent`（详见 ask-confirm-design §8.6）

不把决策并入 `messages.jsonl`：messages 只装 AI SDK 的 `CoreMessage`，混入元信息会污染 LLM 上下文。events.jsonl 单独一个文件，将来可扩展其他运行事件（tool 生命周期、错误等）。

采纳的规则本身仍**只**落 `experience.md`（content 去重），events.jsonl 只记"谁在何时点了什么"，与规则文本解耦。

## 10. 未解决问题

1. **Token 预算**：session 数据可能很大，如何控制传给 LLM 的 token 量？→ collector 输出结构化 `SessionRound[]`（user 2000 字 / assistant 1000 字 / 错误 500 字），并按 `MAX_SESSION_CHARS = 12000` 从最旧 round 开始裁剪
2. **规则去重**：如何检测新规则与现有规则的语义重复？→ 一期用文本归一化 + `includes` / Jaccard，后续可加 embedding
3. ~~Tool 拆分 vs 单一 Tool~~ → 已决：**双 tool**（`self_improve_collect` + `self_improve_confirm`）
4. ~~LLM 调用方式：tool 内部调 LLM 还是让主 Agent 生成规则~~ → 已决：**主 Agent 生成**，tool 不调 LLM
5. **Slack App 权限**：`app.action()` 需要在 Slack App 配置中开启 Interactivity，需确认 Socket Mode 下是否自动支持

## 11. 实施计划

| 阶段 | 内容 | 说明 |
|---|---|---|
| P0 | 通用 SlackConfirm 模块 (`SlackConfirm.ts` + 测试) | **独立可交付**，不依赖 self-improve 业务；`buildConfirmBlocks` 纯函数 + callback 路由 |
| P1 | SlackAdapter 接入 `app.action(/^confirm:/)` | 注册通用处理器，P0 完成后即可验证按钮交互 |
| P2 | 规则编写常量 (`src/agents/selfImprove/prompts.ts`) | 独立可交付，无代码依赖 |
| P3 | 数据收集器 (`src/agents/selfImprove/collectorAgent.ts`) + 测试 | 核心 |
| P4 | 规则后处理器 (`src/agents/selfImprove/generatorAgent.ts`) + 测试 | **纯代码**，不调 LLM |
| P5 | 双 tool 定义 + 注册 + SlackAdapter 的 confirm 回调接入 experience.md 追加（含 system.md 引用注入，幂等）+ 端到端联调 | 集成 |
| P6 | LLM 语义去重（`src/agents/selfImprove/semanticDedupAgent.ts`）+ 注入 `model` 到 `self_improve_confirm` + fallback 到 generator | 新增语义去重能力，解决 Jaccard 漏判 |
