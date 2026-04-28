# OpenAI Responses API 接入：让 Slack 看到 Thinking

**日期**：2026-04-29
**状态**：草案待评审
**关联**：
- 继承 [`2026-04-21-agent-provider-adapters.md`](./2026-04-21-agent-provider-adapters.md) 的 provider 装配抽象
- 沿用 [`2026-04-19-slack-render-flow-redesign.md`](./2026-04-19-slack-render-flow-redesign.md) 的粗粒度事件与 progress block 通道

---

## 1. 背景与动机

### 1.1 现状

当前 `agent.provider='litellm'` 通过 `@ai-sdk/openai-compatible` 走 LiteLLM 网关的 `/chat/completions` 端点。该端点在带 `tools` 时**静默丢弃 `reasoning_effort`**（OpenAI 上游限制，见 BerriAI/litellm#23914），导致：

- gpt-5.4 在 Slack 真实路径（始终带工具）下 `reasoning_tokens` 始终为 0
- 客户端拿不到 reasoning summary 文字，Slack 用户看不到模型思考过程
- 与 codex 终端体验脱节（codex 走 OpenAI Responses API，可逐字看 thinking）

### 1.2 目标

新增第三个 provider `'openai-responses'`，通过 `@ai-sdk/openai` 的 `provider.responses(modelId)` factory 走 LiteLLM 网关的 `/responses` 端点（已实测网关支持转发，带 tools + reasoning 时 reasoning_tokens > 0、output 含完整 reasoning summary 文字）。

具体可观测产出：
- Slack progress block 在模型推理阶段逐字流出 reasoning summary，前缀 `:fluent-thinking-3d:` 自定义 emoji
- 终态 usage 行在 `gpt-5.4: 1.4k tokens` 后追加 `(132 thinking)` 子段，明示有多少 token 是 reasoning
- `agent.provider='litellm'` / `'anthropic'` 路径完全不动；现有部署零影响

### 1.3 非目标

- ❌ 不实现 prompt-engineered ReAct（Thought/Action/Observation 文本协议）
- ❌ 不使用 `previous_response_id` 做对话状态托管（保持 stateless 全量历史）
- ❌ 不暴露 OpenAI 内置工具（web_search / file_search / computer_use）
- ❌ 不为 anthropic provider 加 thinking text 显示（Claude 走 thinking blocks，是另一条路径）
- ❌ 不修改 SlackEventSink、ConversationOrchestrator、SessionStore、agents/compact、agents/selfImprove

---

## 2. 总体方案

```
Slack 用户 → SlackAdapter → ConversationOrchestrator
  → AiSdkExecutor.execute()                   ← 不改
    → streamText({ model: runtime.model, tools, providerOptions })
      → 现有：runtime.model = createOpenAICompatible(...).chatModel(modelName)
              → POST /chat/completions       ← 现有路径
      → 新增：runtime.model = createOpenAI(...).responses(modelName)
              → POST /responses              ← 新路径
                ← reasoning_summary_text.delta SSE 事件
                ← 自动映射成 ai-sdk type:'reasoning' stream part
                  → AiSdkExecutor 现有 case 'reasoning' 分支接住
                    → emit activity-state { reasoningTail }
                      → SlackRenderer progress block 渲染
                        ":fluent-thinking-3d: ${reasoningTail}"
            ← finish chunk providerMetadata.openai.reasoningTokens
              → AiSdkExecutor.updateUsage 累加
                → SessionUsageInfo.modelUsage[].reasoningTokens
                  → SlackRenderer formatUsageLine 追加 "(N thinking)"
```

**关键不变量**：`AgentExecutor` 接口不动；`SessionUsageInfo` 仅扩字段；`SlackRenderer` 仅扩段位与改 emoji 字面量。其他模块完全无感。

---

## 3. Config Schema

### 3.1 `src/workspace/config.ts`

