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

### 5.1 Tool 定义：`src/agent/tools/selfImprove.ts`

```typescript
import { tool } from 'ai'
import { z } from 'zod'

export function selfImproveTool(ctx: ToolContext, deps: SelfImproveDeps) {
  return tool({
    description:
      '分析工作区的历史对话和记忆，提取反复出现的模式和经验教训，生成高质量规则。生成后会逐条发给用户确认。',
    parameters: z.object({
      scope: z.enum(['all', 'recent']).optional().describe('分析范围：all=全部历史，recent=最近 7 天。默认 recent'),
      focus: z.string().optional().describe('聚焦分析的主题，如 "代码风格"、"错误处理"'),
    }),
    async execute({ scope, focus }) {
      // 1. 收集数据源
      // 2. 调用 LLM 分析生成候选规则
      // 3. 返回规则列表（由 Agent 逐条发 Block Kit 消息）
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
  // 为控制 token，只保留关键信息的摘要而非完整对话
  highlights: string[]
}
```

职责：
- 遍历 `.agent-slack/sessions/slack/` 下所有 session 目录
- 按 `scope` 参数过滤时间范围
- 从 `messages.jsonl` 提取：错误消息、用户反复提及的主题、tool 调用模式
- 从 `memory/*.md` 读取用户记忆
- 读取现有 `system.md` 避免重复
- **Token 控制**：对话内容不全量传入，只提取关键信号（错误、纠正、重复模式）

### 5.4 规则生成器：`src/agent/tools/selfImprove.generator.ts`

```typescript
export interface CandidateRule {
  id: string                      // uuid，用于 Block Kit action_id
  content: string                 // 规则正文（Markdown）
  category: string                // 分类：code-standards | behavior | guardrails | workflow
  confidence: 'high' | 'medium'  // 置信度
  evidence: string                // 来源证据摘要
}
```

职责：
- 接收 `CollectedData` + 规则编写常量
- 调用 LLM 分析数据，生成 `CandidateRule[]`
- 过滤掉与现有规则重复的条目
- 按置信度排序

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

```typescript
// selfImprove.ts tool 内部
const rules: CandidateRule[] = await generateRules(...)

await slackConfirm.send({
  web: deps.web,
  channelId: ctx.channelId,
  threadTs: ctx.threadTs,
  items: rules.map((r, i) => ({
    id: r.id,
    body: `*📝 候选规则 (${i + 1}/${rules.length})*\n分类：\`${r.category}\` · 置信度：${r.confidence === 'high' ? '🟢' : '🟡'} ${r.confidence}\n\n> ${r.content}`,
    context: `📎 *证据*：${r.evidence}`,
  })),
  labels: { accept: '✅ 采纳', reject: '❌ 跳过' },
  onDecision: async (ruleId, decision) => {
    if (decision === 'accept') {
      const rule = rules.find(r => r.id === ruleId)
      if (rule) await appendToSystemMd(paths, rule.content)
    }
  },
})
```

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
export function buildBuiltinTools(ctx: ToolContext, deps: { memoryStore: MemoryStore }): ToolSet {
  return {
    bash: bashTool(ctx),
    edit_file: editFileTool(ctx),
    save_memory: saveMemoryTool(ctx, { memoryStore: deps.memoryStore }),
    self_improve: selfImproveTool(ctx, { /* deps */ }),
  }
}
```

### 6.2 依赖注入

`selfImproveTool` 需要以下依赖（通过 `createApplication` 注入）：

| 依赖 | 来源 | 用途 |
|---|---|---|
| `paths: WorkspacePaths` | `ctx.paths` | 定位 sessions/memory/system.md 目录 |
| `model: LanguageModel` | runtime | 规则生成的 LLM 调用 |
| `slackConfirm: SlackConfirm` | SlackAdapter 共享 | 通用确认交互 |
| `logger` | ctx | 日志 |

> **注意**：self_improve tool 需要自己调用 LLM 来分析数据并生成规则，这是一个 "tool 内部再调 LLM" 的模式。可通过 deps 注入 model 实现。

## 7. 文件清单

