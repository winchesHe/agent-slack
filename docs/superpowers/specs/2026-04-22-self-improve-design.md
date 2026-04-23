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
| 现有规则 | `.agent-slack/system.md` 或项目 `AGENTS.md` | 避免生成重复规则 |

## 5. 核心模块设计

### 5.1 Tool 定义（双 tool 模式）

按 §9.1 结论，不在 tool 内调 LLM。拆成两个 tool：主 Agent 先调 `self_improve_collect` 拿数据，在自己的 assistant 回合里按 `AGENTS_RULE_WRITING_GUIDE` 生成候选规则 JSON，再调 `self_improve_confirm` 做后处理 + 发送确认。

```typescript
// src/agent/tools/selfImproveCollect.ts
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
      await slackConfirm.send({ ... })
      return { sent: processed.length, skipped: rules.length - processed.length }
    },
  })
}
```

### 5.2 规则生成 Prompt 常量：`src/agent/tools/selfImprove.constants.ts`

将用户提供的 AGENTS.md 编写规则作为 **常量** 保存在项目内，作为 LLM 生成规则时的约束 prompt。

核心内容包括：
- **好规则的标准**：帮助 agent 回答安装/构建/测试、目录结构、约定、禁止变更区域、完成前检查等问题
- **核心设计规则**：写最小完整操作文档
- **编写原则 P0-P6**：Token 成本、邻近性、具体性、护栏优先、密度、训练对齐、可验证性
- **决策规则**：具体事实 > 通用指导、短命令 > 解释、约束 > 愿望
- **自检清单**

### 5.3 数据收集器：`src/agent/tools/selfImprove.collector.ts`

```typescript
export interface CollectedData {
  sessions: SessionSummary[]      // 从 messages.jsonl 提取的摘要
  memories: MemoryEntry[]         // 用户记忆内容
  existingRules: string           // 现有 system.md / AGENTS.md 内容
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
}

export interface SessionRound {
  userMessage: string                                // 截 2000 字
  assistantTexts: string[]                           // 每条截 1000 字
  toolCalls: { name: string; error?: string }[]     // 成功只记 name，失败保留 error 片段
}
```

职责：
- 遍历 `.agent-slack/sessions/slack/` 下所有 session 目录
- 按 `scope` 参数过滤时间范围
- 从 `messages.jsonl` 按 user 消息分 round，结构化提取 user / assistant / tool 内容
- 从 `memory/*.md` 读取用户记忆
- 读取现有 `system.md` 避免重复
- **Token 控制**：单 session rounds 序列化超过 `MAX_SESSION_CHARS = 12000`（~3000 tokens）时从最旧 round 往后丢

### 5.4 规则后处理器（generator）：`src/agent/tools/selfImprove.generator.ts`

**职责已变更**：本模块**不调 LLM**，纯代码后处理。由 `self_improve_confirm` tool 调用，负责在主 Agent 生成候选规则后做：

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
```

职责边界：
- **不**调 LLM、不读文件；接收纯数据，返回纯数据
- 一期去重用文本归一化 + `includes` / 简单 Jaccard（≥0.6 判重复）；语义级去重留待后续
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
| `paths: WorkspacePaths` | `ctx.paths` | 定位 sessions/memory/system.md 目录 |
| `selfImproveCollector` | `createSelfImproveCollector({ paths, logger })` | 数据采集 |
| `selfImproveGenerator` | `createSelfImproveGenerator()` | 候选规则后处理（去重/排序/过滤） |
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
| `src/agent/tools/selfImprove.constants.ts` | **新增** | AGENTS.md 编写规则常量（`AGENTS_RULE_WRITING_GUIDE`） |
| `src/agent/tools/selfImprove.collector.ts` | **新增** | 数据收集器（读 sessions/memory/system.md） |
| `src/agent/tools/selfImprove.generator.ts` | **新增** | 规则后处理（去重/排序/过滤，**纯代码**） |
| `src/agent/tools/selfImproveCollect.ts` | **新增** | `self_improve_collect` tool 定义 |
| `src/agent/tools/selfImproveConfirm.ts` | **新增** | `self_improve_confirm` tool 定义 |
| `src/agent/tools/selfImprove.test.ts` | **新增** | 单元测试 |
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
Tool: generator.process() 去重/排序/过滤
      → slackConfirm.send() 每条一张 Block Kit 消息（✅采纳 / ❌跳过）
      → 返回 { sent, skipped }
  │
  ▼
用户: 点击 ✅ 或 ❌
  │
  ▼
app.action(): 采纳 → 追加到 system.md，更新消息为 "✅ 已采纳"
              跳过 → 更新消息为 "❌ 已跳过"
```

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

写入 `.agent-slack/system.md`（而非项目根目录 `AGENTS.md`），原因：
- `system.md` 是 agent 专属的系统提示文件，由 `loadWorkspaceContext` 自动加载
- 不污染项目源码中的 `AGENTS.md`
- 用户可随时手动编辑 `system.md` 调整规则

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
| P2 | 规则编写常量 (`selfImprove.constants.ts`) | 独立可交付，无代码依赖 |
| P3 | 数据收集器 (`selfImprove.collector.ts`) + 测试 | 核心 |
| P4 | 规则后处理器 (`selfImprove.generator.ts`) + 测试 | **纯代码**，不调 LLM |
| P5 | 双 tool 定义 + 注册 + SlackAdapter 的 confirm 回调接入 system.md 追加 + 端到端联调 | 集成 |