```ts
agent: z.object({
  // 既有字段不动
  name: z.string().default('default'),
  model: z.string().default('gpt-5.4'),
  maxSteps: z.number().int().positive().default(50),

  // provider 枚举扩展：新增 'openai-responses'
  provider: z.enum(['litellm', 'anthropic', 'openai-responses']).default('litellm'),

  // 新增子字段：仅 provider='openai-responses' 时实际生效；其他 provider 装配代码不读，
  // 但 zod schema 接受字段写在 yaml 里不报错也不 warning（让用户提前写好将来切 provider）
  responses: z
    .object({
      // OpenAI 推理预算档位
      reasoningEffort: z.enum(['low', 'medium', 'high']).default('medium'),
      // 是否在响应里附带 reasoning summary 文字
      // - 'auto'：模型自决（默认推荐，给 :fluent-thinking-3d: progress 显示用）
      // - 'concise' / 'detailed'：强制输出，长度档位
      reasoningSummary: z.enum(['auto', 'concise', 'detailed']).default('auto'),
    })
    .default({}),

  context: z.object({ /* 不动 */ }).default({}),
}).default({})
```

### 3.2 用户 yaml

```yaml
agent:
  provider: openai-responses    # 切到新路径
  model: gpt-5.4
  responses:                    # 全用默认即可省略整段
    reasoningEffort: medium
    reasoningSummary: auto
```

向后兼容：未声明 `provider` 字段时仍 `litellm`，零行为变化。

---

## 4. Provider 装配

### 4.1 依赖

`package.json` 新增 `@ai-sdk/openai@^1.3.24`。已验证：
- 提供 `provider.responses(modelId)` factory
- `OpenAIResponsesModelId` 含 `(string & {})`，接受任意模型名（如 `gpt-5.4`）
- `OpenAIProviderSettings` 支持 `baseURL` / `apiKey` / `headers` / `compatibility` / `fetch`
- 与 `ai@^4.0.0` 兼容（peerDeps `zod ^3`）

**版本下限关键**：v1.3.24 的 `getResponsesModelConfig`（`dist/index.js:2624`）把 `gpt-5*` 列入 `isReasoningModel`：

```js
if (modelId.startsWith("o") || modelId.startsWith("gpt-5")) { ... isReasoningModel: true ... }
```

v1.3.22 及更早只检测 `startsWith("o")`，`gpt-5.4` 不会触发 reasoning 字段注入到请求体——会导致这个 spec 的所有 thinking 表现完全无效。**实施时必须 ≥ 1.3.24**。

### 4.2 `src/application/createApplication.ts`

`AgentProvider` 类型扩展为 `'litellm' | 'anthropic' | 'openai-responses'`。

`ProviderEnv` 增加 openai-responses 变体（复用 LiteLLM 凭证）：

```ts
type ProviderEnv =
  | { provider: 'litellm', litellmBaseUrl, litellmApiKey, providerName: 'litellm', secrets }
  | { provider: 'anthropic', anthropicApiKey, anthropicBaseUrl?, secrets }
  | { provider: 'openai-responses', litellmBaseUrl, litellmApiKey, secrets }   // 新增
```

`loadProviderEnv('openai-responses')` 读取 `LITELLM_BASE_URL` + `LITELLM_API_KEY`（与 litellm 分支同源，零 env 改动）。

`buildProviderRuntime` 加第三分支：

```ts
if (provider === 'openai-responses' && env.provider === 'openai-responses') {
  const p = createOpenAI({
    baseURL: env.litellmBaseUrl,
    apiKey: env.litellmApiKey,
    name: 'openai-responses',
    compatibility: 'compatible',  // 第三方网关需要这个，避免 strict 模式发不被 LiteLLM 支持的字段
  })
  return {
    model: p.responses(modelName),
    modelName,
    providerNameForOptions: 'openai-responses',
  }
}
```

### 4.3 配置透到模型（**关键 key 名修订**）

`@ai-sdk/openai` 内部用 `parseProviderOptions({ provider: "openai", providerOptions, ... })` 取 reasoning 相关字段（`dist/index.js:2087`）——这个 `provider` 键是**写死的字面量 `"openai"`**，跟 `createOpenAI({ name: 'openai-responses' })` 里的 `name` 无关（`name` 只用于错误标签和 `provider` 字符串展示）。

