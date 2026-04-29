# OpenAI Responses API 接入实施计划

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 新增 `agent.provider='openai-responses'` 第三条 provider 路径，通过 LiteLLM 网关 `/responses` 端点让 Slack progress block 看到逐字 thinking、usage 行追加 `(N thinking)` 段。

**Architecture:** 三层独立分支（`litellm` / `anthropic` / `openai-responses`），共享 `LITELLM_*` 凭证；通过新增 `extraProviderOptions` deps 字段把 `providerOptions.openai.{reasoningEffort, reasoningSummary, store}` 透到 `streamText`；ai-sdk 已自动把 `response.reasoning_summary_text.delta` 映射成 `type:'reasoning'` stream part 命中既有 case 分支。

**Tech Stack:** TypeScript / Node 22 / Vitest / `ai@^4.0.0` / `@ai-sdk/openai@^1.3.24`（**版本下限关键**，spec §4.1）/ Slack Block Kit / LiteLLM gateway。

**Spec:** [`docs/superpowers/specs/2026-04-29-openai-responses-thinking-design.md`](../specs/2026-04-29-openai-responses-thinking-design.md)

---

## 文件结构

| 改动类型 | 路径 | 责任 |
|---|---|---|
| 修改 | `package.json` | +1 dep `@ai-sdk/openai@^1.3.24` |
| 修改 | `src/workspace/config.ts` | provider enum 加 `'openai-responses'`；新增 `agent.responses` 子对象 |
| 修改 | `src/workspace/config.test.ts` | +3 用例 |
| 修改 | `src/application/createApplication.ts` | `AgentProvider` 扩三元；`ProviderEnv` 第三变体；`loadProviderEnv` / `buildProviderRuntime` 第三分支；构造 `extraProviderOptions` 透传 |
| 修改 | `src/application/createApplication.test.ts` | +`createOpenAI` mock；+2~3 用例 |
| 修改 | `src/agent/AiSdkExecutor.ts` | `AiSdkExecutorDeps.extraProviderOptions?`；`ModelUsageSnapshot.reasoningTokens`；`extractReasoningTokens` helper；`updateUsage` / `buildUsageInfo` 衍生；`streamText` providerOpts 合并 |
| 修改 | `src/agent/AiSdkExecutor.test.ts` | +2 用例（reasoningTokens 透出 / 缺省） |
| 修改 | `src/core/events.ts` | `SessionUsageInfo.modelUsage[].reasoningTokens?: number` |
| 修改 | `src/im/slack/SlackRenderer.ts:120` | progress emoji `🤔` → `:fluent-thinking-3d:` |
| 修改 | `src/im/slack/SlackRenderer.ts` `formatUsageLine` | 追加 `(N thinking)` 段 |
| 修改 | `src/im/slack/SlackRenderer.test.ts` | 改 1（emoji）+ 加 2（thinking 段有/无） |
| 新建 | `src/e2e/live/run-thinking-responses.ts` | live e2e：临时 workspace 配 `provider=openai-responses`，monkey-patch fetch 校验请求 body 与端点 |

不动：`SlackEventSink.ts` / `SlackAdapter.ts` / `ConversationOrchestrator.ts` / `SessionRunQueue.ts` / `SessionStore.ts` / `MemoryStore.ts` / `ContextCompactor.ts` / `agents/compact/*` / `agents/selfImprove/*` / 其他全部 e2e。

---

## Chunk 1: Phase 1 — 端点切通（Task 1~5）

> **出口**：现有 `pnpm e2e basic-reply` 在临时 workspace `provider=openai-responses` 下能跑通。reasoning summary 是否显示暂不验证。

### Task 1：加 `@ai-sdk/openai` 依赖

**Files:**
- Modify: `package.json:42`

- [ ] **Step 1：在 dependencies 块 `@ai-sdk/openai-compatible` 之前插入新依赖**

`package.json:41-42` 当前：
```json
"@ai-sdk/anthropic": "^1.2.12",
"@ai-sdk/openai-compatible": "^0.1.0",
```

改为：
```json
"@ai-sdk/anthropic": "^1.2.12",
"@ai-sdk/openai": "^1.3.24",
"@ai-sdk/openai-compatible": "^0.1.0",
```

**版本下限关键**：v1.3.24 才把 `gpt-5*` 列入 `isReasoningModel`（见 spec §4.1）。低于 1.3.24 整套 thinking 行为失效。

- [ ] **Step 2：安装并校验**

```bash
pnpm install
pnpm typecheck
```

Expected：typecheck 通过，无新 error。

- [ ] **Step 3：Commit**

```bash
git add package.json pnpm-lock.yaml
git commit -m "chore: add @ai-sdk/openai ^1.3.24 for responses path"
```

---

### Task 2：Config schema 扩展

**Files:**
- Modify: `src/workspace/config.ts:10`、`src/workspace/config.ts:30`
- Test: `src/workspace/config.test.ts`

- [ ] **Step 1：先写失败测试**

在 `src/workspace/config.test.ts:75` 末（在 `agent.provider 非法值报错` 用例**前**）插入 3 个用例：

```ts
it('agent.provider=openai-responses 解析合法且 responses 子字段取默认', () => {
  const cfg = parseConfig({ agent: { provider: 'openai-responses' } })
  expect(cfg.agent.provider).toBe('openai-responses')
  expect(cfg.agent.responses).toEqual({
    reasoningEffort: 'medium',
    reasoningSummary: 'auto',
  })
})

it('agent.responses 接受用户覆盖', () => {
  const cfg = parseConfig({
    agent: {
      provider: 'openai-responses',
      responses: { reasoningEffort: 'low', reasoningSummary: 'detailed' },
    },
  })
  expect(cfg.agent.responses.reasoningEffort).toBe('low')
  expect(cfg.agent.responses.reasoningSummary).toBe('detailed')
})

it('reasoningEffort 非法值报错', () => {
  expect(() =>
    parseConfig({ agent: { responses: { reasoningEffort: 'extreme' } } }),
  ).toThrow()
})
```

- [ ] **Step 2：跑测试，确认 fail**

```bash
pnpm test -- src/workspace/config.test.ts
```