| 文件 | 类型 | 职责 |
|---|---|---|
| `src/im/slack/SlackConfirm.ts` | **新增** | 通用 Block Kit 确认交互模块（IM 层，业务无关） |
| `src/im/slack/SlackConfirm.test.ts` | **新增** | `buildConfirmBlocks` 纯函数单测 + callback 路由单测 |
| `src/agent/tools/selfImprove.ts` | **新增** | Tool 定义 & 主流程编排 |
| `src/agent/tools/selfImprove.constants.ts` | **新增** | AGENTS.md 编写规则常量 |
| `src/agent/tools/selfImprove.collector.ts` | **新增** | 数据收集器（读 sessions/memory） |
| `src/agent/tools/selfImprove.generator.ts` | **新增** | 规则生成器（调 LLM 分析） |
| `src/agent/tools/selfImprove.test.ts` | **新增** | 单元测试 |
| `src/agent/tools/index.ts` | 修改 | 注册 self_improve tool |
| `src/im/slack/SlackAdapter.ts` | 修改 | 注册通用 `app.action(/^confirm:/)` 处理器 |
| `src/application/createApplication.ts` | 修改 | 创建 SlackConfirm 实例并注入 |

## 8. 交互流程

```
用户: @bot 帮我总结一下最近的经验，生成规则
  │
  ▼
Agent: 调用 self_improve({ scope: 'recent' })
  │
  ▼
Tool: 收集最近 7 天的 session 数据 + memory
  │
  ▼
Tool: 调用 LLM 分析，生成 5 条候选规则
  │
  ▼
Tool: 返回规则列表给 Agent
  │
  ▼
Agent: "我分析了最近 12 个 session，发现以下 5 条可提炼的规则："
       逐条发 Block Kit 消息（带 ✅采纳 / ❌跳过 按钮）
  │
  ▼
用户: 点击 ✅ 或 ❌
  │
  ▼
app.action(): 采纳 → 追加到 system.md，更新消息为 "✅ 已采纳"
              跳过 → 更新消息为 "❌ 已跳过"
```

## 9. 关键设计决策

### 9.1 Tool 内部再调 LLM

self_improve 的核心工作是 "从对话历史中提取模式"，这必须由 LLM 完成。方案：通过 deps 注入 `model`，在 tool execute 内部使用 `generateText()` 做二次 LLM 调用。

**替代方案**：不在 tool 内调 LLM，而是 tool 只负责收集数据，然后返回给主 Agent，让主 Agent 用自身上下文生成规则。

**选择**：采用替代方案更简单——tool 只做数据收集和规则写入，规则生成由主 Agent 完成。这样避免了 "tool 内部需要 model" 的依赖复杂度。

最终拆分：
- `self_improve_collect`：收集 session/memory 数据，返回摘要
- Agent 自身：根据摘要 + 规则编写常量（注入 system prompt）生成规则
- Agent 自身：调用 Slack API 发送 Block Kit 确认消息（或通过新 tool）
- `self_improve_save`：将已确认规则写入 system.md

> 但这样 Agent 需要多轮 tool call，且 Block Kit 消息的发送不属于 Agent 的职责。最终决策待 review 确定。

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

1. **Token 预算**：session 数据可能很大，如何控制传给 LLM 的 token 量？→ collector 只提取关键信号
2. **规则去重**：如何检测新规则与现有规则的语义重复？→ 一期用简单文本匹配，后续可加 embedding
3. **Tool 拆分 vs 单一 Tool**：是做一个 `self_improve` 还是拆成 `self_improve_collect` + `self_improve_save`？→ 待 review
4. **LLM 调用方式**：tool 内部调 LLM 还是让主 Agent 生成规则？→ 待 review
5. **Slack App 权限**：`app.action()` 需要在 Slack App 配置中开启 Interactivity，需确认 Socket Mode 下是否自动支持

## 11. 实施计划

| 阶段 | 内容 | 说明 |
|---|---|---|
| P0 | 通用 SlackConfirm 模块 (`SlackConfirm.ts` + 测试) | **独立可交付**，不依赖 self-improve 业务；`buildConfirmBlocks` 纯函数 + callback 路由 |
| P1 | SlackAdapter 接入 `app.action(/^confirm:/)` | 注册通用处理器，P0 完成后即可验证按钮交互 |
| P2 | 规则编写常量 (`selfImprove.constants.ts`) | 独立可交付，无代码依赖 |
| P3 | 数据收集器 (`selfImprove.collector.ts`) + 测试 | 核心 |
| P4 | 规则生成器 (`selfImprove.generator.ts`) + 测试 | 核心 |
| P5 | Tool 定义 + 注册 + 端到端联调 | 集成 |