也就是说：`providerOptions['openai-responses']` 会被**静默忽略**。**必须用 `providerOptions.openai`**。

为不冲淡 litellm 路径的 `providerOptions[providerName].stream_options` 机制，本期在 `AiSdkExecutorDeps` 加一个新的可选字段 `extraProviderOptions?: ProviderMetadata`，由 createApplication 在装配时直接构造好整个 providerOptions 对象传进来：

```ts
// createApplication.ts 内
const extraProviderOptions =
  provider === 'openai-responses'
    ? {
        openai: {
          reasoningEffort: ctx.config.agent.responses.reasoningEffort,
          reasoningSummary: ctx.config.agent.responses.reasoningSummary,
          store: false,    // §9.2 决策：不在 OpenAI 服务端长期保留对话内容
        },
      }
    : undefined

createAiSdkExecutor({
  model: runtime.model,
  ...
  ...(runtime.providerNameForOptions ? { providerName: runtime.providerNameForOptions } : {}),
  ...(extraProviderOptions ? { extraProviderOptions } : {}),
})
```

```ts
// AiSdkExecutor.ts 内 streamText 调用前合并：
const providerOpts: ProviderMetadata = {
  ...(deps.providerName
    ? { [deps.providerName]: { stream_options: { include_usage: true } } }
    : {}),
  ...(deps.extraProviderOptions ?? {}),
}
const hasOpts = Object.keys(providerOpts).length > 0
result = streamText({
  ...
  ...(hasOpts ? { providerOptions: providerOpts } : {}),
})
```

注意：openai-responses 路径下 `providerNameForOptions` 应保留为 `'openai-responses'`（litellm 路径仍 `'litellm'`，anthropic 仍 `undefined`）——这个字段对 reasoning 透传无效，但保持现有 `stream_options` 透传机制对 LiteLLM 网关是否仍需 include_usage 这一行为保留兼容（实测 /responses 端点 finish chunk 已含 usage，理论上不需要 stream_options 强制；但保留无害）。如果 LiteLLM 在 /responses 端点拒绝 `stream_options` 字段，phase 1 实测会暴露，调整为对 openai-responses 不写 `providerName` 即可。

### 4.4 Sub-agent 共享 runtime

具体调用点（**实施时 grep 确认**）：

| 文件 | 取 model 的方式 |
|---|---|
| `src/agents/compact/index.ts` | `createCompactAgent({ model: runtime.model, logger })` |
| `src/agents/selfImprove/collectorAgent.ts` | `createSelfImproveCollector(...)` 内部接受 model |
| `src/agents/selfImprove/generatorAgent.ts` | `createSelfImproveGenerator()` |
| `src/agents/selfImprove/semanticDedupAgent.ts` | `createSemanticDedup({ model: runtime.model, logger })` |

均在 `createApplication.ts:88-91` 一带一次性注入。本设计不改这些文件——它们直接复用 `runtime.model`，自动走 `/responses` + 同 `reasoningEffort`。这些 agent 内部不订阅 `type:'reasoning'` stream part，相关数据自然丢弃。

但它们没有显式传 `providerOptions.openai`——这意味着 sub-agent 调用**不会**带 reasoningEffort 字段，所以**不会触发 reasoning**。结果：sub-agent 走 /responses 端点但无 reasoning 行为，token 消耗与原来 chat/completions 几乎一致。

这其实**比"共享 effort"更省**，符合"sub-agent 不需要思考"的直觉。

代价：sub-agent 调用走 /responses 而非 chat/completions，路径不同但功能等价；ai-sdk @openai 已自动处理两套 API 之间的请求/响应映射差异。

校验方式：phase 1 出口跑现有 `run-compact-command` e2e 默认改 `provider=openai-responses` 应仍能通过。

---

## 5. Live Thinking 显示（progress block）

### 5.1 数据通路（已存在）

