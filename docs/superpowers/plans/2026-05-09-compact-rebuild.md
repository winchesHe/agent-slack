# Compact 重构实施计划

> **状态：已归档（2026-05-10 全部 6 个 Chunk 落地完成）**
>
> | Chunk | commit | 出口 |
> | --- | --- | --- |
> | 0 fixture + e2e 准备 | 见 git history | `tests/fixtures/compact/` 1M-char 确定性 fixture |
> | 1 COMPACT_INPUT_MAX_CHARS 120K → 1M | 见 git history | 过渡缓解，避免静默丢失 |
> | 2 A3 持久化层切断 + B3 严格正则 | `5cfa0ce` / `cadca58` | `loadMessages` 默认切片 + boundary 严格正则 |
> | 3 A2 三层处理 + PTL retry | `d5a58d7` / `c00dddc` / `0f63db5` / `4c03b9a` | tool_result 占位 / 媒体剥离 / PTL retry，删 `COMPACT_INPUT_MAX_CHARS` 硬截 |
> | 4 §3.7.6.3 prompt 重写 + 容量 | `b05e78c` / `acbfd2f` / `c5a8038` | 9 章节 + `<analysis>`/`<summary>` 双 block，`max_output_tokens=20K`，删 1200 cap + noise filter |
> | 5 events.jsonl 埋点 + e2e 矩阵 | `7fc4b68` / `63686b0` / `d30f4b5` / `bcb6328` / `35d2030` | 4 类 compact 事件埋点；新增 4 条 e2e（含 compact-effectiveness / no-rework / breaker-open）|
> | 6 A1 真实 input_tokens 触发 | `927bfbb` / `52ee43b` / `cadbf22` / `10920f4` | `lastApiInputTokens` 暴露 + `meta.context.lastUsage` 持久化 + token 优先 / 字符回退 |
>
> **最终状态**：371 单测全过；6/6 compact e2e PASS；spec §3.7.1.1 / §3.7.2 / §3.7.7 同步完成；3 条 memory feedback 落档（trigger / compression ratio / verbatim user content）。
>
> **遗留**（独立 spawned task，非本 plan 范围）：compact-command 偶发 `noStaleUsageBeforeCompactReply` finalize/runQueue 并发 race。

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 agent-slack 的 compact 子系统按 §3.7 review 后的目标设计重构，达成"真实有效压缩"——避免静默丢失、避免摘要叠摘要、避免无效重复触发，使长 thread 在压缩后真正瘦身且 agent 能续上工作。

**Architecture:** 持久化层切断（`loadMessages` 默认切片）+ 三层 compact 输入处理（tool_result 占位 / 媒体剥离 / PTL retry）+ 重写 prompt 为 9 章节双 block 结构 + `events.jsonl` 4 类埋点 + 真实 `input_tokens` 触发。代码改动跨 `SessionStore` / `ConversationOrchestrator` / `ContextCompactor` / `AiSdkExecutor` / `agents/compact`，但每切片独立可验证可回退。

**Tech Stack:** TypeScript / Node 22 / Vitest / `ai@^4.0.0` / `@ai-sdk/anthropic` / Slack Block Kit。

**Spec:** [`docs/superpowers/specs/2026-04-17-agent-slack-architecture-design.md`](../specs/2026-04-17-agent-slack-architecture-design.md) §3.7（已完成 review，2026-05-09）

---

## 文件结构

| 改动类型 | 路径 | 责任 |
|---|---|---|
| 新建 | `tests/fixtures/compact/README.md` | fixture 用途说明 + 构造方式 |
| 新建 | `tests/fixtures/compact/large-history-1m.jsonl` | 预生成的 ~1M chars 真实尺度 history（dense user/assistant + tool_use/result 配对） |
| 新建 | `scripts/build-compact-fixture.ts` | fixture 一次性生成脚本（伪英文 lorem，确定性种子） |
| 修改 | `src/store/SessionStore.ts` | `appendMessage` 强制 id；`loadMessages` 默认切片；新增 `loadFullTranscript` / `appendEvent` 扩展；`SessionEvent` union 加 4 类 compact 事件 |
| 修改 | `src/store/SessionStore.test.ts` | +id 强制、+切片、+loadFullTranscript、+严格正则 fallback、+事件 append |
| 修改 | `src/orchestrator/modelMessages.ts` | 删除 `splitHistoryAtLastCompact` 与 `buildCompactCandidateMessages`（candidate 概念退役） |
| 修改 | `src/orchestrator/modelMessages.test.ts` | 移除 candidate 相关用例 |
| 修改 | `src/orchestrator/ConversationOrchestrator.ts` | 简化 compact 输入路径直接消费 `loadMessages` 输出；触发判定改用真实 `lastUsage`（首轮 fallback 字符）；落 `events.jsonl` 4 类事件 |
| 修改 | `src/orchestrator/ConversationOrchestrator.test.ts` | 触发用例适配；事件断言；熔断分支 |
| 修改 | `src/orchestrator/ContextCompactor.ts` | 入口加 tool_result 占位 + 媒体剥离；`autoCompact` / `manualCompact` 嵌入 PTL retry 循环；返回结构带 `usage` / `ptlRetryCount` 给上游做事件 |
| 修改 | `src/orchestrator/ContextCompactor.test.ts` | 新增三层处理 + PTL retry + 异常分类用例 |
| 新建 | `src/agents/compact/groupMessagesByApiRound.ts` | 按 API round 切分 message[] 的纯函数 |
| 新建 | `src/agents/compact/groupMessagesByApiRound.test.ts` | round 切分单测（含 tool_use/result 配对场景） |
| 新建 | `src/agents/compact/stripImagesFromMessages.ts` | image / document block → 占位文字纯函数 |
| 新建 | `src/agents/compact/stripImagesFromMessages.test.ts` | 剥图单测 |
| 修改 | `src/agents/compact/compactAgent.ts` | `summarize` 加 `maxOutputTokens: 20_000` 透传；接受 PTL 回调 |
| 修改 | `src/agents/compact/prompts.ts` | 删除 `COMPACT_INPUT_MAX_CHARS` + `COMPACT_SUMMARY_MAX_CHARS`；改写 `COMPACT_SYSTEM_PROMPT` 为 9 章节双 block；`formatCompactSummary` 改为 strip `<analysis>` + 提取 `<summary>` |
| 修改 | `src/agents/compact/types.ts` | `CompactAgentInput` 加 `signal`；`summarize` 返回 `{ summary, usage }` |
| 修改 | `src/agent/AiSdkExecutor.ts` | aggregator 多存 `lastStepInputTokens`（覆盖语义）；`SessionUsageInfo` 加 `lastApiInputTokens` |
| 修改 | `src/agent/AiSdkExecutor.test.ts` | +2 用例（lastApiInputTokens 透出 / 多 step 覆盖） |
| 修改 | `src/core/events.ts` | `SessionUsageInfo.lastApiInputTokens?: number` |
| 修改 | `src/orchestrator/SessionRunQueue.test.ts` | 不需要改，但 SessionRunQueue 行为不变（保留备查） |
| 修改 | `src/e2e/live/run-auto-compact.ts` | description 改为字符体积；新增 `willRetriggerNextTurn === false` 断言；用 fixture 替代 inline filler |
| 新建 | `src/e2e/live/run-compact-effectiveness.ts` | 核心 e2e：1M fixture → 触发 compact → 切片后 size 远小于 triggerThreshold |
| 新建 | `src/e2e/live/run-auto-compact-no-rework.ts` | compact 后下一轮小消息**不再触发** compact |
| 新建 | `src/e2e/live/run-auto-compact-breaker-open.ts` | 故意 invalid model 让 compact 连续失败 2 次 → 第三次触发 → 应跳过 |

不动：`SlackEventSink.ts` / `SlackAdapter.ts` / `SlackRenderer.ts` / `MemoryStore.ts` / `MentionCommandRouter.ts` / `selfImprove/*` / `tools/*` / 其他 e2e。

---

## 切片总览（每片独立可验证、可 ship）

| Chunk | 内容 | 出口（验证方式） |
|---|---|---|
| **0** | fixture + e2e 修订准备（不动主代码） | `tests/fixtures/compact/large-history-1m.jsonl` 生成 + `pnpm test` 全绿 |
| **1** | A2 过渡缓解：`COMPACT_INPUT_MAX_CHARS` 120K → 1M | 单测：构造 800K 输入不被截；`pnpm e2e auto-compact` 仍过 |
| **2** | A3 持久化层切断 + B3 严格正则 fallback | 单测：默认切片 / loadFullTranscript / id 强制 / 严格正则；`pnpm e2e compact-boundary` / `auto-compact` 仍过 |
| **3** | A2 三层处理：tool_result 占位 + 媒体剥离 + PTL retry | 单测：占位 / 剥图 / 砍头 / 配对不变量 / 异常分类 |
| **4** | §3.7.6.3 prompt 重写 + 容量 | 单测：prompt 含 9 章节 / format 函数处理 `<analysis>`；手动跑 compact 看 summary 质量 |
| **5** | C3 `events.jsonl` 埋点 + e2e 矩阵 | 单测：4 类事件 append；`pnpm e2e auto-compact / compact-effectiveness / auto-compact-no-rework / auto-compact-breaker-open` 全过 |
| **6** | A1 真实 `input_tokens` 触发 + meta 快照 | 单测：阈值计算 / meta 读写 / 首轮 fallback 字符；`pnpm e2e` 全套不退化 |

每 Chunk 独立 commit；下一 Chunk 不依赖未上线 Chunk 的功能（除 Chunk 5 的 e2e 矩阵会用到 Chunk 0 的 fixture + Chunk 2 的切片语义）。

---

## Chunk 0: fixture + e2e 修订准备

> **出口**：`tests/fixtures/compact/` 目录就绪、生成脚本可一次性产出确定性 fixture、`pnpm test` 全绿。不动主代码、不改主测试。

### Task 0.1：fixture 目录与 README

**Files:**
- 新建：`tests/fixtures/compact/README.md`

- [ ] **Step 1：创建 README，说明每个 fixture 用途与重新生成方式**

```markdown
# Compact E2E Fixtures

预生成的大尺寸历史样本，供 live e2e 在不依赖 LLM 真实生成的情况下测试 compact 行为。

## 文件清单

- `large-history-1m.jsonl` — ~1M chars 的真实尺度 history，包含 dense user/assistant/tool 配对。用于 `compact-effectiveness` / `auto-compact-no-rework` 等 e2e。

## 重新生成

```bash
pnpm tsx scripts/build-compact-fixture.ts
```

确定性种子（生成脚本内 hardcode），重复运行产出 byte-identical 输出，便于 git diff 审查。

## 注意事项

- 内容为伪英文 lorem ipsum 风格，不含敏感数据。
- 每条 message 都带 `id` 字段（randomUUID），符合 Chunk 2 落地后 SessionStore 的强制要求。
- tool_use / tool_result 严格配对，避免裁剪场景产生悬空 tool。
```

- [ ] **Step 2：commit**

```bash
git add tests/fixtures/compact/README.md
git commit -m "docs: add compact e2e fixtures README"
```

### Task 0.2：fixture 生成脚本

**Files:**
- 新建：`scripts/build-compact-fixture.ts`
- 新建：`tests/fixtures/compact/large-history-1m.jsonl`（脚本输出）

- [ ] **Step 1：写脚本骨架**

`scripts/build-compact-fixture.ts`：