Expected：FAIL — `provider` enum 不接受 `'openai-responses'`，`agent.responses` 字段未定义。

- [ ] **Step 3：实现 schema 改动**

`src/workspace/config.ts:10` 当前：
```ts
provider: z.enum(['litellm', 'anthropic']).default('litellm'),
```

改为：
```ts
provider: z.enum(['litellm', 'anthropic', 'openai-responses']).default('litellm'),
// provider='openai-responses' 时实际生效；其他 provider 装配代码不读，但允许写在 yaml 里。
responses: z
  .object({
    reasoningEffort: z.enum(['low', 'medium', 'high']).default('medium'),
    reasoningSummary: z.enum(['auto', 'concise', 'detailed']).default('auto'),
  })
  .default({}),
```

注意：插入位置是 `provider` 字段下、`context` 字段上方（即 `src/workspace/config.ts:11` 之前）。

- [ ] **Step 4：跑测试确认通过**

```bash
pnpm test -- src/workspace/config.test.ts
```

Expected：所有 9 个用例通过（原 6 + 新 3）。

- [ ] **Step 5：Commit**

```bash
git add src/workspace/config.ts src/workspace/config.test.ts
git commit -m "feat(config): extend agent.provider with 'openai-responses' + responses sub-config"
```

---

### Task 3：Provider 装配（`createApplication.ts`）

**Files:**
- Modify: `src/application/createApplication.ts:35`、`:183-196`、`:198-218`、`:226-258`、`:120-128`
- Test: `src/application/createApplication.test.ts`

- [ ] **Step 1：先写失败测试**

`src/application/createApplication.test.ts:54` 后（`createAnthropic` mock 之后），在 `mocks` 对象中新增字段：

```ts
createOpenAI: vi.fn(() => ({
  responses: vi.fn((modelName: string) => ({ modelName, provider: 'openai-responses' })),
})),
```

`src/application/createApplication.test.ts:109` 后追加 vi.mock 声明：

```ts
vi.mock('@ai-sdk/openai', () => ({
  createOpenAI: mocks.createOpenAI,
}))
```

`src/application/createApplication.test.ts:313`（`describe('createApplication')` 块尾、最后一个 `it` 之前）插入用例：

```ts
it('config.agent.provider=openai-responses → 调用 createOpenAI(.responses) + LiteLLM 凭证 + extraProviderOptions', async () => {
  mocks.loadWorkspaceContext.mockResolvedValueOnce({
    cwd: '/mock-workspace',
    paths: mocks.paths,
    config: {
      agent: {
        model: 'gpt-5.4',
        maxSteps: 8,
        provider: 'openai-responses' as const,
        responses: { reasoningEffort: 'low', reasoningSummary: 'detailed' },
      },
    },
    systemPrompt: 'system prompt',
    skills: [],
  })

  await createApplication({ workspaceDir: '/workspace' })

  expect(mocks.createOpenAI).toHaveBeenCalledWith({
    baseURL: 'https://litellm.example.com',
    apiKey: 'litellm-key',
    name: 'openai-responses',
    compatibility: 'compatible',
  })
  expect(mocks.createOpenAICompatible).not.toHaveBeenCalled()
  expect(mocks.createAnthropic).not.toHaveBeenCalled()

  const executorArgs = mocks.createAiSdkExecutor.mock.calls[0]?.[0] as
    | { extraProviderOptions?: Record<string, unknown> }
    | undefined
  expect(executorArgs?.extraProviderOptions).toEqual({
    openai: {
      reasoningEffort: 'low',
      reasoningSummary: 'detailed',
      store: false,
    },
  })
})

it('config.agent.provider=litellm 时不传 extraProviderOptions', async () => {
  await createApplication({ workspaceDir: '/workspace' })
  const executorArgs = mocks.createAiSdkExecutor.mock.calls[0]?.[0] as
    | { extraProviderOptions?: unknown }
    | undefined
  expect(executorArgs?.extraProviderOptions).toBeUndefined()
})
```

- [ ] **Step 2：跑测试，确认 fail**

```bash
pnpm test -- src/application/createApplication.test.ts
```

Expected：FAIL —  `createOpenAI` 未被调用；`extraProviderOptions` 未透传。

- [ ] **Step 3：扩展 `AgentProvider` 类型**

`src/application/createApplication.ts:35` 当前：
```ts
export type AgentProvider = 'litellm' | 'anthropic'
```

改为：
```ts
export type AgentProvider = 'litellm' | 'anthropic' | 'openai-responses'
```

- [ ] **Step 4：在文件顶部 import 加 `createOpenAI`**

`src/application/createApplication.ts:2` 后插入：
```ts
import { createOpenAI } from '@ai-sdk/openai'
```

- [ ] **Step 5：扩展 `ProviderEnv` 类型**

`src/application/createApplication.ts:196` 后（在 `}` 闭合之前的 union 末端）追加第三变体：

```ts
type ProviderEnv =
  | {
      provider: 'litellm'
      litellmBaseUrl: string
      litellmApiKey: string
      providerName: string
      secrets: string[]
    }
  | {
      provider: 'anthropic'
      anthropicApiKey: string
      anthropicBaseUrl?: string
      secrets: string[]
    }
  | {
      provider: 'openai-responses'
      litellmBaseUrl: string
      litellmApiKey: string
      secrets: string[]
    }
```

- [ ] **Step 6：扩展 `loadProviderEnv`**

`src/application/createApplication.ts:198-218` 当前实现是两分支（litellm / fallthrough anthropic）。重写为三分支显式判断（避免 fallthrough 隐含 anthropic）：