`@ai-sdk/openai` responses provider 把 `response.reasoning_summary_text.delta` SSE 事件映射成 `type: 'reasoning'` 的 stream part（源码佐证：`@ai-sdk/openai@1.3.24/dist/index.js:2431-2436`）。**正好命中 `AiSdkExecutor.ts` 现有 case 分支**（`src/agent/AiSdkExecutor.ts:357` `case 'reasoning':`）。聚合器累计 `currentReasoning`，节流 emit `activity-state { reasoningTail: <最后 80 字符> }`，SlackEventSink 触发 progress upsert，SlackRenderer 渲染 context block。

### 5.2 唯一改动点：`src/im/slack/SlackRenderer.ts:120`

```ts
// 旧
blocks.push(buildContextBlock(`🤔 ${state.reasoningTail}`))
// 新
blocks.push(buildContextBlock(`:fluent-thinking-3d: ${state.reasoningTail}`))
```

`:fluent-thinking-3d:` 是用户已上传到 Slack 工作区的自定义 emoji（256×256 PNG，Microsoft Fluent 3D 黄脸思考表情）。

---

## 6. Usage 行 `(N thinking)` 段

### 6.1 数据通路（新增）

OpenAI `/responses` 响应里 `output_tokens_details.reasoning_tokens` 被 ai-sdk 自动塞进 finish chunk 的 `providerMetadata.openai.reasoningTokens`。

源码佐证（`@ai-sdk/openai@1.3.24/dist/index.js:2455-2458`，`isResponseFinishedChunk` 处）：

```js
reasoningTokens = value.response.usage.output_tokens_details?.reasoning_tokens ?? reasoningTokens;
```

`dist/index.js:2474-2480`，flush 时拼装 finish chunk：

```js
controller.enqueue({
  type: "finish",
  finishReason,
  usage: { promptTokens, completionTokens },
  ...(cachedPromptTokens != null || reasoningTokens != null) && {
    providerMetadata: {
      openai: { responseId, cachedPromptTokens, reasoningTokens }
    }
  }
});
```

`step-finish.providerMetadata.openai.reasoningTokens` 是 camelCase，可直接读。

### 6.2 `src/core/events.ts`

```ts
SessionUsageInfo.modelUsage[].reasoningTokens?: number   // 新增字段，仅 >0 才有
```

### 6.3 `src/agent/AiSdkExecutor.ts`

```ts
interface ModelUsageSnapshot {
  inputTokens: number
  outputTokens: number
  cachedInputTokens: number
  reasoningTokens: number   // 新增，聚合用，初始 0
  costUSD: number
}

function extractReasoningTokens(providerMetadata: unknown): number {
  // 读 providerMetadata.openai.reasoningTokens；未提供时返 0
}

function updateUsage(...) {
  // 聚合 reasoningTokens 累加
}

function buildUsageInfo(...) {
  // 仅 reasoningTokens > 0 时把字段写入 modelUsage[]
}
```

### 6.4 `src/im/slack/SlackRenderer.ts` `formatUsageLine`

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

最终 Slack 看到（举例）：
```
:agent_time: 5.4s · $0.013 · gpt-5.4: 1.4k tokens (132 thinking) · :agent_memory: 1 memory · :agent_tool: 3 tools
```

**双括号视觉考量**：若同一 model 段同时触发 `(<X>% cache)` 和 `(N thinking)`，会出现：

```
gpt-5.4: 1.4k tokens (62% cache) (132 thinking)
```

接受此形态——括号语义边界清晰（一是命中率、一是思考子集），且同时出现要求模型既高 cache hit 又有 reasoning，实际不常见。如未来视觉问题再合并成 `(62% cache · 132 thinking)`。

### 6.5 语义说明

`reasoning_tokens` 是 `output_tokens` 的**子集**（OpenAI 规范）。`1.4k tokens` 已包含 132 reasoning。括号注法明示"这 1.4k 里有 132 是思考"，不会被理解成额外消耗。

---

## 7. 测试计划

### 7.1 单测