```ts
import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// 确定性 PRNG（mulberry32），保证每次生成 byte-identical
function mulberry32(seed: number): () => number {
  let a = seed
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const SEED = 0x5a17c0
const TARGET_CHARS = 1_000_000
const FILE_TARGET = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'tests',
  'fixtures',
  'compact',
  'large-history-1m.jsonl',
)

const LOREM_WORDS = [
  'lorem','ipsum','dolor','sit','amet','consectetur','adipiscing','elit',
  'sed','do','eiusmod','tempor','incididunt','ut','labore','et','dolore',
  'magna','aliqua','enim','ad','minim','veniam','quis','nostrud','exercitation',
]

function randomWord(rng: () => number): string {
  return LOREM_WORDS[Math.floor(rng() * LOREM_WORDS.length)]!
}

function paragraph(rng: () => number, words: number): string {
  const out: string[] = []
  for (let i = 0; i < words; i++) out.push(randomWord(rng))
  return out.join(' ')
}

function uuid(rng: () => number): string {
  // 确定性 UUID（非真随机；基于 mulberry32），格式合规
  const hex = (n: number) =>
    Math.floor(rng() * 16 ** n)
      .toString(16)
      .padStart(n, '0')
  return `${hex(8)}-${hex(4)}-4${hex(3)}-${hex(4)}-${hex(12)}`
}

interface CoreMsg {
  id: string
  role: 'user' | 'assistant' | 'tool'
  content: string | unknown[]
}

function userMsg(rng: () => number): CoreMsg {
  return {
    id: uuid(rng),
    role: 'user',
    content: paragraph(rng, 80 + Math.floor(rng() * 40)),
  }
}

function assistantTextMsg(rng: () => number): CoreMsg {
  return {
    id: uuid(rng),
    role: 'assistant',
    content: paragraph(rng, 100 + Math.floor(rng() * 60)),
  }
}

function assistantWithToolCallMsg(
  rng: () => number,
  toolCallId: string,
): CoreMsg {
  return {
    id: uuid(rng),
    role: 'assistant',
    content: [
      { type: 'text', text: paragraph(rng, 30) },
      {
        type: 'tool-call',
        toolCallId,
        toolName: 'bash',
        input: { command: `echo ${paragraph(rng, 5)}` },
      },
    ],
  }
}

function toolResultMsg(
  rng: () => number,
  toolCallId: string,
  largeOutput = false,
): CoreMsg {
  const result = largeOutput
    ? paragraph(rng, 1500 + Math.floor(rng() * 500))
    : paragraph(rng, 100 + Math.floor(rng() * 50))
  return {
    id: uuid(rng),
    role: 'tool',
    content: [{ type: 'tool-result', toolCallId, result }],
  }
}

async function main(): Promise<void> {
  const rng = mulberry32(SEED)
  const lines: string[] = []
  let totalChars = 0
  let toolCallSeq = 0

  while (totalChars < TARGET_CHARS) {
    // 模式：user → (assistant_text | assistant_with_tool → tool_result)
    lines.push(JSON.stringify(userMsg(rng)))
    if (rng() < 0.6) {
      // 60% 概率走 tool 配对
      const tcid = `tc_${toolCallSeq++}`
      lines.push(JSON.stringify(assistantWithToolCallMsg(rng, tcid)))
      lines.push(JSON.stringify(toolResultMsg(rng, tcid, rng() < 0.1)))
      // 10% 概率产出"大 tool_result"（~10K chars），模拟真实场景
    } else {
      lines.push(JSON.stringify(assistantTextMsg(rng)))
    }
    totalChars = lines.reduce((s, l) => s + l.length + 1, 0)
  }

  await writeFile(FILE_TARGET, lines.join('\n') + '\n', 'utf8')
  console.log(`Generated ${lines.length} lines, ${totalChars} chars → ${FILE_TARGET}`)
}

await main()
```

- [ ] **Step 2：运行脚本生成 fixture**

```bash
pnpm tsx scripts/build-compact-fixture.ts
```

预期输出：`Generated <N> lines, <~1000000+> chars → tests/fixtures/compact/large-history-1m.jsonl`

- [ ] **Step 3：验证 fixture 内容确定性**

```bash
# 重跑一次确认 byte-identical
SHA1=$(shasum tests/fixtures/compact/large-history-1m.jsonl | cut -d' ' -f1)
pnpm tsx scripts/build-compact-fixture.ts
SHA2=$(shasum tests/fixtures/compact/large-history-1m.jsonl | cut -d' ' -f1)
test "$SHA1" = "$SHA2" && echo OK || echo MISMATCH
```

预期输出：`OK`

- [ ] **Step 4：跑全测试套件确认无影响**

```bash
pnpm test
```

预期：332 全过。

- [ ] **Step 5：commit**

```bash
git add scripts/build-compact-fixture.ts tests/fixtures/compact/
git commit -m "feat(compact): add deterministic 1m-char history fixture for e2e"
```

---

## Chunk 1: A2 过渡缓解（COMPACT_INPUT_MAX_CHARS 120K → 1M）

> **出口**：`COMPACT_INPUT_MAX_CHARS = 1_000_000`，超长 history 不再"前 600K 静默丢失"；现有 `auto-compact` e2e 仍过。

### Task 1.1：放宽 `COMPACT_INPUT_MAX_CHARS`

**Files:**
- Modify: `src/agents/compact/prompts.ts:14`

- [ ] **Step 1：写失败测试——验证 800K 输入完整传递**

`src/agents/compact/prompts.test.ts`（如不存在则新建）：

```ts
import { describe, it, expect } from 'vitest'
import { buildCompactPrompt } from './prompts.ts'
import type { CoreMessage } from 'ai'

describe('buildCompactPrompt', () => {
  it('does not truncate input below 1M chars (transition mitigation)', () => {
    // 构造 800K chars 的 user message
    const bigContent = 'x'.repeat(800_000)
    const messages: CoreMessage[] = [
      { role: 'user', content: bigContent },
      { role: 'assistant', content: 'ok' },
    ]
    const prompt = buildCompactPrompt({ messages })
    // 关键断言：完整 800K 内容应出现在 prompt 中
    expect(prompt).toContain(bigContent)
    expect(prompt).not.toContain('注意：由于 compact 输入过长')
  })
})
```

- [ ] **Step 2：跑测试，预期失败**

```bash
pnpm vitest run src/agents/compact/prompts.test.ts -t "does not truncate"
```

预期：FAIL（当前 `COMPACT_INPUT_MAX_CHARS = 120_000`，800K 会被截 + 出现 "注意" 文本）

- [ ] **Step 3：调整常量**

`src/agents/compact/prompts.ts:14`：

```ts
const COMPACT_INPUT_MAX_CHARS = 120_000
```

改为：

```ts
// 过渡缓解：与 maxApproxChars 默认值（1M）同量级，避免"前 N K 静默丢失"。
// TODO(Chunk 3)：删除该硬截，改用三层处理（tool_result 占位 + 剥图 + PTL retry）。
const COMPACT_INPUT_MAX_CHARS = 1_000_000
```

- [ ] **Step 4：跑测试，预期通过**

```bash
pnpm vitest run src/agents/compact/prompts.test.ts
```

预期：PASS。

- [ ] **Step 5：跑全套测试**

```bash
pnpm test
```

预期：333 通过（新增 1 个）。

- [ ] **Step 6：commit**

```bash
git add src/agents/compact/prompts.ts src/agents/compact/prompts.test.ts
git commit -m "fix(compact): widen COMPACT_INPUT_MAX_CHARS 120K→1M (transition)"
```

---

## Chunk 2: A3 持久化层切断 + B3 严格正则 fallback

> **出口**：`SessionStore.loadMessages` 默认从最后一个 compact boundary 之后切片返回；`loadFullTranscript` 取完整 jsonl；`appendMessage` 强制 id；fallback 前缀严格匹配 `/^\[compact: (manual|auto)\]\n/`。`buildModelMessages` 删除 `splitHistoryAtLastCompact`，`buildCompactCandidateMessages` 函数移除（candidate 退役）。`compact-boundary` / `auto-compact` e2e 全过。

### Task 2.1：`SessionStore.appendMessage` 强制 id

**Files:**
- Modify: `src/store/SessionStore.ts:188`
- Modify: `src/store/SessionStore.test.ts`

- [ ] **Step 1：写失败测试**

`src/store/SessionStore.test.ts` 新增：

```ts
it('appendMessage assigns id when missing', async () => {
  const store = createSessionStore(paths)
  const session = await store.getOrCreate(args)
  // 故意不带 id
  await store.appendMessage(session.id, { role: 'user', content: 'hello' } as CoreMessage)
  const messages = await store.loadFullTranscript(session.id)
  expect(messages[0]).toMatchObject({ role: 'user', content: 'hello' })
  expect((messages[0] as { id?: string }).id).toMatch(/^[0-9a-f-]{36}$/)
})
```

- [ ] **Step 2：跑测试，预期失败**

```bash
pnpm vitest run src/store/SessionStore.test.ts -t "appendMessage assigns id"
```

预期：FAIL（当前没强制 id，且 `loadFullTranscript` 不存在）

- [ ] **Step 3：实现**

`src/store/SessionStore.ts:188`：

```ts
async appendMessage(id, msg) {
  await appendFile(path.join(resolveDir(id), 'messages.jsonl'), JSON.stringify(msg) + '\n')
},
```

改为：

```ts
async appendMessage(id, msg) {
  // 强制 id：边界识别（compact.jsonl.messageId）依赖此字段稳定存在
  const withId = 'id' in msg && typeof msg.id === 'string'
    ? msg
    : { ...msg, id: randomUUID() }
  await appendFile(
    path.join(resolveDir(id), 'messages.jsonl'),
    JSON.stringify(withId) + '\n',
  )
},
```

并在文件顶部确保 `import { randomUUID } from 'node:crypto'`。

- [ ] **Step 4：跑测试**

```bash
pnpm vitest run src/store/SessionStore.test.ts
```

预期：之前 FAIL 的用例 PASS（`loadFullTranscript` 还没实现，下一 Task 处理）。

- [ ] **Step 5：commit**

```bash
git add src/store/SessionStore.ts src/store/SessionStore.test.ts
git commit -m "feat(store): force message id on appendMessage"
```

### Task 2.2：新增 `loadFullTranscript` + `loadMessages` 默认切片

**Files:**
- Modify: `src/store/SessionStore.ts`
- Modify: `src/store/SessionStore.test.ts`

- [ ] **Step 1：扩接口 + 写失败测试**

接口扩展 `src/store/SessionStore.ts`：

```ts
export interface SessionStore {
  // ... 既有方法
  /** 默认行为变更（A3 重构）：返回最后一个 compact boundary 之后（含 boundary）的消息。 */
  loadMessages(id: string): Promise<CoreMessage[]>
  /** 完整 jsonl，供审计 / dashboard / 数据导出。 */
  loadFullTranscript(id: string): Promise<CoreMessage[]>
}
```

`src/store/SessionStore.test.ts` 加用例：