```ts
function loadProviderEnv(provider: AgentProvider): ProviderEnv {
  if (provider === 'litellm') {
    const litellmBaseUrl = requireEnv('LITELLM_BASE_URL')
    const litellmApiKey = requireEnv('LITELLM_API_KEY')
    return {
      provider: 'litellm',
      litellmBaseUrl,
      litellmApiKey,
      providerName: 'litellm',
      secrets: [litellmApiKey],
    }
  }
  if (provider === 'openai-responses') {
    const litellmBaseUrl = requireEnv('LITELLM_BASE_URL')
    const litellmApiKey = requireEnv('LITELLM_API_KEY')
    return {
      provider: 'openai-responses',
      litellmBaseUrl,
      litellmApiKey,
      secrets: [litellmApiKey],
    }
  }
  const anthropicApiKey = requireEnv('ANTHROPIC_API_KEY')
  const anthropicBaseUrl = process.env.ANTHROPIC_BASE_URL?.trim() || undefined
  return {
    provider: 'anthropic',
    anthropicApiKey,
    ...(anthropicBaseUrl ? { anthropicBaseUrl } : {}),
    secrets: [anthropicApiKey],
  }
}
```

- [ ] **Step 7：扩展 `buildProviderRuntime`**

`src/application/createApplication.ts:243` 后（`anthropic` 分支之后、`throw new ConfigError` 之前）插入第三分支：

```ts
if (provider === 'openai-responses' && env.provider === 'openai-responses') {
  const p = createOpenAI({
    baseURL: env.litellmBaseUrl,
    apiKey: env.litellmApiKey,
    name: 'openai-responses',
    compatibility: 'compatible',
  })
  return {
    model: p.responses(modelName),
    modelName,
    providerNameForOptions: 'openai-responses',
  }
}
```

> **注意**：`name: 'openai-responses'` 仅用于错误标签；reasoning 字段透传必须靠 `providerOptions.openai`（**字面量 `'openai'`**），不是 `'openai-responses'`。见 spec §4.3。

- [ ] **Step 8：构造 `extraProviderOptions` 并传给 executor**

`src/application/createApplication.ts:120` 之前插入构造逻辑：

```ts
const extraProviderOptions =
  provider === 'openai-responses'
    ? {
        openai: {
          reasoningEffort: ctx.config.agent.responses.reasoningEffort,
          reasoningSummary: ctx.config.agent.responses.reasoningSummary,
          store: false, // spec §9 决策：不在 OpenAI 服务端长期保留对话内容
        },
      }
    : undefined
```

`src/application/createApplication.ts:127` 之后（在 `executorFactory` 的 `createAiSdkExecutor` 调用对象内）追加：

```ts
...(extraProviderOptions ? { extraProviderOptions } : {}),
```

完整调用变成：

```ts
const executorFactory = (tools: ReturnType<typeof toolsBuilder>) =>
  createAiSdkExecutor({
    model: runtime.model,
    modelName: runtime.modelName,
    tools,
    maxSteps: ctx.config.agent.maxSteps,
    logger,
    ...(runtime.providerNameForOptions ? { providerName: runtime.providerNameForOptions } : {}),
    ...(extraProviderOptions ? { extraProviderOptions } : {}),
  })
```

- [ ] **Step 9：跑测试**

```bash
pnpm test -- src/application/createApplication.test.ts
pnpm typecheck
```

Expected：所有现有 + 新 2 用例全绿。

- [ ] **Step 10：Commit**

```bash
git add src/application/createApplication.ts src/application/createApplication.test.ts
git commit -m "feat(provider): wire 'openai-responses' provider via @ai-sdk/openai responses factory"
```

---

### Task 4：`AiSdkExecutor` 透传 `extraProviderOptions`

**Files:**
- Modify: `src/agent/AiSdkExecutor.ts:8-16`、`:312-328`
- Test: `src/agent/AiSdkExecutor.test.ts`

> 此 task **只做透传**，不改 usage 聚合（reasoningTokens 在 Phase 3 处理）。

- [ ] **Step 1：先写失败测试**

`src/agent/AiSdkExecutor.test.ts:74` 末（`createExecutor` helper 之后），新增专门测试 providerOptions 合并的 helper 与用例。在文件末尾 `describe` 内新增：

```ts
it('extraProviderOptions 与 providerName 的 stream_options 合并到 streamText', async () => {
  const calls: Array<Record<string, unknown>> = []
  const model = new MockLanguageModelV1({
    doStream: async (options) => {
      calls.push(options as unknown as Record<string, unknown>)
      return {
        stream: simulateReadableStream({
          chunks: [
            { type: 'response-metadata', id: 'r', modelId: 'mock-model' },
            { type: 'text-delta', textDelta: 'x' },
            {
              type: 'finish',
              finishReason: 'stop',
              usage: { promptTokens: 1, completionTokens: 1 },
            },
          ],
        }) as unknown as ReadableStream<never>,
        rawCall: { rawPrompt: null, rawSettings: {} },
      } as never
    },
  }) as unknown as LanguageModel

  const executor = createAiSdkExecutor({
    model,
    modelName: 'mock-model',
    tools: {},
    maxSteps: 4,
    logger: stubLogger(),
    providerName: 'openai-responses',
    extraProviderOptions: {
      openai: { reasoningEffort: 'medium', reasoningSummary: 'auto', store: false },
    },
  })

  await collect(
    executor.execute({
      messages: [{ role: 'user', content: 'hi' }],
      abortSignal: new AbortController().signal,
    }),
  )

  // ai-sdk 把 providerOptions 透到 doStream 的 providerMetadata 选项里。
  // 这里只断言 mock 至少被调用一次，且实际逻辑通路不抛错。
  expect(calls.length).toBeGreaterThan(0)
})
```

> 备注：ai-sdk MockLanguageModelV1 不直接暴露透传后的 providerOptions（封装在内部）。本测试主要验证 deps 接口接受新字段且不破坏既有路径。**断言透传到 wire 由 e2e（Task 10）通过 fetch 拦截完成。**

- [ ] **Step 2：跑 typecheck，确认 fail**

> 因为 `MockLanguageModelV1` 不直接暴露透传后的 providerOptions，单测层断言只是 `calls.length > 0`（运行不会自然变红）。让"先红"由 typecheck 来供给：`extraProviderOptions` 不在 `AiSdkExecutorDeps` 上时，新用例的 `createAiSdkExecutor({ ... extraProviderOptions: ... })` 会触发编译错误。

```bash
pnpm typecheck
```

Expected：FAIL — `Object literal may only specify known properties, and 'extraProviderOptions' does not exist in type 'AiSdkExecutorDeps'`。