| 文件 | 用例 |
|---|---|
| `src/workspace/config.test.ts` | 默认 provider=litellm 时 `agent.responses` 取默认值；`provider=openai-responses` 解析 OK；`reasoningEffort` 非法枚举报错 |
| `src/application/createApplication.test.ts` | `provider=openai-responses` 时调 `createOpenAI`（不调 `createOpenAICompatible`）、`baseURL` 来自 `LITELLM_BASE_URL`、调用 `p.responses(modelId)` |
| `src/agent/AiSdkExecutor.test.ts` | mock `step-finish.providerMetadata={openai:{reasoningTokens:132}}`，断言 `SessionUsageInfo.modelUsage[0].reasoningTokens===132`；providerMetadata 无 reasoningTokens 时该字段缺省 |
| `src/im/slack/SlackRenderer.test.ts` | 现有 `🤔` 断言改 `:fluent-thinking-3d:`；usage 行 `reasoningTokens>0` 时含 `(132 thinking)`；缺省/为 0 时不带括号段 |

### 7.2 Live e2e：`src/e2e/live/run-thinking-responses.ts`（新建）

走 Slack 全链路，临时 workspace 配 `provider=openai-responses`：

| 断言 | 验证 |
|---|---|
| Slack thread reply 含 `THINKING_OK <runId>` | 端到端模型回复正常 |
| done reaction（白勾） | lifecycle 完成 |
| usage message 正则匹配 `\(\d+ thinking\)` | reasoning_tokens 真透回 Slack 显示 |
| 拦截到的请求 URL 以 `/responses` 结尾、不是 `/chat/completions` | 确认走对端点 |
| 整轮拦截无任何 `/chat/completions` POST | 反向兜底，防止 fallback 到旧端点而我们不知 |
| 拦截到的 body 含 `"reasoning":{"effort":"medium","summary":"auto"}` 与 `"store":false` | 配置真透传到 wire |

**fetch 注入方式**：在 e2e 入口 `monkey-patch globalThis.fetch`（与现有 `run-thinking.ts`<sup>1</sup> 同模式），因为 `createOpenAI` 默认走 `globalThis.fetch`（peer dep `@ai-sdk/provider-utils` 的 `getOriginalFetch` helper 取 globalThis.fetch）。监听对 `LITELLM_BASE_URL/responses` 的 POST，记录 body 字符串。

<sup>1</sup> 这文件在之前的回滚中被删了，此 e2e 是全新建。模式参考之前 git log 里的同名文件。

### 7.3 不动的测试

`run-basic-reply` / `run-tool-progress` / `run-context-pruning-no-llm` / `run-compact-*` / `run-channel-task-*` 等所有现有 e2e 默认 provider=litellm 不变，不受影响。

---

## 8. 推进顺序（最小可验证链路 → 渐进增强）

按 CLAUDE.md 的 plan 文档拆分原则，分三个 phase。

### Phase 1 — 端点切通

依赖、config schema、provider 装配、executor 透传 providerOptions。

出口：
- 现有 `run-basic-reply` 在临时 workspace `provider=openai-responses` 下能跑通（reasoning summary 是否显示暂不验证）
- **显式确认**：LiteLLM 网关 `/responses` 端点是否接受 `stream_options` 字段。若拒绝则 openai-responses 路径下不写 `providerName`（跳过 stream_options 注入）。动作：phase 1 e2e 跑时看 LiteLLM 是否报 unknown field 错误，无报错保留现状

### Phase 2 — Live Thinking progress 显示

`SlackRenderer.ts:120` 改 emoji + 改/加单测。

出口：本地 dev mode 下发推理类 prompt，Slack progress block 看到逐字打的"思考过程"前面有 `:fluent-thinking-3d:`。

### Phase 3 — Usage 行 `(N thinking)` + e2e

类型扩字段、AiSdkExecutor 提取 reasoningTokens、SlackRenderer 追加段、新建 `run-thinking-responses.ts` e2e。

出口：`pnpm e2e thinking-responses` 全绿。

---

## 9. 风险与回滚

### 9.1 已知风险