```ts
describe('loadMessages slicing semantics', () => {
  it('returns from last compact boundary onward when compact.jsonl has matching id', async () => {
    const store = createSessionStore(paths)
    const session = await store.getOrCreate(args)

    await store.appendMessage(session.id, { role: 'user', content: 'pre-1' })
    await store.appendMessage(session.id, { role: 'assistant', content: 'pre-2' })
    const summaryId = randomUUID()
    await store.appendMessage(session.id, {
      id: summaryId,
      role: 'assistant',
      content: '[compact: auto]\nsummary body',
    } as CoreMessage)
    await store.appendCompactRecord(session.id, {
      schemaVersion: 1,
      messageId: summaryId,
      mode: 'auto',
      createdAt: new Date().toISOString(),
    })
    await store.appendMessage(session.id, { role: 'user', content: 'post-1' })

    const sliced = await store.loadMessages(session.id)
    expect(sliced).toHaveLength(2)
    expect(sliced[0]).toMatchObject({ id: summaryId })
    expect(sliced[1]).toMatchObject({ role: 'user', content: 'post-1' })

    const full = await store.loadFullTranscript(session.id)
    expect(full).toHaveLength(4)
  })

  it('falls back to strict regex when compact.jsonl missing', async () => {
    const store = createSessionStore(paths)
    const session = await store.getOrCreate(args)
    await store.appendMessage(session.id, { role: 'user', content: 'pre-1' })
    await store.appendMessage(session.id, {
      role: 'assistant',
      content: '[compact: manual]\nlegacy summary',
    })
    await store.appendMessage(session.id, { role: 'user', content: 'post-1' })

    // 不写 compact.jsonl，模拟旧 session
    const sliced = await store.loadMessages(session.id)
    expect(sliced).toHaveLength(2)
    expect(sliced[0]?.content).toContain('[compact: manual]')
  })

  it('does NOT match loose [compact: prefix in narrative', async () => {
    const store = createSessionStore(paths)
    const session = await store.getOrCreate(args)
    await store.appendMessage(session.id, { role: 'user', content: 'pre-1' })
    // 假阳性场景：assistant 在散文里用 "[compact:..."
    await store.appendMessage(session.id, {
      role: 'assistant',
      content: '[compact: 这次任务的核心是...] 接下来我会...',
    })
    await store.appendMessage(session.id, { role: 'user', content: 'post-1' })

    const sliced = await store.loadMessages(session.id)
    // 严格正则不识别此种文学化用法 → 返回全量
    expect(sliced).toHaveLength(3)
  })

  it('returns full when no boundary at all', async () => {
    const store = createSessionStore(paths)
    const session = await store.getOrCreate(args)
    await store.appendMessage(session.id, { role: 'user', content: 'a' })
    await store.appendMessage(session.id, { role: 'assistant', content: 'b' })
    const sliced = await store.loadMessages(session.id)
    expect(sliced).toHaveLength(2)
  })
})
```

- [ ] **Step 2：跑测试，预期失败**

```bash
pnpm vitest run src/store/SessionStore.test.ts -t "loadMessages slicing"
```

预期：FAIL（行为未实现）

- [ ] **Step 3：实现切片 + loadFullTranscript**

`src/store/SessionStore.ts` 内：

```ts
const COMPACT_BOUNDARY_REGEX = /^\[compact: (manual|auto)\]\n/

function findBoundaryIndex(
  messages: CoreMessage[],
  compactMessageIds: Set<string>,
): number {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i]!
    const id = 'id' in message && typeof message.id === 'string' ? message.id : undefined
    if (id && compactMessageIds.has(id)) {
      return i
    }
    if (
      message.role === 'assistant' &&
      typeof message.content === 'string' &&
      COMPACT_BOUNDARY_REGEX.test(message.content)
    ) {
      return i
    }
  }
  return -1
}
```

并替换原 `loadMessages` 实现：

```ts
async loadFullTranscript(id) {
  const raw = await readFile(path.join(resolveDir(id), 'messages.jsonl'), 'utf8')
  return raw
    .split('\n')
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as CoreMessage)
},

async loadMessages(id) {
  const all = await this.loadFullTranscript(id)
  const records = await this.loadCompactRecords(id)
  const compactIds = new Set(records.map((r) => r.messageId))
  const boundaryIdx = findBoundaryIndex(all, compactIds)
  return boundaryIdx === -1 ? all : all.slice(boundaryIdx)
},
```

注意：`this.loadFullTranscript` 与 `this.loadCompactRecords` 在 closure 内访问需用 `loadFullTranscript(id)` 形式调用同对象方法（提取为局部 const 后引用）。具体写法见已有 SessionStore 内 `getMeta` 等方法的模式。

- [ ] **Step 4：跑测试**

```bash
pnpm vitest run src/store/SessionStore.test.ts
```

预期：全部 PASS。

- [ ] **Step 5：commit**

```bash
git add src/store/SessionStore.ts src/store/SessionStore.test.ts
git commit -m "feat(store): loadMessages defaults to compact-boundary slicing; add loadFullTranscript"
```

### Task 2.3：删除 `buildCompactCandidateMessages` + `splitHistoryAtLastCompact`

**Files:**
- Modify: `src/orchestrator/modelMessages.ts`
- Modify: `src/orchestrator/modelMessages.test.ts`
- Modify: `src/orchestrator/ConversationOrchestrator.ts`

- [ ] **Step 1：删除函数**

`src/orchestrator/modelMessages.ts` 移除：
- `splitHistoryAtLastCompact`
- `buildCompactCandidateMessages`
- `isCompactSummaryMessage`
- 相关 `compactMessageIds` 参数

简化 `BuildModelMessagesArgs`：

```ts
export interface BuildModelMessagesArgs {
  history: CoreMessage[]      // 现在等于 SessionStore.loadMessages 的切片输出
  userMessage: CoreMessage
  budget: ModelMessageBudget
  messagesJsonlPath: string
}
```

`buildModelMessages` 内部去掉所有 `splitHistoryAtLastCompact` 调用，直接对 `history` 做预算裁剪 + tool-pair 保护 + tool_result 占位。

- [ ] **Step 2：更新 modelMessages.test.ts**

删除所有"含 boundary 切片"相关用例（这些用例描述的行为已经下沉到 SessionStore 单测）。保留：预算裁剪 / tool-pair 保护 / tool_result 占位。

- [ ] **Step 3：更新 ConversationOrchestrator.ts**

[ConversationOrchestrator.ts:217-221](../../../src/orchestrator/ConversationOrchestrator.ts:217)：

```ts
const candidateMessages = buildCompactCandidateMessages({
  compactMessageIds: compactMessageIds(compactRecords),
  history,
  userMessage: userMsg,
})
```

改为：

```ts
// loadMessages 已切片到最后一个 boundary 之后，candidate = [...history, userMsg]
const candidateMessages: CoreMessage[] = [...history, userMsg]
```

并删除 `compactMessageIds` 局部 helper 与对应 import。

[ConversationOrchestrator.ts:184-185](../../../src/orchestrator/ConversationOrchestrator.ts:184) 的 `compactRecords` 加载也可以删——切片由 SessionStore 内部完成，编排层不再需要 records。

- [ ] **Step 4：跑测试**

```bash
pnpm test
```

预期：全套 PASS（切片用例下沉到 SessionStore 单测后，模型层用例数减少但断言更聚焦）。

- [ ] **Step 5：commit**

```bash
git add src/orchestrator/
git commit -m "refactor(compact): retire candidate concept; load slice flows from SessionStore"
```

### Task 2.4：`ContextCompactor.manualCompact` 改用切片输入

**Files:**
- Modify: `src/orchestrator/ContextCompactor.ts`
- Modify: `src/orchestrator/ContextCompactor.test.ts`

- [ ] **Step 1：调整 manualCompact**

[ContextCompactor.ts:69-105](../../../src/orchestrator/ContextCompactor.ts:69) 当前接受 `args.history`（完整历史），过滤 `[compact:` 前缀的 message：

```ts
const compactableMessages = args.history.filter(
  (message) =>
    !(
      message.role === 'assistant' &&
      typeof message.content === 'string' &&
      message.content.startsWith('[compact:')
    ),
)
```

由于 `loadMessages` 已切片，调用方传进来的 `args.history` 不再包含旧 boundary 之前的内容。`filter` 仍可保留（对当前 boundary 自身去重——重复压同一 boundary 没意义），但简化为：

```ts
// 切片版 history 只可能在头部含 boundary message（含其本身）
// manualCompact 不重复压同一 boundary
const compactableMessages = args.history.filter(
  (message) =>
    !(
      message.role === 'assistant' &&
      typeof message.content === 'string' &&
      /^\[compact: (manual|auto)\]\n/.test(message.content)
    ),
)
```

- [ ] **Step 2：测试与上一 Task 用例汇合**

跑 `pnpm test` 全过即可（既有 ContextCompactor.test 不变，因为 history 入参语义改变但行为输出不变）。

- [ ] **Step 3：commit**

```bash
git add src/orchestrator/ContextCompactor.ts
git commit -m "refactor(compact): manualCompact consumes sliced history; filter uses strict regex"
```

### Task 2.5：跑现有 e2e 验证回归

- [ ] **Step 1：跑 unit + e2e**

```bash
pnpm test
pnpm e2e auto-compact
pnpm e2e compact-boundary
pnpm e2e compact-command
pnpm e2e context-pruning-no-llm
```

预期：全部 PASS。`auto-compact` 仍能在 1K maxApproxChars 触发；`compact-boundary` 验证手动 compact 后边界正确切片。

- [ ] **Step 2：如有 e2e 失败，定位是 SessionStore 行为变更导致还是测试断言过严**

常见失败模式：
- e2e 断言 jsonl 全量大小——已验证当前 e2e 用 `readSessionMessages` 仅读取，不直接断言 size
- e2e 用 `loadMessages` 取历史断言——切片后只看到 boundary 后内容，可能漏断言；如需断言全部历史，改用 `loadFullTranscript`

修复后再跑直到全过。

- [ ] **Step 3：Chunk 2 收口**

整个 Chunk 2 共 4 个 commit；如需回滚整片，`git revert` 这 4 个 commit 即可恢复"loadMessages 全量"的旧行为。

---

## Chunk 3: A2 三层处理（tool_result 占位 + 媒体剥离 + PTL retry）

> **出口**：compact 输入路径在 `ContextCompactor` 入口完成 (1) tool_result 占位 (2) 媒体剥离；compact 调用命中 `prompt_too_long` 时按 API round 砍头重试，上限 3 次，PTL 失败不计入熔断。删除 `COMPACT_INPUT_MAX_CHARS` 硬截。

### Task 3.1：`groupMessagesByApiRound` 纯函数

**Files:**
- 新建：`src/agents/compact/groupMessagesByApiRound.ts`
- 新建：`src/agents/compact/groupMessagesByApiRound.test.ts`

- [ ] **Step 1：写失败测试（按 free-code grouping.ts 语义）**

```ts
import { describe, it, expect } from 'vitest'
import type { CoreMessage } from 'ai'
import { groupMessagesByApiRound } from './groupMessagesByApiRound.ts'

describe('groupMessagesByApiRound', () => {
  it('groups by user message boundary', () => {
    const msgs: CoreMessage[] = [
      { role: 'user', content: 'q1' },
      { role: 'assistant', content: 'a1' },
      { role: 'user', content: 'q2' },
      { role: 'assistant', content: 'a2' },
    ]
    const groups = groupMessagesByApiRound(msgs)
    expect(groups).toHaveLength(2)
    expect(groups[0]).toHaveLength(2)
    expect(groups[1]).toHaveLength(2)
  })

  it('keeps tool_use+tool_result in same group', () => {
    const msgs: CoreMessage[] = [
      { role: 'user', content: 'q1' },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'thinking' },
          { type: 'tool-call', toolCallId: 't1', toolName: 'bash', input: {} },
        ],
      },
      { role: 'tool', content: [{ type: 'tool-result', toolCallId: 't1', result: 'ok' }] },
      { role: 'assistant', content: 'final' },
      { role: 'user', content: 'q2' },
    ]
    const groups = groupMessagesByApiRound(msgs)
    expect(groups).toHaveLength(2)
    expect(groups[0]).toHaveLength(4)  // q1 + assistant_with_tool + tool_result + assistant_final
  })

  it('returns single group for empty user pivots', () => {
    const msgs: CoreMessage[] = [
      { role: 'assistant', content: 'standalone' },
    ]
    expect(groupMessagesByApiRound(msgs)).toEqual([msgs])
  })
})
```