- [ ] **Step 3：扩展 `AiSdkExecutorDeps`**

`src/agent/AiSdkExecutor.ts:1` 先把 import 改为：

```ts
import {
  streamText,
  type FinishReason,
  type LanguageModel,
  type ProviderMetadata,
  type ToolSet,
} from 'ai'
```

`src/agent/AiSdkExecutor.ts:15` 后（在 `providerName?: string` 之后、闭合 `}` 之前）追加：

```ts
// 由 createApplication 装配：当 provider='openai-responses' 时携带 { openai: { reasoningEffort, reasoningSummary, store } }。
// providerOptions 的 key 必须是 'openai' 字面量（@ai-sdk/openai 内部 parseProviderOptions 写死），不是 providerName。
extraProviderOptions?: ProviderMetadata
```

- [ ] **Step 4：在 streamText 调用前合并 providerOpts**

`src/agent/AiSdkExecutor.ts:312-328` 替换为：

```ts
try {
  // providerOptions 用于：
  //  - litellm 路径：注入 stream_options.include_usage（流式响应必须显式开启 usage）
  //  - openai-responses 路径：注入 reasoningEffort / reasoningSummary / store 三字段
  const providerOpts: ProviderMetadata = {
    ...(deps.providerName
      ? { [deps.providerName]: { stream_options: { include_usage: true } } }
      : {}),
    ...(deps.extraProviderOptions ?? {}),
  }
  const hasOpts = Object.keys(providerOpts).length > 0

  result = streamText({
    model: deps.model,
    ...(req.systemPrompt ? { system: req.systemPrompt } : {}),
    messages: req.messages,
    tools: deps.tools,
    maxSteps: deps.maxSteps,
    toolCallStreaming: true,
    abortSignal: req.abortSignal,
    ...(hasOpts ? { providerOptions: providerOpts } : {}),
  })
```

- [ ] **Step 5：跑测试与 typecheck**

```bash
pnpm test -- src/agent/AiSdkExecutor.test.ts
pnpm typecheck
```

Expected：所有用例通过（含原有用例）。

- [ ] **Step 6：Commit**

```bash
git add src/agent/AiSdkExecutor.ts src/agent/AiSdkExecutor.test.ts
git commit -m "feat(executor): pass extraProviderOptions through streamText"
```

---

### Task 5：Phase 1 出口验证

> Spec §8 Phase 1 出口：现有 `run-basic-reply` 在临时 workspace `provider=openai-responses` 下能跑通。

- [ ] **Step 1：手动准备 e2e 临时 workspace**

```bash
TMPDIR=$(mktemp -d /tmp/agent-slack-e2e-or.XXXXXX)
mkdir -p "$TMPDIR/.agent-slack"
cat > "$TMPDIR/.agent-slack/config.yaml" <<'YAML'
agent:
  provider: openai-responses
  model: gpt-5.4
  responses:
    reasoningEffort: medium
    reasoningSummary: auto
YAML
ln -s "$(pwd)/.agent-slack/.env.local" "$TMPDIR/.agent-slack/.env.local"
ln -s "$(pwd)/.env.e2e" "$TMPDIR/.env.e2e"
```

> 操作员预先确认 `.env.local` / `.env.e2e` 含 `LITELLM_BASE_URL`、`LITELLM_API_KEY`、`SLACK_BOT_TOKEN`、`SLACK_E2E_*` 等。

- [ ] **Step 2：在临时 workspace 跑 basic-reply e2e**

```bash
cd "$TMPDIR" && pnpm --dir "$OLDPWD" e2e basic-reply
```

Expected：assistant reply、usage message、done reaction 三个 matched 全 true。

> 若 LiteLLM 网关 `/responses` 端点对 `stream_options` 字段返回 unknown field 错误：从 `buildProviderRuntime` 的 `openai-responses` 分支返回值里去掉 `providerNameForOptions`（设为 `undefined`），跳过 stream_options 注入。phase 1 出口要先在这里暴露这个分歧。

- [ ] **Step 3：清理**

```bash
rm -rf "$TMPDIR"
cd "$OLDPWD"
```

- [ ] **Step 4：无代码改动则跳过 commit**

> 若 Step 2 触发了 LiteLLM 拒收 `stream_options` 的修复，commit 该修复并附测试断言 `providerNameForOptions===undefined`。

---

## Chunk 2: Phase 2 — Live Thinking emoji（Task 6）

> **出口**：本地 dev mode 下发推理类 prompt，Slack progress block 看到逐字打的"思考过程"，前缀 `:fluent-thinking-3d:`。

### Task 6：`SlackRenderer` progress block emoji

**Files:**
- Modify: `src/im/slack/SlackRenderer.ts:120`
- Test: `src/im/slack/SlackRenderer.test.ts`

- [ ] **Step 1：先写新失败测试**

> 现状：`SlackRenderer.test.ts` 既有用例**未覆盖** `reasoningTail` 渲染（grep `🤔`、`reasoningTail`、`fluent-thinking` 全 0 命中）。本步骤是新加一条单测，把 emoji 字面量做成可断言的红线。

定位 `src/im/slack/SlackRenderer.test.ts` 内 `describe('SlackRenderer progress message', ...)` 块（typically 在 `upsertProgressMessage` 相关 describe 里），在最后一条 `it` 之后新加一条：

```ts
it('reasoningTail 进度块前缀使用 :fluent-thinking-3d: emoji', async () => {
  const { web, calls } = mockWeb()
  const renderer = createSlackRenderer({ logger: stubLogger() })

  await renderer.upsertProgressMessage(web, 'C1', 't1', {
    status: '思考中…',
    activities: ['思考中…'],
    reasoningTail: '正在分析这个问题',
  })

  const post = (calls.find((c) => c.method === 'chat.postMessage') ??
    calls.find((c) => c.method === 'chat.update')) as
    | { args: { blocks?: Array<{ elements?: Array<{ text?: string }> }> } }
    | undefined

  const allText =
    post?.args.blocks
      ?.flatMap((b) => b.elements ?? [])
      .map((e) => e.text ?? '')
      .join('|') ?? ''

  expect(allText).toContain(':fluent-thinking-3d:')
  expect(allText).toContain('正在分析这个问题')
  expect(allText).not.toContain('🤔')
})
```