| 风险 | 缓解 |
|---|---|
| 成本上浮（reasoning_tokens 计费） | medium 默认是 OpenAI 推荐档位；用户可降到 low |
| sub-agent 路径变化（chat/completions → responses） | 接受。sub-agent 不显式传 `providerOptions.openai.reasoningEffort`，所以不会触发 reasoning，token 消耗几乎不变；ai-sdk 自动处理两套 API 之间请求/响应映射 |
| 网关 LiteLLM `/responses` 转发出问题 | 已实测通过；e2e 持续验证 |
| 数据驻留 | 硬编码 `store: false`，每次请求不在 OpenAI 服务端长期保留 |
| @ai-sdk/openai v1.3.24 API 不稳 | 锁版本 `^1.3.24`；CI typecheck 兜底 |
| 与 anthropic / litellm 路径相互影响 | 三个分支完全独立，无共享 runtime；单测覆盖装配逻辑 |

### 9.2 回滚

唯一开关：`config.yaml` 把 `provider: openai-responses` 改回 `provider: litellm`，重启 daemon。无数据迁移、无破坏性变更。

新装的 `@ai-sdk/openai` 依赖留在 package.json 不影响 litellm 路径，无需立刻卸载。

---

## 10. 实装影响清单

### 10.1 修改

- `package.json`（+1 dep `@ai-sdk/openai@^1.3.24`，**版本下限关键**，见 §4.1）
- `src/workspace/config.ts`（+1 enum 值，+1 子字段）
- `src/workspace/config.test.ts`（+3 用例）
- `src/application/createApplication.ts`（+1 ProviderEnv 变体，+1 buildProviderRuntime 分支，+responsesOpts 透传）
- `src/application/createApplication.test.ts`（+2 用例）
- `src/agent/AiSdkExecutor.ts`（+responsesOpts deps，+ModelUsageSnapshot.reasoningTokens，+extractReasoningTokens helper，updateUsage/buildUsageInfo 衍生）
- `src/agent/AiSdkExecutor.test.ts`（+2 用例）
- `src/core/events.ts`（+ModelUsage.reasoningTokens 可选字段）
- `src/im/slack/SlackRenderer.ts`（progress emoji 字面量改、formatUsageLine 加括号段）
- `src/im/slack/SlackRenderer.test.ts`（改 1 + 加 2）

### 10.2 新建

- `src/e2e/live/run-thinking-responses.ts`

### 10.3 不动

- `SlackEventSink.ts` / `SlackAdapter.ts` / `ConversationOrchestrator.ts` / `SessionRunQueue.ts` / `AbortRegistry.ts` / `SessionStore.ts` / `MemoryStore.ts` / `ContextCompactor.ts` / `agents/compact/*` / `agents/selfImprove/*` / 其他全部 e2e
- 任何与 `provider='litellm'` 或 `provider='anthropic'` 路径相关的代码与测试

---

## 11. 决策记录

- §3 provider 拓展：选 A（新增 `'openai-responses'` 枚举值，不复用 `'litellm'`）
- §4.1 凭证来源：选 a（复用 `LITELLM_BASE_URL` + `LITELLM_API_KEY`，零 env 改动）
- §4.4 sub-agent 范围：选 a（共享 runtime，同 reasoningEffort）
- §6 usage 行格式：选 b（`(132 thinking)` 文字括号，不带 icon）
- §9 store 默认：选 a（硬编码 `store: false`）
- 主路径 emoji：`:fluent-thinking-3d:`（live progress block，色彩鲜亮 3D 黄脸表情）
- usage 行 emoji：本期不用（`:agent_thinking:` 已上传留作后续）
- providerOptions 透传 key：`'openai'`（不是 `'openai-responses'`，因 ai-sdk 内部 `parseProviderOptions({provider:"openai"})` 写死）
- 配置→executor 通路：新增 `extraProviderOptions?: ProviderMetadata` deps 字段，由 createApplication 装配时构造完整 providerOptions 对象传入，不让 executor 知道具体 provider 形态（解耦）