- [ ] **Step 2：实现**

`src/agents/compact/groupMessagesByApiRound.ts`：

```ts
import type { CoreMessage } from 'ai'

/**
 * 按 API round 切分：每个 user message 是一组的起点。
 * 这是 PTL retry 砍头的最小单元——保证 tool_use/tool_result 配对完整。
 *
 * 参考 free-code services/compact/grouping.ts；agent-slack 这边 message 没有
 * `id` 共享语义（每条 assistant message 独立 id），所以用 user role 作为分组锚。
 */
export function groupMessagesByApiRound(messages: CoreMessage[]): CoreMessage[][] {
  const groups: CoreMessage[][] = []
  let current: CoreMessage[] = []

  for (const msg of messages) {
    if (msg.role === 'user' && current.length > 0) {
      groups.push(current)
      current = [msg]
    } else {
      current.push(msg)
    }
  }
  if (current.length > 0) groups.push(current)
  return groups
}
```

- [ ] **Step 3：跑测试**

```bash
pnpm vitest run src/agents/compact/groupMessagesByApiRound.test.ts
```

预期：PASS。

- [ ] **Step 4：commit**

```bash
git add src/agents/compact/groupMessagesByApiRound.ts src/agents/compact/groupMessagesByApiRound.test.ts
git commit -m "feat(compact): add groupMessagesByApiRound pure function"
```

### Task 3.2：`stripImagesFromMessages` 纯函数

**Files:**
- 新建：`src/agents/compact/stripImagesFromMessages.ts`
- 新建：`src/agents/compact/stripImagesFromMessages.test.ts`

- [ ] **Step 1：写失败测试**

```ts
import { describe, it, expect } from 'vitest'
import type { CoreMessage } from 'ai'
import { stripImagesFromMessages } from './stripImagesFromMessages.ts'

describe('stripImagesFromMessages', () => {
  it('replaces image block in user content', () => {
    const msgs: CoreMessage[] = [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'check this' },
          { type: 'image', image: 'base64data' },
        ],
      },
    ]
    const out = stripImagesFromMessages(msgs)
    expect(out[0]?.content).toEqual([
      { type: 'text', text: 'check this' },
      { type: 'text', text: '[image]' },
    ])
  })

  it('replaces image inside tool_result content', () => {
    const msgs: CoreMessage[] = [
      {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: 't1',
            result: [
              { type: 'text', text: 'output' },
              { type: 'image', image: 'data' },
            ],
          },
        ],
      },
    ]
    const out = stripImagesFromMessages(msgs)
    const result = (out[0]?.content as Array<{ type: string; result: unknown }>)[0]?.result as Array<unknown>
    expect(result).toEqual([
      { type: 'text', text: 'output' },
      { type: 'text', text: '[image]' },
    ])
  })

  it('passes through messages without media unchanged', () => {
    const msgs: CoreMessage[] = [{ role: 'user', content: 'plain text' }]
    expect(stripImagesFromMessages(msgs)).toEqual(msgs)
  })
})
```

- [ ] **Step 2：实现**

`src/agents/compact/stripImagesFromMessages.ts`：

```ts
import type { CoreMessage } from 'ai'

/**
 * 把 user message 与 tool_result 中的 image / document block 替换为占位文字。
 * 图片/文档对生成摘要无价值，但容易让 compact 调用炸窗口。
 *
 * 参考 free-code services/compact/compact.ts:stripImagesFromMessages（145-200）。
 */
export function stripImagesFromMessages(messages: CoreMessage[]): CoreMessage[] {
  return messages.map((msg) => {
    if (msg.role !== 'user' && msg.role !== 'tool') return msg
    if (!Array.isArray(msg.content)) return msg

    const newContent = msg.content.map((block) => {
      if (block.type === 'image') {
        return { type: 'text' as const, text: '[image]' }
      }
      if (block.type === 'file') {
        return { type: 'text' as const, text: '[document]' }
      }
      if (block.type === 'tool-result' && Array.isArray(block.result)) {
        const newResult = block.result.map((item: { type?: string }) => {
          if (item.type === 'image') return { type: 'text', text: '[image]' }
          if (item.type === 'file') return { type: 'text', text: '[document]' }
          return item
        })
        return { ...block, result: newResult }
      }
      return block
    })

    return { ...msg, content: newContent } as CoreMessage
  })
}
```

注：`CoreMessage` 类型由 `ai` 包导出，具体 block 子类型需根据 ai-sdk v4 版本对齐；运行时 strip 策略不依赖类型严格性。

- [ ] **Step 3：跑测试**

```bash
pnpm vitest run src/agents/compact/stripImagesFromMessages.test.ts
```

预期：PASS。

- [ ] **Step 4：commit**

```bash
git add src/agents/compact/stripImagesFromMessages.ts src/agents/compact/stripImagesFromMessages.test.ts
git commit -m "feat(compact): add stripImagesFromMessages pure function"
```

### Task 3.3：`ContextCompactor` 入口集成 占位 + 剥图

**Files:**
- Modify: `src/orchestrator/ContextCompactor.ts`
- Modify: `src/orchestrator/ContextCompactor.test.ts`

- [ ] **Step 1：写失败测试**

```ts
it('preprocesses input: strips images and places tool_result placeholders', async () => {
  const compactAgent = {
    summarize: vi.fn(async ({ messages }) => {
      // 关键断言：compact agent 收到的 messages 已经被预处理
      const flat = JSON.stringify(messages)
      expect(flat).not.toContain('base64data')   // image stripped
      expect(flat).toContain('[image]')
      expect(flat).toContain('[旧工具结果已压缩')  // tool_result 占位
      return { summary: 'mock summary', usage: { inputTokens: 100, outputTokens: 50, cachedInputTokens: 0 } }
    }),
  }
  const compactor = createContextCompactor({ compactAgent, logger: stubLogger() })

  // 25 条 tool_result（超过 keepRecentToolResults=20 触发占位）+ 1 条带 image
  const messages: CoreMessage[] = [
    { role: 'user', content: [{ type: 'image', image: 'base64data' }] },
    ...Array.from({ length: 25 }, (_, i) => [
      { role: 'assistant' as const, content: [{ type: 'tool-call', toolCallId: `t${i}`, toolName: 'bash', input: {} }] },
      { role: 'tool' as const, content: [{ type: 'tool-result', toolCallId: `t${i}`, result: `output ${i}` }] },
    ]).flat(),
  ]

  await compactor.autoCompact({ session: stubSession, messages, trigger: 'budget' })
  expect(compactAgent.summarize).toHaveBeenCalledOnce()
})
```

- [ ] **Step 2：跑测试，预期失败**

```bash
pnpm vitest run src/orchestrator/ContextCompactor.test.ts -t "preprocesses input"
```

预期：FAIL（当前 compactor 直接传 raw messages）

- [ ] **Step 3：实现入口预处理**

`src/orchestrator/ContextCompactor.ts` 入口加：

```ts
import { stripImagesFromMessages } from '@/agents/compact/stripImagesFromMessages.ts'
import { compactOldToolResults } from '@/orchestrator/modelMessages.ts'  // 新 export

function preprocessForCompact(
  messages: CoreMessage[],
  keepRecentToolResults: number,
  messagesJsonlPath: string,
): CoreMessage[] {
  // 第 1 层：tool_result 占位（复用模型视图层同款函数）
  const placeheld = compactOldToolResults(
    messages,
    keepRecentToolResults,
    messagesJsonlPath,
  )
  // 第 2 层：媒体剥离
  return stripImagesFromMessages(placeheld)
}
```

`autoCompact` / `manualCompact` 内首处 summarize 调用前加：

```ts
const preprocessed = preprocessForCompact(
  args.messages,
  deps.keepRecentToolResults ?? 20,
  args.messagesJsonlPath,
)
const result = await deps.compactAgent.summarize({ messages: preprocessed })
```

需要给 `ContextCompactorDeps` 加 `keepRecentToolResults: number`，并在 `createContextCompactor` 调用方注入；同时 `ManualCompactArgs` / `AutoCompactArgs` 加 `messagesJsonlPath: string`。

调用方（`ConversationOrchestrator`）传入 `path.join(session.dir, 'messages.jsonl')` + `workspace.config.agent.context.keepRecentToolResults`。

需要把 `compactOldToolResults` 从 `modelMessages.ts` 改为 export（[modelMessages.ts:197](../../../src/orchestrator/modelMessages.ts:197)）。

- [ ] **Step 4：跑测试**

```bash
pnpm test
```

预期：所有用例 PASS（注意 mock compact agent 返回值结构变更，需要把 `summarize` 返回从 `string` 改为 `{ summary, usage }`——这部分留给 Task 3.4 一起处理；本 Task 暂保持 `summarize` 返回 string 但接受 `{ messages }` 输入预处理）

- [ ] **Step 5：commit**

```bash
git add src/orchestrator/ContextCompactor.ts src/orchestrator/ContextCompactor.test.ts src/orchestrator/modelMessages.ts
git commit -m "feat(compact): preprocess input with tool_result placeholder + image strip"
```

### Task 3.4：PTL retry 循环 + 异常分类

**Files:**
- Modify: `src/agents/compact/compactAgent.ts`
- Modify: `src/agents/compact/types.ts`
- Modify: `src/orchestrator/ContextCompactor.ts`
- Modify: `src/orchestrator/ContextCompactor.test.ts`
- Modify: `src/agents/compact/prompts.ts`

- [ ] **Step 1：扩 `CompactAgent` 返回类型**

`src/agents/compact/types.ts`：

```ts
export interface CompactAgentInput {
  messages: CoreMessage[]
  signal?: AbortSignal
  maxOutputTokens?: number
}

export interface CompactAgentOutput {
  summary: string
  usage: {
    inputTokens: number
    outputTokens: number
    cachedInputTokens: number
  }
}

export interface CompactAgent {
  summarize(input: CompactAgentInput): Promise<CompactAgentOutput>
}
```

`src/agents/compact/compactAgent.ts` 返回值适配：

```ts
async summarize(input) {
  const result = await generateText({
    model: deps.model,
    system: COMPACT_SYSTEM_PROMPT,
    prompt: buildCompactPrompt(input),
    maxOutputTokens: input.maxOutputTokens ?? 20_000,  // §3.7.6.3 对齐 free-code
    abortSignal: input.signal,
  })
  return {
    summary: result.text.trim(),
    usage: {
      inputTokens: result.usage.promptTokens ?? 0,
      outputTokens: result.usage.completionTokens ?? 0,
      cachedInputTokens: 0,  // generateText 当前不暴露 cache token；Chunk 6 接入真实值
    },
  }
}
```

- [ ] **Step 2：写失败测试——PTL retry**