> `mockWeb` / `stubLogger` / `upsertProgressMessage` 的精确签名按文件已有用例对齐；如 progress upsert 在该文件里没现成 mock，参考 `describe` 块开头的现有 setup 复用。**executor 必须先 Read 一次完整文件确认 helper 名称再写**。

- [ ] **Step 2：跑测试，确认 fail**

```bash
pnpm test -- src/im/slack/SlackRenderer.test.ts
```

Expected：新用例 FAIL — 输出仍是 `🤔` 前缀，不含 `:fluent-thinking-3d:`。

- [ ] **Step 3：实现 emoji 替换**

`src/im/slack/SlackRenderer.ts:120` 当前：
```ts
blocks.push(buildContextBlock(`🤔 ${state.reasoningTail}`))
```

改为：
```ts
blocks.push(buildContextBlock(`:fluent-thinking-3d: ${state.reasoningTail}`))
```

- [ ] **Step 4：跑测试通过**

```bash
pnpm test -- src/im/slack/SlackRenderer.test.ts
```

Expected：所有用例通过。

- [ ] **Step 5：Commit**

```bash
git add src/im/slack/SlackRenderer.ts src/im/slack/SlackRenderer.test.ts
git commit -m "feat(slack): use :fluent-thinking-3d: emoji in reasoning progress block"
```

---

## Chunk 3: Phase 3 — Usage 行 `(N thinking)` + e2e（Task 7~10）

> **出口**：`pnpm e2e thinking-responses` 全绿。

### Task 7：`SessionUsageInfo` 加 reasoningTokens

**Files:**
- Modify: `src/core/events.ts:30-40`

- [ ] **Step 1：扩 modelUsage 元素类型**

`src/core/events.ts:30-40` 替换为：

```ts
export interface SessionUsageInfo {
  durationMs: number
  totalCostUSD: number
  modelUsage: Array<{
    model: string
    inputTokens: number
    outputTokens: number
    cachedInputTokens: number
    cacheHitRate: number
    reasoningTokens?: number
  }>
}
```

- [ ] **Step 2：typecheck**

```bash
pnpm typecheck
```

Expected：无新 error（可选字段不破坏现有读取点）。

- [ ] **Step 3：Commit**

```bash
git add src/core/events.ts
git commit -m "feat(events): add reasoningTokens to SessionUsageInfo.modelUsage"
```

---

### Task 8：`AiSdkExecutor` 提取与聚合 reasoningTokens

**Files:**
- Modify: `src/agent/AiSdkExecutor.ts:23-28`、`:184-203`、`:205-222`
- Test: `src/agent/AiSdkExecutor.test.ts`

- [ ] **Step 1：先写失败测试**

在 `src/agent/AiSdkExecutor.test.ts` 的 `describe('AiSdkExecutor 粗事件映射', ...)` 块内（在最后一个 `it` 后）追加 2 个用例：

```ts
it('finish 携带 providerMetadata.openai.reasoningTokens 时透出到 usage-info', async () => {
  const executor = createExecutor(
    createMockModel([
      [
        { type: 'response-metadata', id: 'resp_1', modelId: 'mock-model' },
        { type: 'reasoning', textDelta: 'thinking…' },
        { type: 'text-delta', textDelta: 'done' },
        {
          type: 'finish',
          finishReason: 'stop',
          usage: { promptTokens: 100, completionTokens: 200 },
          providerMetadata: { openai: { reasoningTokens: 132 } },
        },
      ],
    ]),
  )

  const events = await collect(
    executor.execute({
      messages: [{ role: 'user', content: 'hi' }],
      abortSignal: new AbortController().signal,
    }),
  )

  const usageInfo = events.find((e) => e.type === 'usage-info')
  expect(usageInfo?.type).toBe('usage-info')
  if (usageInfo?.type === 'usage-info') {
    expect(usageInfo.usage.modelUsage[0]?.reasoningTokens).toBe(132)
  }
})

// 注意：本用例验证"零值时字段缺省"，即 buildUsageInfo 必须用 spread 条件展开
//        `...(usage.reasoningTokens > 0 ? { reasoningTokens: usage.reasoningTokens } : {})`，
//        而**不能**写成 `reasoningTokens: usage.reasoningTokens`（那会显式赋 0、`'in'` 检查会过）。
it('providerMetadata 无 openai.reasoningTokens 时 modelUsage 不带 reasoningTokens 字段', async () => {
  const executor = createExecutor(
    createMockModel([
      [
        { type: 'response-metadata', id: 'resp_1', modelId: 'mock-model' },
        { type: 'text-delta', textDelta: 'plain' },
        {
          type: 'finish',
          finishReason: 'stop',
          usage: { promptTokens: 5, completionTokens: 5 },
          providerMetadata: { litellm: { cost: 0.01 } },
        },
      ],
    ]),
  )

  const events = await collect(
    executor.execute({
      messages: [{ role: 'user', content: 'hi' }],
      abortSignal: new AbortController().signal,
    }),
  )

  const usageInfo = events.find((e) => e.type === 'usage-info')
  if (usageInfo?.type === 'usage-info') {
    expect('reasoningTokens' in usageInfo.usage.modelUsage[0]!).toBe(false)
  }
})
```

- [ ] **Step 2：跑测试，确认 fail**

```bash
pnpm test -- src/agent/AiSdkExecutor.test.ts
```

Expected：FAIL — `reasoningTokens` 既没聚合也没透出。

- [ ] **Step 3：扩 `ModelUsageSnapshot`**

`src/agent/AiSdkExecutor.ts:23-28` 替换为：

```ts
interface ModelUsageSnapshot {
  inputTokens: number
  outputTokens: number
  cachedInputTokens: number
  reasoningTokens: number
  costUSD: number
}
```

- [ ] **Step 4：新增 `extractReasoningTokens` helper**

在 `src/agent/AiSdkExecutor.ts:182`（`toSafeInt` 函数之后、`updateUsage` 之前）插入：

```ts
// 从 finish chunk 的 providerMetadata 中提取 OpenAI Responses API 的 reasoning_tokens。
// 字段路径：providerMetadata.openai.reasoningTokens（@ai-sdk/openai 已 camelCase 映射）。
function extractReasoningTokens(providerMetadata: unknown): number {
  if (!providerMetadata || typeof providerMetadata !== 'object') return 0
  const openai = (providerMetadata as Record<string, unknown>).openai
  if (!openai || typeof openai !== 'object') return 0
  const v = (openai as Record<string, unknown>).reasoningTokens
  return toSafeInt(v)
}
```

- [ ] **Step 5：扩 `updateUsage`（聚合 reasoningTokens）**

`src/agent/AiSdkExecutor.ts:184-203` 替换为：

```ts
function updateUsage(
  agg: AggregatorState,
  modelName: string,
  usage: Record<string, unknown>,
  providerMetadata: unknown,
): void {
  const current = agg.modelUsage.get(modelName) ?? {
    inputTokens: 0,
    outputTokens: 0,
    cachedInputTokens: 0,
    reasoningTokens: 0,
    costUSD: 0,
  }

  agg.modelUsage.set(modelName, {
    inputTokens: current.inputTokens + toSafeInt(usage.promptTokens ?? usage.inputTokens),
    outputTokens: current.outputTokens + toSafeInt(usage.completionTokens ?? usage.outputTokens),
    cachedInputTokens: current.cachedInputTokens + toSafeInt(usage.cachedInputTokens),
    reasoningTokens: current.reasoningTokens + extractReasoningTokens(providerMetadata),
    costUSD: current.costUSD + (extractCostFromMetadata(providerMetadata) ?? 0),
  })
}
```

- [ ] **Step 6：扩 `buildUsageInfo`（条件写入）**

`src/agent/AiSdkExecutor.ts:205-222` 中 `modelUsage` map 替换为：

```ts
const modelUsage = Array.from(agg.modelUsage.entries()).map(([model, usage]) => ({
  model,
  inputTokens: usage.inputTokens,
  outputTokens: usage.outputTokens,
  cachedInputTokens: usage.cachedInputTokens,
  cacheHitRate: usage.inputTokens > 0 ? usage.cachedInputTokens / usage.inputTokens : 0,
  ...(usage.reasoningTokens > 0 ? { reasoningTokens: usage.reasoningTokens } : {}),
}))
```

- [ ] **Step 7：跑测试 + typecheck**

```bash
pnpm test -- src/agent/AiSdkExecutor.test.ts
pnpm typecheck
```

Expected：新 2 用例 + 既有用例全绿。注意既有用例可能匹配 `cacheHitRate: 0` 而不写 reasoningTokens — 通过 `..."reasoningTokens" in obj"` 风格断言。

- [ ] **Step 8：Commit**

```bash
git add src/agent/AiSdkExecutor.ts src/agent/AiSdkExecutor.test.ts
git commit -m "feat(executor): aggregate openai.reasoningTokens into SessionUsageInfo"
```

---

### Task 9：`SlackRenderer.formatUsageLine` 加 thinking 段

**Files:**
- Modify: `src/im/slack/SlackRenderer.ts:138-169`
- Test: `src/im/slack/SlackRenderer.test.ts`

- [ ] **Step 1：先写失败测试**

`src/im/slack/SlackRenderer.test.ts:522`（`describe('SlackRenderer postSessionUsage', ...)` 末块、最后 `it` 之后）追加 2 个用例：

```ts
it('reasoningTokens > 0 时 usage 行含 (N thinking) 段', async () => {
  const { web, calls } = mockWeb()
  const renderer = createSlackRenderer({ logger: stubLogger() })

  await renderer.postSessionUsage(web, 'C1', 't1', {
    durationMs: 5_400,
    totalCostUSD: 0.013,
    modelUsage: [
      {
        model: 'gpt-5.4',
        inputTokens: 1200,
        outputTokens: 200,
        cachedInputTokens: 0,
        cacheHitRate: 0,
        reasoningTokens: 132,
      },
    ],
  })

  const post = calls.find((c) => c.method === 'chat.postMessage') as
    | { args: { text?: string } }
    | undefined
  expect(post?.args.text).toContain('1.4k tokens')
  expect(post?.args.text).toContain('(132 thinking)')
})

it('reasoningTokens 缺省/为 0 时 usage 行不含 thinking 段', async () => {
  const { web, calls } = mockWeb()
  const renderer = createSlackRenderer({ logger: stubLogger() })

  await renderer.postSessionUsage(web, 'C1', 't1', {
    durationMs: 1_000,
    totalCostUSD: 0,
    modelUsage: [
      {
        model: 'gpt-5.4',
        inputTokens: 100,
        outputTokens: 50,
        cachedInputTokens: 0,
        cacheHitRate: 0,
      },
    ],
  })

  const post = calls.find((c) => c.method === 'chat.postMessage') as
    | { args: { text?: string } }
    | undefined
  expect(post?.args.text).not.toContain('thinking')
})
```

- [ ] **Step 2：跑测试确认 fail**

```bash
pnpm test -- src/im/slack/SlackRenderer.test.ts
```

Expected：FAIL — `(132 thinking)` 段未生成。

- [ ] **Step 3：在 `formatUsageLine` 加段**

`src/im/slack/SlackRenderer.ts:151` 之后（在 `cacheHitRate` 段后、`parts.push(segment)` 之前）插入：

```ts
if (model.reasoningTokens && model.reasoningTokens > 0) {
  segment += ` (${formatTokenCount(model.reasoningTokens)} thinking)`
}
```

最终循环体：

```ts
for (const model of usage.modelUsage) {
  const total = model.inputTokens + model.outputTokens
  let segment = `${model.model}: ${formatTokenCount(total)} tokens`

  if (model.cacheHitRate > 0) {
    segment += ` (${Math.round(model.cacheHitRate * 100)}% cache)`
  }

  if (model.reasoningTokens && model.reasoningTokens > 0) {
    segment += ` (${formatTokenCount(model.reasoningTokens)} thinking)`
  }

  parts.push(segment)
}
```

- [ ] **Step 4：跑测试**