```ts
it('retries with truncated rounds on prompt_too_long', async () => {
  let attempts = 0
  const compactAgent = {
    summarize: vi.fn(async ({ messages }) => {
      attempts += 1
      if (attempts <= 2) {
        const err = new Error('prompt is too long')
        ;(err as { name: string }).name = 'PROMPT_TOO_LONG'
        throw err
      }
      return { summary: 'final', usage: { inputTokens: 100, outputTokens: 50, cachedInputTokens: 0 } }
    }),
  }
  const compactor = createContextCompactor({
    compactAgent,
    logger: stubLogger(),
    keepRecentToolResults: 20,
  })

  // 至少 4 个 user message，便于砍头
  const messages: CoreMessage[] = Array.from({ length: 8 }, (_, i) =>
    i % 2 === 0
      ? { role: 'user' as const, content: `q${i}` }
      : { role: 'assistant' as const, content: `a${i}` },
  )

  const result = await compactor.autoCompact({
    session: stubSession,
    messages,
    trigger: 'budget',
    messagesJsonlPath: '/tmp/x.jsonl',
  })

  expect(attempts).toBe(3)
  expect(result.status).toBe('compacted')
  expect(compactAgent.summarize).toHaveBeenCalledTimes(3)
})

it('throws prompt_too_long error after MAX_PTL_RETRIES exhausted', async () => {
  const compactAgent = {
    summarize: vi.fn(async () => {
      const err = new Error('prompt is too long')
      ;(err as { name: string }).name = 'PROMPT_TOO_LONG'
      throw err
    }),
  }
  const compactor = createContextCompactor({
    compactAgent,
    logger: stubLogger(),
    keepRecentToolResults: 20,
  })
  const messages: CoreMessage[] = Array.from({ length: 12 }, (_, i) =>
    i % 2 === 0
      ? { role: 'user' as const, content: `q${i}` }
      : { role: 'assistant' as const, content: `a${i}` },
  )

  await expect(
    compactor.autoCompact({
      session: stubSession,
      messages,
      trigger: 'budget',
      messagesJsonlPath: '/tmp/x.jsonl',
    }),
  ).rejects.toMatchObject({ name: 'PROMPT_TOO_LONG' })

  // 1 次 + 3 次 retry = 4 次
  expect(compactAgent.summarize).toHaveBeenCalledTimes(4)
})
```

- [ ] **Step 3：实现 PTL retry**

`ContextCompactor.ts` 增加：

```ts
const MAX_PTL_RETRIES = 3

function isPromptTooLongError(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  const name = (error as { name?: string }).name
  if (name === 'PROMPT_TOO_LONG') return true
  return /prompt.+too.+long/i.test(error.message)
}

async function summarizeWithPTLRetry(
  compactAgent: CompactAgent,
  messages: CoreMessage[],
  log: Logger,
): Promise<{ output: CompactAgentOutput; ptlRetryCount: number; ptlDroppedMessages: number }> {
  let attempts = 0
  let working = messages
  let totalDropped = 0

  for (;;) {
    try {
      const output = await compactAgent.summarize({ messages: working })
      return { output, ptlRetryCount: attempts, ptlDroppedMessages: totalDropped }
    } catch (error) {
      if (!isPromptTooLongError(error) || attempts >= MAX_PTL_RETRIES) {
        throw error
      }
      attempts += 1
      const groups = groupMessagesByApiRound(working)
      if (groups.length <= 1) {
        // 不能再砍——抛 PTL
        throw error
      }
      // 砍掉最旧的 1 个 group
      const dropped = groups.shift()!
      totalDropped += dropped.length
      working = groups.flat()
      log.warn('compact PTL retry: dropped oldest API round', {
        attempt: attempts,
        droppedMessages: dropped.length,
        totalDropped,
        remainingMessages: working.length,
      })
    }
  }
}
```

`autoCompact` / `manualCompact` 改用 `summarizeWithPTLRetry`，并在结果对象里多带 `ptlRetryCount` / `ptlDroppedMessages`（供 Chunk 5 事件埋点）。

- [ ] **Step 4：删除 `COMPACT_INPUT_MAX_CHARS` 硬截**

`src/agents/compact/prompts.ts`：

```ts
const COMPACT_INPUT_MAX_CHARS = 1_000_000

function serializeMessages(messages: CoreMessage[]): string {
  return messages.map((message) => JSON.stringify(message)).join('\n')
}

export function buildCompactPrompt(input: { messages: CoreMessage[] }): string {
  const serialized = serializeMessages(input.messages)
  const wasTruncated = serialized.length > COMPACT_INPUT_MAX_CHARS
  const visibleTranscript = wasTruncated
    ? serialized.slice(serialized.length - COMPACT_INPUT_MAX_CHARS)
    : serialized

  return `请压缩下面这段 agent-slack session 历史。
${wasTruncated ? '注意：由于 compact 输入过长...' : ''}
## 历史消息 JSONL
${visibleTranscript}
`
}
```

改为：

```ts
function serializeMessages(messages: CoreMessage[]): string {
  return messages.map((message) => JSON.stringify(message)).join('\n')
}

export function buildCompactPrompt(input: { messages: CoreMessage[] }): string {
  // 不预截输入：超长时由 PTL retry 循环按 API round 砍头处理（见 ContextCompactor）
  const visibleTranscript = serializeMessages(input.messages)

  return `请压缩下面这段 agent-slack session 历史。

## 历史消息 JSONL
${visibleTranscript}
`
}
```

并删除 `COMPACT_INPUT_MAX_CHARS` 常量与 Chunk 1 留下的 TODO 注释。

更新 Chunk 1 留下的 prompts.test.ts 用例——"does not truncate input below 1M chars" 仍应 pass（永不截）。补一个用例确认即使 2M chars 也不截：

```ts
it('never pre-truncates input regardless of size (PTL retry handles it)', () => {
  const huge = 'x'.repeat(2_000_000)
  const prompt = buildCompactPrompt({ messages: [{ role: 'user', content: huge }] })
  expect(prompt).toContain(huge)
})
```

- [ ] **Step 5：跑全套测试**

```bash
pnpm test
```

预期：全过。

- [ ] **Step 6：commit**

```bash
git add src/orchestrator/ContextCompactor.ts src/orchestrator/ContextCompactor.test.ts src/agents/compact/
git commit -m "feat(compact): PTL retry with API-round truncation; remove input hardcap"
```

---

## Chunk 4: §3.7.6.3 prompt 重写 + 容量

> **出口**：`COMPACT_SYSTEM_PROMPT` 重写为 9 章节双 block 中文版；`formatCompactSummary` 处理 `<analysis>` strip + `<summary>` 提取；`max_output_tokens = 20_000` 已在 Chunk 3 Task 3.4 加入；删除 `COMPACT_SUMMARY_MAX_CHARS` post-process trim。

### Task 4.1：重写 `COMPACT_SYSTEM_PROMPT`

**Files:**
- Modify: `src/agents/compact/prompts.ts`
- Modify: `src/agents/compact/prompts.test.ts`

- [ ] **Step 1：写失败测试——验证 prompt 含 9 章节关键词与双 block 结构**

```ts
import { COMPACT_SYSTEM_PROMPT } from './prompts.ts'

describe('COMPACT_SYSTEM_PROMPT', () => {
  it('contains 9 numbered sections', () => {
    for (const i of [1, 2, 3, 4, 5, 6, 7, 8, 9]) {
      expect(COMPACT_SYSTEM_PROMPT).toMatch(new RegExp(`^${i}\\.`, 'm'))
    }
  })

  it('requires <analysis> + <summary> dual blocks', () => {
    expect(COMPACT_SYSTEM_PROMPT).toContain('<analysis>')
    expect(COMPACT_SYSTEM_PROMPT).toContain('<summary>')
  })

  it('forbids tool calls (NO_TOOLS preamble + trailer)', () => {
    expect(COMPACT_SYSTEM_PROMPT).toMatch(/不要(调用|使用)工具/)
  })

  it('does not impose 8-bullet limit', () => {
    expect(COMPACT_SYSTEM_PROMPT).not.toContain('不超过 8 条')
    expect(COMPACT_SYSTEM_PROMPT).not.toContain('最多 8 条')
  })
})
```

- [ ] **Step 2：跑测试，预期失败**

```bash
pnpm vitest run src/agents/compact/prompts.test.ts -t "COMPACT_SYSTEM_PROMPT"
```

预期：FAIL（当前 prompt 不含双 block / 9 章节）

- [ ] **Step 3：重写 prompt**

`src/agents/compact/prompts.ts` 顶部 `COMPACT_SYSTEM_PROMPT` 替换为：

```ts
const NO_TOOLS_PREAMBLE = `重要：仅以**纯文本**回应，不要调用任何工具。

- 不要使用 bash、edit_file、save_memory 或任何其他工具。
- 你已经在上面的对话中拥有了所需的全部上下文。
- 工具调用会被拒绝，本次任务将失败。
- 你的全部回应必须是纯文本：先一个 <analysis> 块，再一个 <summary> 块。

`

const ANALYSIS_INSTRUCTION = `在给出最终摘要前，把分析过程写在 <analysis> 标签里组织你的思路，确保覆盖所有要点。分析时：

1. 按时序分析对话的每条消息和每个段落。对于每段务必识别：
   - 用户的明确请求与意图
   - 你应对该请求的方法
   - 关键决策、技术概念与代码模式
   - 具体细节，例如：
     - 文件名
     - 完整代码片段
     - 函数签名
     - 文件编辑
   - 你遇到的错误以及如何修复
   - 特别注意用户给予的反馈，尤其是用户要求你换种做法时
2. 复核技术准确性与完整性，逐一覆盖每个必要元素。`

const COMPACT_BODY = `你的任务是给目前为止的对话生成一份**详细**摘要，特别关注用户的明确请求和你之前的动作。
该摘要应充分捕捉技术细节、代码模式与架构决策，使后续工作可以无损地继续。

${ANALYSIS_INSTRUCTION}

你的摘要应包含以下章节：

1. 用户主诉与意图：详细描述用户全部明确请求与意图。
2. 关键技术概念：列出讨论过的所有重要技术概念、技术与框架。
3. 涉及文件与代码段：枚举被读取/修改/创建的具体文件与代码段。特别关注最近的消息，**verbatim 完整 snippet**，并附该文件被读/改的原因摘要。
4. 错误与修复：列出全部错误及修复方式。特别关注用户的反馈——如果用户告诉你换种做法，必须保留。
5. 问题解决记录：记录已解决的问题与正在排查的事项。
6. 全部用户消息（非工具结果）：列出 thread 内**全部**用户消息，**不省略**——便于后续回看用户反馈与意图变化。
7. 待办事项：列出用户明确要求的待办。
8. 当前进展：详细描述本次摘要请求前正在做的事，特别关注最近的用户和 assistant 消息。包含文件名与代码片段。
9. 下一步建议：列出与最近工作直接相关的下一步。务必：与用户最近的明确请求一致；如果上一任务已结束，仅在用户明确要求时列下一步；不要擅自展开切线请求或重启已完成的旧任务。如果有下一步，**verbatim 引用最近对话**说明你被卡在哪里，避免任务漂移。

输出结构示例：

<example>
<analysis>
[你的思考过程，确保所有要点完整准确覆盖]
</analysis>

<summary>
1. 用户主诉与意图：
   [详细描述]

2. 关键技术概念：
   - [概念 1]
   - [概念 2]
   - [...]

3. 涉及文件与代码段：
   - [文件名 1]
      - [该文件为何重要]
      - [所做改动摘要，如有]
      - [关键代码 snippet]
   - [文件名 2]
      - [关键代码 snippet]
   - [...]

4. 错误与修复：
    - [错误 1 详描]：
      - [如何修复]
      - [用户反馈，如有]
    - [...]

5. 问题解决记录：
   [已解决的问题与正在排查的事项]

6. 全部用户消息：
    - [详细的非工具结果用户消息]
    - [...]

7. 待办事项：
   - [任务 1]
   - [任务 2]
   - [...]

8. 当前进展：
   [当前工作的精确描述]

9. 下一步建议：
   [可选的下一步]

</summary>
</example>

请基于目前为止的对话给出你的摘要，遵循上述结构，确保精确与详尽。`

const NO_TOOLS_TRAILER = `

提醒：不要调用任何工具。仅以纯文本回应——一个 <analysis> 块，紧接一个 <summary> 块。工具调用会被拒绝，本次任务将失败。`

export const COMPACT_SYSTEM_PROMPT = NO_TOOLS_PREAMBLE + COMPACT_BODY + NO_TOOLS_TRAILER
```

- [ ] **Step 4：跑测试**

```bash
pnpm vitest run src/agents/compact/prompts.test.ts
```

预期：PASS。

- [ ] **Step 5：commit**

```bash
git add src/agents/compact/prompts.ts src/agents/compact/prompts.test.ts
git commit -m "feat(compact): rewrite system prompt with 9 sections + analysis/summary dual block"
```

### Task 4.2：`formatCompactSummary` 处理 `<analysis>` + `<summary>`

**Files:**
- Modify: `src/agents/compact/prompts.ts`
- Modify: `src/agents/compact/prompts.test.ts`

- [ ] **Step 1：写失败测试**

```ts
describe('formatCompactSummary', () => {
  it('strips <analysis> block', () => {
    const raw = `<analysis>thinking notes</analysis>\n<summary>1. real summary</summary>`
    const formatted = formatCompactSummary({ summary: raw })
    expect(formatted).not.toContain('thinking notes')
    expect(formatted).toContain('real summary')
  })

  it('extracts <summary> block content', () => {
    const raw = `<analysis>x</analysis>\n<summary>9 章节内容</summary>`
    const formatted = formatCompactSummary({ summary: raw })
    expect(formatted).toContain('9 章节内容')
  })

  it('prepends [compact: <mode>] header for jsonl persistence', () => {
    const formatted = formatCompactSummary({
      mode: 'auto',
      summary: '<summary>body</summary>',
    })
    expect(formatted).toMatch(/^\[compact: auto\]\n/)
  })

  it('handles missing tags gracefully', () => {
    const formatted = formatCompactSummary({ summary: 'plain text without tags' })
    expect(formatted).toContain('plain text without tags')
  })
})
```

- [ ] **Step 2：跑测试，预期失败**

```bash
pnpm vitest run src/agents/compact/prompts.test.ts -t "formatCompactSummary"
```

预期：FAIL（当前 format 函数仍按 1200 cap 截 + 没有 analysis/summary 处理）

- [ ] **Step 3：重写 formatCompactSummary**

`src/agents/compact/prompts.ts`：

```ts
export function formatCompactSummary(input: { mode?: 'auto' | 'manual'; summary: string }): string {
  const stripped = stripAnalysisAndExtractSummary(input.summary)
  const cleaned = stripped.trim() || '当前历史中没有需要保留的有效上下文。'
  return `[compact: ${input.mode ?? 'manual'}]\n${cleaned}`
}

function stripAnalysisAndExtractSummary(raw: string): string {
  // strip <analysis>...</analysis>
  let out = raw.replace(/<analysis>[\s\S]*?<\/analysis>/, '')
  // 提取 <summary>...</summary>
  const m = out.match(/<summary>([\s\S]*?)<\/summary>/)
  if (m) out = m[1] ?? out
  // 清理多余空行
  return out.replace(/\n\n+/g, '\n\n').trim()
}
```

并**删除** `COMPACT_SUMMARY_MAX_CHARS` 常量与 `compactSummaryText` 函数（包括 `isPathNoiseLine` / `isLowValueNoiseLine` 这些 noise 过滤——9 章节结构 prompt 已不会产出这种 noise，留着会误删合法内容）。

如有用例引用被删函数，移除。

- [ ] **Step 4：跑测试**

```bash
pnpm test
```

预期：全过。

- [ ] **Step 5：commit**

```bash
git add src/agents/compact/prompts.ts src/agents/compact/prompts.test.ts
git commit -m "feat(compact): formatCompactSummary handles <analysis>/<summary> tags; drop 1200 hardcap"
```

### Task 4.3：手动验证 summary 质量（dev 任务，非自动化）

> 该 Task 不写自动化测试——目的是**人工**评估 prompt 重写是否真带来质量提升。

- [ ] **Step 1：在 dev workspace 跑一次手动 compact**

```bash
pnpm dev
# Slack 中：先发几条带 tool 调用的消息，再 @bot compact
```

- [ ] **Step 2：检查 messages.jsonl 中最新的 [compact: manual] 内容**

人工 review 是否符合：
- 含 9 章节标题
- "涉及文件与代码段"含 verbatim snippet
- "全部用户消息"列出 thread 内全部用户消息
- "下一步建议"含 verbatim 引用
- 长度在 5K-30K chars 之间（视 input 大小）

如不符合，记录到 [`experience.md`](../../../experience.md) 待优化。

- [ ] **Step 3：commit dev 笔记（可选）**

如有调整建议或观察记录：

```bash
git add experience.md
git commit -m "docs(experience): record compact prompt quality observations"
```

---

## Chunk 5: C3 events.jsonl 埋点 + e2e 矩阵

> **出口**：4 类 compact 事件写入 `events.jsonl`；现有 `auto-compact` e2e 加 `willRetriggerNextTurn` 断言；新增 3 个 e2e（`compact-effectiveness` / `auto-compact-no-rework` / `auto-compact-breaker-open`）全过。

### Task 5.1：`SessionEvent` 扩展 + 埋点骨架

**Files:**
- Modify: `src/store/SessionStore.ts`
- Modify: `src/store/SessionStore.test.ts`
- Modify: `src/orchestrator/ContextCompactor.ts`
- Modify: `src/orchestrator/ConversationOrchestrator.ts`

- [ ] **Step 1：扩 `SessionEvent` union**

`src/store/SessionStore.ts`：

```ts
export type SessionEvent =
  | ConfirmActionEvent
  | CompactAttemptEvent
  | CompactSucceededEvent
  | CompactFailedEvent
  | CompactSkippedEvent

export interface CompactAttemptEvent {
  type: 'compact_attempt'
  timestamp: string
  mode: 'auto' | 'manual'
  trigger: 'budget' | 'mention_command'
  preCompactApproxChars: number
  preCompactMessageCount: number
}

export interface CompactSucceededEvent {
  type: 'compact_succeeded'
  timestamp: string
  mode: 'auto' | 'manual'
  preCompactApproxChars: number
  postCompactApproxChars: number
  willRetriggerNextTurn: boolean
  compactionDurationMs: number
  compactionUsage: {
    inputTokens: number
    outputTokens: number
    cachedInputTokens: number
  }
  ptlRetryCount?: number
  ptlDroppedMessages?: number
}

export interface CompactFailedEvent {
  type: 'compact_failed'
  timestamp: string
  mode: 'auto' | 'manual'
  reason: 'prompt_too_long' | 'network' | 'api_error' | 'no_summary' | 'unknown'
  countedAsFailure: boolean
  failureCount: number
  breakerOpened: boolean
  errorMessage: string
}

export interface CompactSkippedEvent {
  type: 'compact_skipped'
  timestamp: string
  mode: 'auto' | 'manual'
  reason: 'enabled_false' | 'too_few_messages' | 'below_threshold' | 'breaker_open'
}
```

- [ ] **Step 2：写失败测试——单独追加事件**

```ts
it('appends compact_attempt event to events.jsonl', async () => {
  const store = createSessionStore(paths)
  const session = await store.getOrCreate(args)
  await store.appendEvent(session, {
    type: 'compact_attempt',
    timestamp: new Date().toISOString(),
    mode: 'auto',
    trigger: 'budget',
    preCompactApproxChars: 800_000,
    preCompactMessageCount: 50,
  })
  const events = await fs.readFile(path.join(session.dir, 'events.jsonl'), 'utf8')
  expect(events).toContain('"type":"compact_attempt"')
  expect(events).toContain('"preCompactApproxChars":800000')
})
```

- [ ] **Step 3：跑测试，预期通过（`appendEvent` 已存在，新事件类型只是 union 扩展）**

```bash
pnpm test
```

- [ ] **Step 4：在 ContextCompactor / ConversationOrchestrator 各路径打事件**

`ContextCompactor.autoCompact`：

```ts
async autoCompact(args) {
  const startedAt = Date.now()
  const preCompactApproxChars = estimateMessagesChars(args.messages)
  await deps.eventSink?.append({
    type: 'compact_attempt',
    timestamp: new Date().toISOString(),
    mode: 'auto',
    trigger: args.trigger,
    preCompactApproxChars,
    preCompactMessageCount: args.messages.length,
  })

  try {
    const preprocessed = preprocessForCompact(...)
    const { output, ptlRetryCount, ptlDroppedMessages } =
      await summarizeWithPTLRetry(deps.compactAgent, preprocessed, log)
    // ... 写 jsonl + compact.jsonl
    const postCompactApproxChars = estimateMessagesChars([assistantMessage(...)])
    const willRetrigger = postCompactApproxChars >= args.triggerThreshold

    await deps.eventSink?.append({
      type: 'compact_succeeded',
      timestamp: new Date().toISOString(),
      mode: 'auto',
      preCompactApproxChars,
      postCompactApproxChars,
      willRetriggerNextTurn: willRetrigger,
      compactionDurationMs: Date.now() - startedAt,
      compactionUsage: output.usage,
      ...(ptlRetryCount > 0 ? { ptlRetryCount, ptlDroppedMessages } : {}),
    })
    return { status: 'compacted', finalMessages: [...] }
  } catch (error) {
    const reason = classifyCompactError(error)  // 分 prompt_too_long / network / api_error / no_summary / unknown
    const counted = reason !== 'prompt_too_long'
    // 计数 + 决定 breakerOpened（由 caller 处理 meta 状态后回调）
    await deps.eventSink?.append({
      type: 'compact_failed',
      ...
    })
    throw error
  }
}
```

`ConversationOrchestrator` 在 trigger 判定 skipped 时打事件：

```ts
if (!autoCompactConfig?.enabled) {
  await deps.sessionStore.appendEvent(session, {
    type: 'compact_skipped', timestamp, mode: 'auto', reason: 'enabled_false',
  })
  return
}
if (candidateMessages.length < 2) {
  await deps.sessionStore.appendEvent(session, {
    type: 'compact_skipped', timestamp, mode: 'auto', reason: 'too_few_messages',
  })
  return
}
if (autoCompactState.breakerOpen) {
  await deps.sessionStore.appendEvent(session, {
    type: 'compact_skipped', timestamp, mode: 'auto', reason: 'breaker_open',
  })
  return
}
if (estimateMessagesChars(candidateMessages) < charThreshold) {
  // 不打 'below_threshold' 事件（每轮都不达标会噪音爆炸；只在 dry run / debug 时打）
  return
}
```

具体接口设计：给 `ContextCompactorDeps` 加 `eventSink: { append: (e: SessionEvent) => Promise<void> }`，由 `ConversationOrchestrator` 注入 SessionStore 的 `appendEvent` 适配 wrapper。

- [ ] **Step 5：跑全套测试**

```bash
pnpm test
```

预期：全过。补几个集成用例验证事件确实写入。

- [ ] **Step 6：commit**

```bash
git add src/store/ src/orchestrator/
git commit -m "feat(compact): emit 4 compact event types to events.jsonl"
```