```bash
pnpm test -- src/im/slack/SlackRenderer.test.ts
```

Expected：所有用例通过。

- [ ] **Step 5：Commit**

```bash
git add src/im/slack/SlackRenderer.ts src/im/slack/SlackRenderer.test.ts
git commit -m "feat(slack): append (N thinking) segment to usage line when reasoning tokens present"
```

---

### Task 10：新建 `run-thinking-responses.ts` live e2e

**Files:**
- Create: `src/e2e/live/run-thinking-responses.ts`

> 模式参考 `src/e2e/live/run-basic-reply.ts` 与 `src/e2e/live/run-tool-progress.ts`。要点：
> 1. monkey-patch `globalThis.fetch` 拦截对 `${LITELLM_BASE_URL}/responses` 的 POST，记录 body 字符串
> 2. 创建 tmp workspace（`.agent-slack/config.yaml` 配 `provider=openai-responses`），symlink `.env.local`/`.env.e2e`
> 3. `createLiveE2EContext(runId, { workspaceDir: tmp })` 把 application 绑到 tmp workspace
> 4. trigger 含强 thinking 信号的 prompt（如让模型解 7 位整数因数分解）
> 5. 校验：assistant reply 出现 `THINKING_OK <runId>`、done reaction、usage 文本含 `(N thinking)`、捕获到的 fetch 全部命中 `/responses`、body 含 `"reasoning":{"effort":"medium","summary":"auto"}` 与 `"store":false`、未出现对 `/chat/completions` 的 POST

- [ ] **Step 1：写 scenario 骨架**

新文件 `src/e2e/live/run-thinking-responses.ts`：

```ts
import './load-e2e-env.ts'

import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { consola } from 'consola'
import type { LiveE2EScenario } from './scenario.ts'
import { runDirectly } from './scenario.ts'
import {
  createLiveE2EContext,
  delay,
  findReplyContaining,
  findUsageMessage,
  hasReaction,
  hasUsageMessage,
  waitForThread,
  writeScenarioResult,
} from './scenario-utils.ts'

interface ThinkingResponsesResult {
  assistantReplyText?: string
  failureMessage?: string
  matched: {
    assistantReplied: boolean
    doneReactionObserved: boolean
    usageObserved: boolean
    thinkingTailObserved: boolean
    responsesEndpointHit: boolean
    chatCompletionsNotHit: boolean
    reasoningEffortInBody: boolean
    storeFalseInBody: boolean
  }
  passed: boolean
  runId: string
  rootMessageTs?: string
}

interface CapturedRequest {
  url: string
  body: string
}

const realFetch = globalThis.fetch

function installFetchSpy(litellmBaseUrl: string): {
  captured: CapturedRequest[]
  uninstall: () => void
} {
  const captured: CapturedRequest[] = []
  globalThis.fetch = async function spied(input: RequestInfo | URL, init?: RequestInit) {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    if (url.startsWith(litellmBaseUrl)) {
      let body = ''
      if (typeof init?.body === 'string') body = init.body
      else if (init?.body instanceof Uint8Array) body = Buffer.from(init.body).toString('utf8')
      captured.push({ url, body })
    }
    return realFetch(input as RequestInfo, init)
  } as typeof fetch
  return {
    captured,
    uninstall: () => {
      globalThis.fetch = realFetch
    },
  }
}

async function prepareTempWorkspace(): Promise<string> {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-slack-thinking-'))
  await fs.mkdir(path.join(tmp, '.agent-slack'), { recursive: true })
  await fs.writeFile(
    path.join(tmp, '.agent-slack', 'config.yaml'),
    [
      'agent:',
      '  provider: openai-responses',
      '  model: gpt-5.4',
      '  responses:',
      '    reasoningEffort: medium',
      '    reasoningSummary: auto',
      '',
    ].join('\n'),
    'utf8',
  )
  // 复用宿主 workspace 的 .env.local 与 .env.e2e（load-e2e-env 已经把 env 装进 process.env，
  // 这里 symlink 仅是为了让 createApplication.loadWorkspaceEnv 在 tmp workspace 下也找得到，
  // 不强求；symlink 失败时忽略）
  for (const rel of ['.agent-slack/.env.local', '.env.e2e', '.env']) {
    const src = path.join(process.cwd(), rel)
    const dst = path.join(tmp, rel)
    try {
      await fs.mkdir(path.dirname(dst), { recursive: true })
      await fs.symlink(src, dst)
    } catch {
      // ignore
    }
  }
  return tmp
}

async function main(): Promise<void> {
  const runId = randomUUID()
  const result: ThinkingResponsesResult = {
    matched: {
      assistantReplied: false,
      doneReactionObserved: false,
      usageObserved: false,
      thinkingTailObserved: false,
      responsesEndpointHit: false,
      chatCompletionsNotHit: true, // 默认假定没命中，captured 一旦出现则置 false
      reasoningEffortInBody: false,
      storeFalseInBody: false,
    },
    passed: false,
    runId,
  }

  const litellmBaseUrl = (process.env.LITELLM_BASE_URL ?? '').trim()
  if (!litellmBaseUrl) throw new Error('缺少环境变量 LITELLM_BASE_URL')

  const tmpWorkspace = await prepareTempWorkspace()
  const spy = installFetchSpy(litellmBaseUrl)

  let ctx: Awaited<ReturnType<typeof createLiveE2EContext>> | undefined
  let caughtError: unknown
  try {
    ctx = await createLiveE2EContext(runId, { workspaceDir: tmpWorkspace })
    await ctx.application.start()
    await delay(3_000)

    const rootMessage = await ctx.triggerClient.postMessage({
      channel: ctx.channelId,
      text: [
        `<@${ctx.botUserId}> THINKING_E2E ${runId}`,
        // 让模型有非平凡的推理量；不要求工具调用。
        '请逐步推理回答：从 1 到 100 中所有不能被 3 或 5 整除的数的总和是多少？只回答最后一个数字。',
        `回复必须以 "THINKING_OK ${runId}: " 开头，紧跟数字答案，不要其他文本。`,
      ].join('\n'),
      unfurl_links: false,
      unfurl_media: false,
    })
    result.rootMessageTs = rootMessage.ts

    await waitForThread(ctx, rootMessage.ts, async (messages) => {
      const reply = findReplyContaining(messages, rootMessage.ts, `THINKING_OK ${runId}`)
      if (reply) {
        result.assistantReplyText = reply.text ?? ''
        result.matched.assistantReplied = true
      }
      result.matched.usageObserved = hasUsageMessage(messages, rootMessage.ts)
      const usage = findUsageMessage(messages, rootMessage.ts)
      result.matched.thinkingTailObserved = /\(\d+(?:\.\d+)?k? thinking\)/.test(usage?.text ?? '')
      result.matched.doneReactionObserved = await hasReaction(
        ctx!.botClient,
        ctx!.channelId,
        rootMessage.ts,
        'white_check_mark',
      )

      return (
        result.matched.assistantReplied &&
        result.matched.usageObserved &&
        result.matched.thinkingTailObserved &&
        result.matched.doneReactionObserved
      )
    })

    // wire 级断言
    const responsesHits = spy.captured.filter((c) => c.url.endsWith('/responses'))
    const chatCompletionsHits = spy.captured.filter((c) => c.url.endsWith('/chat/completions'))
    result.matched.responsesEndpointHit = responsesHits.length > 0
    result.matched.chatCompletionsNotHit = chatCompletionsHits.length === 0
    result.matched.reasoningEffortInBody = responsesHits.some(
      (c) => c.body.includes('"reasoning"') && c.body.includes('"effort":"medium"'),
    )
    result.matched.storeFalseInBody = responsesHits.some((c) => /"store"\s*:\s*false/.test(c.body))

    assertResult(result)
    result.passed = true
    consola.info('Live thinking-responses E2E passed.')
  } catch (error) {
    result.failureMessage = error instanceof Error ? error.message : String(error)
    caughtError = error
  } finally {
    spy.uninstall()
    await writeScenarioResult('thinking-responses', result).catch((error) => {
      consola.error('Failed to persist result:', error)
    })
    if (ctx) {
      await ctx.application.stop().catch((error) => {
        consola.error('Failed to stop application:', error)
      })
    }
    await fs.rm(tmpWorkspace, { recursive: true, force: true }).catch(() => {})
  }

  if (caughtError) throw caughtError
}

function assertResult(result: ThinkingResponsesResult): void {
  const failures: string[] = []
  if (!result.matched.assistantReplied) failures.push('assistant reply not observed')
  if (!result.matched.doneReactionObserved) failures.push('done reaction not observed')
  if (!result.matched.usageObserved) failures.push('usage message not observed')
  if (!result.matched.thinkingTailObserved) failures.push('(N thinking) segment not in usage line')
  if (!result.matched.responsesEndpointHit) failures.push('/responses endpoint never hit')
  if (!result.matched.chatCompletionsNotHit) failures.push('/chat/completions still being hit')
  if (!result.matched.reasoningEffortInBody) failures.push('reasoning effort not in request body')
  if (!result.matched.storeFalseInBody) failures.push('store:false not in request body')
  if (failures.length > 0) {
    throw new Error(`Live thinking-responses E2E failed: ${failures.join('; ')}`)
  }
}

export const scenario: LiveE2EScenario = {
  id: 'thinking-responses',
  title: 'Thinking via Responses',
  description:
    'Mention the bot with provider=openai-responses; verify reasoning tail in usage line, /responses endpoint, and body fields.',
  keywords: ['thinking', 'reasoning', 'openai', 'responses'],
  run: main,
}

runDirectly(scenario)
```