### Task 5.2：修订 `run-auto-compact.ts` 加 `willRetriggerNextTurn` 断言

**Files:**
- Modify: `src/e2e/live/run-auto-compact.ts`

- [ ] **Step 1：修订 description + 断言扩展**

`run-auto-compact.ts:263`：

```ts
description: 'Force auto compact by message-count budget and verify the main reply continues.',
```

改为：

```ts
description: 'Force auto compact by approximate character budget; verify main reply continues, summary persisted, willRetriggerNextTurn === false.',
```

加新 matched 字段 `compactWillNotRetrigger: boolean`；在主 await 块内：

```ts
const eventsPath = path.join(sessionDir, 'events.jsonl')
const eventsRaw = existsSync(eventsPath) ? await fs.readFile(eventsPath, 'utf8') : ''
const succeededEvents = eventsRaw
  .split('\n')
  .filter((l) => l.length > 0)
  .map((l) => JSON.parse(l))
  .filter((e: { type: string }) => e.type === 'compact_succeeded')
result.matched.compactWillNotRetrigger =
  succeededEvents.length > 0 && succeededEvents[0].willRetriggerNextTurn === false
```

assertResult 加：

```ts
if (!result.matched.compactWillNotRetrigger) {
  failures.push('compact_succeeded.willRetriggerNextTurn !== false (compaction was not effective)')
}
```

- [ ] **Step 2：跑 e2e**

```bash
pnpm e2e auto-compact
```

预期：PASS。

- [ ] **Step 3：commit**

```bash
git add src/e2e/live/run-auto-compact.ts
git commit -m "test(e2e): assert willRetriggerNextTurn=false in auto-compact"
```

### Task 5.3：新增 `run-compact-effectiveness.ts`

**Files:**
- 新建：`src/e2e/live/run-compact-effectiveness.ts`

- [ ] **Step 1：场景骨架**

```ts
import './load-e2e-env.ts'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import YAML from 'yaml'
import { consola } from 'consola'
import { resolveWorkspacePaths } from '@/workspace/paths.ts'
import type { LiveE2EScenario } from './scenario.ts'
import { runDirectly } from './scenario.ts'
import {
  createLiveE2EContext, delay, findReplyContaining, findSessionDir,
  readSessionMessages, waitForThread, writeScenarioResult,
} from './scenario-utils.ts'

interface EffectivenessResult {
  passed: boolean
  failureMessage?: string
  runId: string
  workspaceDir?: string
  preCompactApproxChars?: number
  postCompactApproxChars?: number
  shrinkRatio?: number
  willRetriggerNextTurn?: boolean
  matched: {
    fixtureLoaded: boolean
    compactSucceededEventFound: boolean
    willRetriggerFalse: boolean
    mainReplyArrived: boolean
  }
}

const FIXTURE_PATH = path.join(
  process.cwd(),
  'tests',
  'fixtures',
  'compact',
  'large-history-1m.jsonl',
)

async function main(): Promise<void> {
  const runId = randomUUID()
  const result: EffectivenessResult = {
    passed: false,
    runId,
    matched: {
      fixtureLoaded: false,
      compactSucceededEventFound: false,
      willRetriggerFalse: false,
      mainReplyArrived: false,
    },
  }

  const workspaceDir = await createWorkspace()
  result.workspaceDir = workspaceDir

  let ctx: Awaited<ReturnType<typeof createLiveE2EContext>> | undefined

  try {
    ctx = await createLiveE2EContext(runId, { workspaceDir })

    // 在 application.start() 之前预置 fixture 到对应 session 目录
    const channelName = ctx.channelName
    const channelId = ctx.channelId
    const threadTs = `${runId}.placeholder`  // 真实 thread ts 在 SlackAdapter 触发时分配
    // 由于真实 thread ts 不可预测，这里用一个 hook：先 start 再注入
    // 实际方案：先 postMessage 拿到 root.ts，然后 await delay(2_000)，复制 fixture 到 session dir
    await ctx.application.start()
    await delay(3_000)

    const root = await ctx.triggerClient.postMessage({
      channel: channelId,
      text: `<@${ctx.botUserId}> EFFECTIVENESS_SEED ${runId}\nDo not use tools.\nReply: SEED_OK`,
    })

    // 等首次 session 创建（看到 reply 即认为 session dir 已存在）
    await waitForThread(ctx, root.ts, (msgs) =>
      findReplyContaining(msgs, root.ts, 'SEED_OK') !== undefined,
    )

    // 复制 fixture 覆盖 messages.jsonl
    const sessionDir = await findSessionDir(root.ts, { workspaceDir })
    const fixtureContent = await fs.readFile(FIXTURE_PATH, 'utf8')
    // 保留 SEED 这一轮的最后两条（user + assistant）作为现状
    const existing = await fs.readFile(path.join(sessionDir, 'messages.jsonl'), 'utf8')
    await fs.writeFile(
      path.join(sessionDir, 'messages.jsonl'),
      fixtureContent + existing,
      'utf8',
    )
    result.matched.fixtureLoaded = true

    // 触发 compact——发一条新消息，应使得切片视图 + 当前 user msg 超阈值
    const trigger = await ctx.triggerClient.postMessage({
      channel: channelId,
      thread_ts: root.ts,
      text: `<@${ctx.botUserId}> EFFECTIVENESS_GO ${runId}\nReply: DONE`,
    })

    await waitForThread(ctx, root.ts, async (msgs) => {
      result.matched.mainReplyArrived = !!findReplyContaining(msgs, root.ts, 'DONE')
      const eventsRaw = await readEventsJsonl(sessionDir)
      const succeeded = eventsRaw.filter((e) => e.type === 'compact_succeeded')
      if (succeeded.length > 0) {
        const ev = succeeded[0]!
        result.matched.compactSucceededEventFound = true
        result.preCompactApproxChars = ev.preCompactApproxChars
        result.postCompactApproxChars = ev.postCompactApproxChars
        result.shrinkRatio =
          ev.postCompactApproxChars / Math.max(ev.preCompactApproxChars, 1)
        result.willRetriggerNextTurn = ev.willRetriggerNextTurn
        result.matched.willRetriggerFalse = ev.willRetriggerNextTurn === false
      }
      return result.matched.mainReplyArrived && result.matched.compactSucceededEventFound
    })

    assertResult(result)
    result.passed = true
    consola.info(
      `Compact effectiveness: ${result.preCompactApproxChars} → ${result.postCompactApproxChars} chars (${(result.shrinkRatio! * 100).toFixed(1)}%)`,
    )
  } catch (err) {
    result.failureMessage = err instanceof Error ? err.message : String(err)
    throw err
  } finally {
    await writeScenarioResult('compact-effectiveness', result).catch(() => {})
    if (ctx) await ctx.application.stop().catch(() => {})
    await fs.rm(workspaceDir, { recursive: true, force: true }).catch(() => {})
  }
}

async function readEventsJsonl(sessionDir: string): Promise<Array<{ type: string; [k: string]: unknown }>> {
  const file = path.join(sessionDir, 'events.jsonl')
  if (!existsSync(file)) return []
  const raw = await fs.readFile(file, 'utf8')
  return raw.split('\n').filter((l) => l.length > 0).map((l) => JSON.parse(l))
}

async function createWorkspace(): Promise<string> {
  const workspaceDir = await fs.mkdtemp(path.join(tmpdir(), 'agent-slack-compact-eff-'))
  const sourcePaths = resolveWorkspacePaths(process.cwd())
  const targetPaths = resolveWorkspacePaths(workspaceDir)
  await fs.mkdir(targetPaths.root, { recursive: true })

  const sourceConfig = existsSync(sourcePaths.configFile)
    ? YAML.parse(await fs.readFile(sourcePaths.configFile, 'utf8'))
    : {}
  const config = sourceConfig as Record<string, unknown>
  const agent = (config.agent as Record<string, unknown>) ?? {}
  config.agent = {
    ...agent,
    context: {
      maxApproxChars: 1_000_000,
      keepRecentMessages: 80,
      keepRecentToolResults: 20,
      autoCompact: { enabled: true, triggerRatio: 0.8, maxFailures: 2 },
    },
  }
  await fs.writeFile(targetPaths.configFile, YAML.stringify(config), 'utf8')
  if (existsSync(sourcePaths.systemFile)) {
    await fs.copyFile(sourcePaths.systemFile, targetPaths.systemFile)
  }
  return workspaceDir
}

function assertResult(r: EffectivenessResult): void {
  const failures: string[] = []
  if (!r.matched.fixtureLoaded) failures.push('fixture not loaded into session')
  if (!r.matched.mainReplyArrived) failures.push('main reply did not arrive')
  if (!r.matched.compactSucceededEventFound) failures.push('compact_succeeded event missing')
  if (!r.matched.willRetriggerFalse) failures.push('willRetriggerNextTurn !== false')
  if (failures.length > 0) throw new Error(`compact-effectiveness failed: ${failures.join('; ')}`)
}

export const scenario: LiveE2EScenario = {
  id: 'compact-effectiveness',
  title: 'Compact Effectiveness',
  description: 'Inject 1M-char fixture; trigger auto compact; verify willRetriggerNextTurn=false and shrink ratio.',
  keywords: ['compact', 'effectiveness', 'shrink'],
  run: main,
}

runDirectly(scenario)
```

- [ ] **Step 2：跑 e2e**

```bash
pnpm e2e compact-effectiveness
```

预期：PASS。result 文件中 `shrinkRatio` 应远小于 0.8（< 0.1 即压到 10% 以下属正常）。

- [ ] **Step 3：commit**

```bash
git add src/e2e/live/run-compact-effectiveness.ts
git commit -m "test(e2e): add compact-effectiveness scenario with 1M fixture"
```

### Task 5.4：新增 `run-auto-compact-no-rework.ts`

**Files:**
- 新建：`src/e2e/live/run-auto-compact-no-rework.ts`

- [ ] **Step 1：场景骨架**

骨架与 Task 5.3 类似。关键差异：
- 触发第一轮 compact 后
- 发第二条很短的小消息
- 验证：events.jsonl 中**只有 1 条** `compact_attempt` 事件，第二轮无新增 attempt

```ts
// 关键断言段
const events = await readEventsJsonl(sessionDir)
const attempts = events.filter((e) => e.type === 'compact_attempt')
result.matched.singleAttempt = attempts.length === 1
```

完整代码结构与 5.3 大致同构，省略重复段落（实施时按模板写）。

- [ ] **Step 2：跑 e2e**

```bash
pnpm e2e auto-compact-no-rework
```

预期：PASS。

- [ ] **Step 3：commit**

```bash
git add src/e2e/live/run-auto-compact-no-rework.ts
git commit -m "test(e2e): add auto-compact-no-rework scenario (no double-compaction)"
```

### Task 5.5：新增 `run-auto-compact-breaker-open.ts`

**Files:**
- 新建：`src/e2e/live/run-auto-compact-breaker-open.ts`

- [ ] **Step 1：场景骨架**

关键技巧：在 e2e workspace 的 `config.yaml` 里把 compact 走的 model 配置成**故意 invalid**（指向不存在的 endpoint 或不存在的 model name），让 compact 调用稳定失败。

```yaml
agent:
  model: claude-sonnet-4-5  # 主 agent 正常
compact:
  model: nonexistent-model  # compact 用 invalid model，必失败
```

但当前 agent-slack 是否支持 compact agent 独立 model 配置？查代码：[application/createApplication.ts] 里 compactAgent 用的是同一个 model。

如不支持，本 task 改为**不在配置层造失败**，改为**在 e2e runner 内 monkey-patch 注入失败**——但这会修改 runner 框架，超出本 plan 范围。

**折中方案**：先把 compact agent model 与主 agent model 解耦（Chunk 5.5 task 0），然后再写 breaker e2e。或者本 e2e 暂时用 `// SKIP` 标注，留待 application 配置层支持后启用。

具体决策见 Task 5.5 Step 0。

- [ ] **Step 0：评估 compact model 解耦的实施成本**

打开 `src/application/createApplication.ts` 看 compactAgent 注入路径：

```bash
grep -n "compactAgent\|createCompactAgent" src/application/createApplication.ts
```

如果 compactAgent 用同一个 `model`，本 task 需要先做：
- `agent.compact.model` 配置项
- `createCompactAgent` 接受独立 model
- 测试覆盖

**判断**：如果改造 ≤ 半天，本 chunk 内做掉；如果 ≥ 1 天，把 5.5 推到独立 plan。

- [ ] **Step 1（compact model 解耦后）：场景骨架**

[省略骨架——结构同 5.3，关键断言]：

```ts
const events = await readEventsJsonl(sessionDir)
const failed = events.filter((e) => e.type === 'compact_failed')
const skippedBreaker = events.filter(
  (e) => e.type === 'compact_skipped' && e.reason === 'breaker_open',
)
result.matched.failedTwice = failed.length === 2
result.matched.breakerSkippedThirdAttempt = skippedBreaker.length >= 1
result.matched.mainReplyContinued = ... // 主回复仍能完成
```

- [ ] **Step 2：跑 e2e**

```bash
pnpm e2e auto-compact-breaker-open
```

预期：PASS。

- [ ] **Step 3：commit**

```bash
git add src/e2e/live/run-auto-compact-breaker-open.ts <可能的 application 改动>
git commit -m "test(e2e): add auto-compact-breaker-open scenario"
```

---

## Chunk 6: A1 真实 input_tokens 触发 + meta 快照

> **出口**：`shouldTriggerAutoCompact` 优先用 `meta.context.lastUsage.apiInputTokens` 与 `effectiveContextWindow - 摘要预留 - safetyBuffer` 比较；首轮（lastUsage 缺失）回退字符估算。AiSdkExecutor 在 `usage-info` 事件多带 `lastApiInputTokens`（最后一次 step 的 inputTokens 覆盖语义）。

### Task 6.1：AiSdkExecutor 暴露 `lastApiInputTokens`

**Files:**
- Modify: `src/agent/AiSdkExecutor.ts`
- Modify: `src/agent/AiSdkExecutor.test.ts`
- Modify: `src/core/events.ts`

- [ ] **Step 1：写失败测试**

```ts
it('exposes last step input_tokens (override semantics)', async () => {
  // 模拟 streamText 的 step-finish events
  const events: AgentExecutionEvent[] = []
  // ... 触发 2 个 step-finish，inputTokens 分别 100 / 250
  // 期望：usage-info.lastApiInputTokens === 250（覆盖，不累加）
  const usage = events.find((e) => e.type === 'usage-info')
  expect(usage?.usage.lastApiInputTokens).toBe(250)
})
```

- [ ] **Step 2：实现**

`src/agent/AiSdkExecutor.ts` aggregator state 加：

```ts
interface AggregatorState {
  // 既有字段
  lastStepInputTokens: number  // 覆盖写，反映最后一次 step 的 inputTokens
}
```

`updateUsage` 内：

```ts
function updateUsage(agg, modelName, usage, providerMetadata) {
  // 既有累加逻辑保留
  agg.modelUsage.set(modelName, { ... })
  // 新增：覆盖 lastStepInputTokens
  agg.lastStepInputTokens = toSafeInt(usage.promptTokens ?? usage.inputTokens)
}
```

`buildUsageInfo` 内输出 `lastApiInputTokens: agg.lastStepInputTokens`。

`src/core/events.ts` `SessionUsageInfo` 加：

```ts
export interface SessionUsageInfo {
  // 既有
  lastApiInputTokens?: number
}
```

- [ ] **Step 3：跑测试**

```bash
pnpm test
```

预期：全过。

- [ ] **Step 4：commit**

```bash
git add src/agent/ src/core/
git commit -m "feat(executor): expose lastApiInputTokens in usage-info (override semantics)"
```

### Task 6.2：`SessionMeta` 加 `lastUsage` 快照

**Files:**
- Modify: `src/store/SessionStore.ts`
- Modify: `src/store/SessionStore.test.ts`

- [ ] **Step 1：扩 `SessionMeta`**

```ts
export interface SessionMeta {
  // 既有字段
  context?: {
    autoCompact?: AutoCompactState
    lastUsage?: {
      apiInputTokens: number
      capturedAt: string  // ISO timestamp
    }
  }
}
```

新增方法：

```ts
async setLastUsage(id: string, snapshot: { apiInputTokens: number }): Promise<void>
async getLastUsage(id: string): Promise<{ apiInputTokens: number; capturedAt: string } | undefined>
```

实现：覆盖写 `meta.context.lastUsage`。

- [ ] **Step 2：在 ConversationOrchestrator 的 usage-info 处理处调用 setLastUsage**

[ConversationOrchestrator.ts:306-322](../../../src/orchestrator/ConversationOrchestrator.ts:306) `usage-info` 事件处理：

```ts
if (event.type === 'usage-info') {
  // 既有累加
  await deps.sessionStore.accumulateUsage(...)
  if (event.usage.lastApiInputTokens !== undefined) {
    await deps.sessionStore.setLastUsage(session.id, {
      apiInputTokens: event.usage.lastApiInputTokens,
    })
  }
}
```

- [ ] **Step 3：跑测试，写新单测**

```ts
it('persists last input tokens to meta', async () => {
  // ... 模拟 usage-info 事件
  const meta = await store.getMeta(sessionId)
  expect(meta?.context?.lastUsage?.apiInputTokens).toBe(123_456)
})
```

```bash
pnpm test
```

- [ ] **Step 4：commit**

```bash
git add src/store/ src/orchestrator/
git commit -m "feat(store): persist lastUsage snapshot to meta.json"
```

### Task 6.3：触发判定切到真实 input_tokens

**Files:**
- Modify: `src/orchestrator/ConversationOrchestrator.ts`
- Modify: `src/orchestrator/ConversationOrchestrator.test.ts`

- [ ] **Step 1：写失败测试**

```ts
it('triggers auto compact based on real apiInputTokens when lastUsage exists', async () => {
  // 配置：effectiveContextWindow = 200_000, safetyBuffer = 13_000, summaryReserve = 20_000
  //   triggerThreshold ≈ 167_000 tokens
  // 设置 meta.context.lastUsage.apiInputTokens = 170_000（超阈值）
  // 触发判定应该 fire
})

it('falls back to char estimation when lastUsage missing (first turn)', async () => {
  // 不设 lastUsage；用大字符 history → 触发字符阈值
  // 触发判定应该 fire
})
```

- [ ] **Step 2：实现**

`ConversationOrchestrator.shouldTriggerAutoCompact` 重写：

```ts
async function shouldTriggerAutoCompact(
  candidateMessages: CoreMessage[],
  lastUsage?: { apiInputTokens: number },
  modelEffectiveContextWindow?: number,
): Promise<boolean> {
  if (!autoCompactConfig?.enabled || candidateMessages.length < 2) return false
  const triggerRatio = clamp(autoCompactConfig.triggerRatio, 0.01, 1)

  // 优先用真实 input_tokens
  if (lastUsage && modelEffectiveContextWindow) {
    const SUMMARY_RESERVE = 20_000
    const SAFETY_BUFFER = 13_000
    const threshold = (modelEffectiveContextWindow - SUMMARY_RESERVE - SAFETY_BUFFER) * triggerRatio
    return lastUsage.apiInputTokens >= threshold
  }

  // 首轮 fallback：字符估算
  const charThreshold = Math.max(1, Math.ceil(modelMessageBudget.maxApproxChars * triggerRatio))
  return estimateMessagesChars(candidateMessages) >= charThreshold
}
```

`modelEffectiveContextWindow` 来源：从 `workspace.config.agent` 推断（200_000 默认 Sonnet；1m beta 模型从 model 名匹配）。

- [ ] **Step 3：跑测试**

```bash
pnpm test
```

- [ ] **Step 4：commit**

```bash
git add src/orchestrator/
git commit -m "feat(compact): trigger judgement uses real apiInputTokens when available"
```

### Task 6.4：跑全套 e2e 验证不退化

- [ ] **Step 1：跑 unit + e2e 全套**

```bash
pnpm test
pnpm e2e
```

预期：所有 unit + 4 个 compact e2e + 既有 e2e 全过。

- [ ] **Step 2：spec 同步——把 §3.7.2 过渡说明的"待补 ①②"标记为完成**

`docs/superpowers/specs/2026-04-17-agent-slack-architecture-design.md` 过渡说明段落：

```md
> 数据通路（**已具备 80%**）：
> - 待补 ①：...
> - 待补 ②：...
```

改为：

```md
> 数据通路（**已落地**）：
> - executor `usage-info.lastApiInputTokens` 覆盖语义已实现（[`AiSdkExecutor.ts`](../../../src/agent/AiSdkExecutor.ts)）
> - `meta.context.lastUsage.apiInputTokens` 持久化已实现（[`SessionStore.ts`](../../../src/store/SessionStore.ts)）
> - 首轮（`lastUsage` 缺失）回退字符估算已实现
```

- [ ] **Step 3：commit**

```bash
git add docs/superpowers/specs/2026-04-17-agent-slack-architecture-design.md
git commit -m "docs(spec): mark token-based trigger transition complete"
```

---

## 收尾

Plan 全部 Chunk 完成后：

- [ ] **跑 unit + e2e 全套确认**

```bash
pnpm test
pnpm e2e
```

- [ ] **更新 spec 实施现状表（§3.7.1.1）**

把"待重构"列表里所有完成项移到"已运行"列表。

- [ ] **更新 memory**

新增/更新 memory 文件记录关键经验（如 PTL retry 实测频率、压缩比观察等）。

- [ ] **commit + push 主分支（如使用 worktree）**

每 Chunk 独立 commit；最终合入 main 通过 PR review。

---

## 参考

- Spec：[`docs/superpowers/specs/2026-04-17-agent-slack-architecture-design.md`](../specs/2026-04-17-agent-slack-architecture-design.md) §3.7
- free-code 对比代码：
  - [`autoCompact.ts:225-238`](../../../../../general-agent/free-code/src/services/compact/autoCompact.ts:225) — 触发判定
  - [`compact.ts:450-491`](../../../../../general-agent/free-code/src/services/compact/compact.ts:450) — PTL retry
  - [`compact.ts:330-338`](../../../../../general-agent/free-code/src/services/compact/compact.ts:330) — buildPostCompactMessages
  - [`prompt.ts:61-143`](../../../../../general-agent/free-code/src/services/compact/prompt.ts:61) — BASE_COMPACT_PROMPT
  - [`grouping.ts`](../../../../../general-agent/free-code/src/services/compact/grouping.ts) — groupMessagesByApiRound
  - [`context.ts:12`](../../../../../general-agent/free-code/src/utils/context.ts:12) — COMPACT_MAX_OUTPUT_TOKENS
- 诊断 memory：[`feedback_compact_trigger.md`](../../../../../../.claude/projects/-Users-moego-winches-Desktop-Company-AI-Agent-agent-slack/memory/feedback_compact_trigger.md)