- [ ] **Step 2：在 e2e CLI 注册（自动 import 即可）**

确认 `src/e2e/live/cli.ts` 是否需要显式 import 列表。若有，按字母序加 `'./run-thinking-responses.ts'`。

```bash
grep -n "run-" src/e2e/live/cli.ts
```

按结果决定是否要在 cli.ts 加一行。

- [ ] **Step 3：本地跑通 e2e**

操作员预先确保宿主 workspace 的 `.env.local` 含 `LITELLM_*` 与 `SLACK_E2E_*` 凭证、Slack 工作区已上传 `:fluent-thinking-3d:` 自定义 emoji。

```bash
pnpm e2e thinking-responses
```

Expected：`Live thinking-responses E2E passed.`，`.agent-slack/e2e/thinking-responses-result.json` `passed: true`，所有 8 个 matched 全 true。

- [ ] **Step 4：Commit**

```bash
git add src/e2e/live/run-thinking-responses.ts
# 若 cli.ts 需要登记则一并加入：
# git add src/e2e/live/cli.ts
git commit -m "test(e2e): add live thinking-responses scenario for openai-responses provider"
```

---

## Final 检查清单

- [ ] `pnpm typecheck` 通过
- [ ] `pnpm test` 全绿
- [ ] `pnpm lint` 通过
- [ ] `pnpm e2e basic-reply`（默认 litellm workspace）通过 — 反向验证 litellm 路径无回归
- [ ] `pnpm e2e thinking-responses` 通过
- [ ] `git log --oneline` 看到 ~7 个小 commit（按 task 切分）
- [ ] 文档更新：把本计划标记为已完成或追加 `**状态**：已实施` 到 spec 头部（spec 维护人决定）

---

## 关键不变量回顾

1. `agent.provider='litellm'` / `'anthropic'` 路径**完全不动**：装配分支独立、`extraProviderOptions` 仅对 openai-responses 注入、`reasoningTokens` 字段在 modelUsage 上是可选的
2. `providerOptions` 透传 key 是字面量 `'openai'`（不是 `'openai-responses'`），由 createApplication 装配时直接构造好对象
3. sub-agent（compact / selfImprove）**不**显式传 `providerOptions.openai.reasoningEffort`，所以 openai-responses 路径下 sub-agent 不触发 reasoning，token 消耗与原 chat/completions 几乎一致
4. `:fluent-thinking-3d:` 是 Slack 工作区已上传的自定义 emoji，用户已在工作区准备好，无需代码补图
5. 回滚开关：`config.yaml` 把 `provider: openai-responses` 改回 `provider: litellm`，重启 daemon。无数据迁移
