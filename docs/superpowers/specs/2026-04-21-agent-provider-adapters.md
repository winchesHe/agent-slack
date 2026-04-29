# Agent Provider 适配：Claude（Anthropic）接入

**日期**：2026-04-21
**状态**：已实装（P1-P3 完成；P4.2/P4.4 文档收尾同步）
**关联**：
- 继承 [`2026-04-17-agent-slack-architecture-design.md`](./2026-04-17-agent-slack-architecture-design.md) §2.1 分层、§2.2 `AgentExecutor` 抽象
- 粗粒度事件以 [`2026-04-19-slack-render-flow-redesign.md`](./2026-04-19-slack-render-flow-redesign.md) §2 为准
- 不引入 Claude Agent SDK / `@openai/agents`（遵守 `AGENTS.md` 的 Do-not 约束）

---

## 1. 背景与动机

### 1.1 现状

- `AgentExecutor` 抽象已存在，实装只有一个：`AiSdkExecutor`，内部通过 `@ai-sdk/openai-compatible` 指向 **LiteLLM 代理**（见 `src/application/createApplication.ts`）。
- `src/workspace/config.ts` 原先把 `agent.provider` 写死为 `z.literal('litellm')`；本次改为 `z.enum(['litellm', 'anthropic']).default('litellm')`（**方案 A：config.yaml 单一权威**）。
- env（**方案 A 收窄后**）：凭证/URL/debug 类 —— `LITELLM_BASE_URL` / `LITELLM_API_KEY` / `ANTHROPIC_API_KEY` / `ANTHROPIC_BASE_URL` / `LOG_LEVEL`。已移除：`AGENT_PROVIDER`、`AGENT_MODEL`、`PROVIDER_NAME`。

### 1.2 目标

允许一个 workspace 的 agent 在**启动时选定**下列两种 provider 之一（运行期不切换）：

| Provider key | 底层 | 包 | 默认 |
|---|---|---|---|
| `litellm`（默认） | LiteLLM OpenAI-compatible 网关 | `@ai-sdk/openai-compatible`（已在） | ✅ |
| `anthropic` | Anthropic Messages API | `@ai-sdk/anthropic`（新增） | |

> **OpenAI / Codex（Responses API）本期不做**，留到后续 spec。结构上预留好枚举与分派点，但 §7 代码改动面不包含其代码实装。

### 1.3 非目标

- **不**支持运行期多 provider 并存或 per-session 切换。
- **不**引入 Claude Agent SDK。
- **不**为非 LiteLLM provider 计算美元成本（见 §5）。
- **不**做 CLI 子进程形式的 Claude Code 适配（架构里"cli adapter 预留"另行启动 spec）。
- **不**改动粗粒度事件 schema、Renderer、Sink、Orchestrator。

---

## 2. 设计要点

### 2.1 复用 `AiSdkExecutor`，不新增 executor 子类

两家都走 Vercel AI SDK 的 `streamText`，事件流形态一致（`text-delta` / `reasoning` / `tool-call*` / `step-finish` / `finish` / `error`）。因此**不**新增 `AnthropicExecutor`，只在装配层（`createApplication`）按 `provider` 选择 `LanguageModel` 与 `providerOptions`，传给同一个 `createAiSdkExecutor`。

> **Why**：新增 executor 会复制 ~400 行聚合/节流/usage/abort/redact 逻辑，后续维护分叉。AI SDK 的 provider 抽象就是为此而生。

### 2.2 Provider 选择路径

```
config.yaml agent.provider  ──▶ ProviderSelector ──▶ { model: LanguageModel, providerOptions }
                               │
                               ├─ litellm   → createOpenAICompatible(...).chatModel(modelName)
                               └─ anthropic → createAnthropic(...).languageModel(modelName)
```

`agent.provider` 默认 `litellm`（zod schema 默认值），保证旧部署/空 config 零改动。

### 2.3 Model 名的来源

Model 名仅从 `ctx.config.agent.model` 读取（env 不参与）。onboard 交互收集后写入 config.yaml；事后改模型需编辑 config.yaml。

每个 provider 的建议默认模型（onboard 的 `initialValue` 取值，**不**做硬编码校验）：

| Provider | 建议默认模型 |
|---|---|
| `litellm` | `claude-sonnet-4-6`（onboard 默认值） |
| `anthropic` | `claude-sonnet-4-5`（onboard 默认值） |

---

## 3. 配置与 env

### 3.1 env 清单（全部为凭证/部署差异/debug；不含行为配置）

```dotenv
# Slack（必填）
SLACK_BOT_TOKEN=...
SLACK_APP_TOKEN=...
SLACK_SIGNING_SECRET=...

# LiteLLM（config.yaml agent.provider=litellm 时必填）
LITELLM_BASE_URL=http://localhost:4000
LITELLM_API_KEY=sk-...

# Anthropic（config.yaml agent.provider=anthropic 时必填）
# ANTHROPIC_API_KEY=sk-ant-...
# 可选自建网关
# ANTHROPIC_BASE_URL=https://api.anthropic.com/v1

# 日志 & 调试
LOG_LEVEL=info
```

**已移除**：`AGENT_PROVIDER`、`AGENT_MODEL`、`PROVIDER_NAME`（这三项全部迁移到 config.yaml 或硬编码；方案 A "config.yaml 单一权威行为配置"）。

### 3.2 `createApplication` env 校验调整

```ts
// 伪代码
const ctx = await loadWorkspaceContext(cwd, bootstrapLogger)
const provider = ctx.config.agent.provider  // zod 已保证合法枚举，默认 litellm

const common = { slackBotToken, slackAppToken, slackSigningSecret, logLevel }
const providerEnv = loadProviderEnv(provider)  // 仅检查该 provider 所需 key
```

`ConfigError` 文案例子：`缺少环境变量 ANTHROPIC_API_KEY`（因 config.yaml 已指定 provider=anthropic，这里直接列缺失 env，不再提 AGENT_PROVIDER）。

### 3.3 `config.yaml` Schema 调整

**`agent.provider` 为唯一权威来源**（`'litellm' | 'anthropic'` 枚举，默认 `'litellm'`）；env 不参与 provider 选择：

```ts
// src/workspace/config.ts
agent: z.object({
  name: z.string().default('default'),
  model: z.string().default('gpt-5.4'),
  maxSteps: z.number().int().positive().default(50),
  // provider 为唯一权威来源（env 不参与），默认 litellm
  provider: z.enum(['litellm', 'anthropic']).default('litellm'),
}).default({}),
```

**selectProvider(configProvider)** 退化为类型收窄：直接返回 `configProvider`；合法性由 zod 解析时保证。

**onboard 写入**：生成 config.yaml 时写入 `agent.provider: <litellm|anthropic>` 行；切换 provider 需要编辑 config.yaml 并重启（不再通过 env 切换）。

**向后兼容**：旧 workspace 的 `config.yaml` 里的 `provider: litellm` 字段会被保留；旧版用户若仅设置 env `AGENT_PROVIDER=anthropic` 而 config.yaml 未同步，本次升级后会**默认走 litellm**（zod 默认值），需用户手动把 config.yaml 改成 `agent.provider: anthropic`。

### 3.4 `providerName` / `providerOptions` 处理

当前 `AiSdkExecutor` 有一个 `providerName` 字段用来构造 `providerOptions[providerName].stream_options = { include_usage: true }`（LiteLLM / OpenAI-compat 专用，否则流式 usage 全是 NaN）。

调整为**按 provider 分派**：

| Provider | `providerOptions` 注入 |
|---|---|
| `litellm` | `{ [providerName]: { stream_options: { include_usage: true } } }`（保留现状；`providerName` 硬编码为 `'litellm'`，不再从 env 读 `PROVIDER_NAME`） |
| `anthropic` | 不注入；AI SDK 的 anthropic provider 原生回传 usage |

`AiSdkExecutor` 接口签名保持不变（`providerName?` 仍为可选），仅装配层按 provider 决定是否传入。

### 3.5 Onboard 流程变更（CLI `agent-slack onboard`）

当前流程：强制问 Slack 三件套 + LiteLLM base URL / API key + 默认模型，并以 literal `litellm` 写入 `config.yaml`。

新流程（在"默认模型"之前插入一步）：

```
① (已存在) 选 fill / overwrite / exit
② Slack 三件套
③ ✨ 新增：选 provider —— 单选 litellm (默认) | anthropic
④ 按 provider 分支问凭证：
   - litellm    → LiteLLM Base URL + API Key（保留现状）
   - anthropic  → ANTHROPIC_API_KEY（password），可选 ANTHROPIC_BASE_URL（text，留空则不写）
⑤ 默认模型 —— initialValue 随 provider 变：
   - litellm    → 保留当前 'claude-sonnet-4-6'
   - anthropic  → 'claude-sonnet-4-5'
⑥ 校验：
   - litellm    → 保留 validateLiteLLM
   - anthropic  → 新增 validateAnthropic（一期仅做形状校验：以 'sk-ant-' 开头 + 非空；validator 签名预留真实网络校验空间）
⑦ 写入 .env.local —— 按 provider 分支写凭证/URL 类字段（不再写任何 AGENT_* / PROVIDER_NAME）
⑧ 写入 config.yaml —— **写入 `agent.provider: <selected>` 行**（方案 A：config 单一权威）
```

**`defaultEnv` 按 provider 分支**（模板层）：

```ts
// litellm 分支
SLACK_*
LITELLM_BASE_URL=...
LITELLM_API_KEY=...
LOG_LEVEL=info

// anthropic 分支
SLACK_*
ANTHROPIC_API_KEY=...
# 若用户填了 baseUrl
ANTHROPIC_BASE_URL=...
LOG_LEVEL=info
```

**`defaultConfigYaml` 模板调整**：签名改为 `defaultConfigYaml(model, provider)`，在 `agent:` 块内写入 `provider: ${provider}` 行；切换 provider 需编辑 config.yaml 并重启。

> ⚠️ 非交互场景（`--yes` / 配置文件驱动）不在本 spec 范围内，仍按交互问答流程处理。

---

## 4. Tools 与 message 兼容性

### 4.1 工具定义

现有工具（`bash` / `editFile` / `saveMemory`，见 `src/agent/tools/`）用 AI SDK 的 `tool()` 工厂定义，**provider 无关**，两家通用。无需改动。

### 4.2 历史消息 schema

`src/store/SessionStore.ts` 持久化的是 AI SDK `CoreMessage` / `ModelMessage`——**provider-agnostic 的统一结构**。AI SDK 在向不同 provider 发请求时负责往下转换（tool-call / tool-result 的内部表达差异由 SDK 抹平）。

**结论：跨 provider 读旧 session 在一期范围内是安全的**，不需要迁移代码，不需要标记"建议新开 thread"。因为：

- 我们不主动写 `cache_control` / `providerOptions` 到历史消息里（一期不启用 Anthropic prompt caching）。
- 我们不启用 Anthropic extended thinking（即不会产生带 `signature` 的 reasoning part 被持久化后再回放到别家 provider）。
- 工具的 tool-call / tool-result 在 `CoreMessage` 层都是通用形状，由 SDK 适配各 provider 的 wire format。

**唯一需要留意**：如果后续启用了 extended thinking 并把 reasoning 持久化，再切回非 Anthropic provider，SDK 会把未识别的 part 丢弃——这不会导致报错，只是丢失思考过程。这个限制等启用 extended thinking 时再单独评估。

### 4.3 reasoning / thinking

- LiteLLM：可能把 reasoning 折到 content 或通过 `reasoning` part 透出，现有 `case 'reasoning'` 已处理。
- Anthropic：AI SDK 的 anthropic provider 通过 `reasoning` part 暴露 extended thinking；现有代码直接命中。

两家都走同一 `case 'reasoning'` 分支，**无需**分支处理。

---

## 5. Usage

### 5.1 Token 计数

`updateUsage()` 现有逻辑用 `usage.promptTokens ?? usage.inputTokens` / `usage.completionTokens ?? usage.outputTokens` / `usage.cachedInputTokens`，两家 provider 的 AI SDK 映射字段均覆盖，**无需**修改。

---

## 6. 依赖

新增 prod 依赖（`package.json`）：

```jsonc
{
  "dependencies": {
    "@ai-sdk/anthropic": "^1.x"  // 与现 @ai-sdk/openai-compatible 版本线对齐
  }
}
```

> AI SDK 主包 `ai` 已存在；版本号在实装 PR 里对齐（需兼容当前 `ai` 包的 LanguageModel 接口版本），spec 不写死。

---

## 7. 代码改动面（预估）

| 文件 | 改动 |
|---|---|
| `src/workspace/config.ts` | `agent.provider` 改为 `z.enum(['litellm','anthropic']).default('litellm')`；移除 `process.env.AGENT_MODEL` fallback（model 只从 config） |
| `src/application/createApplication.ts` | 新增 `ProviderSelector`（读 `ctx.config.agent.provider`）；按 provider 分支构造 `model` / `providerOptions`；env 校验按 provider 条件化；`providerName` 在 litellm 分支硬编码为 `'litellm'`（不再读 `PROVIDER_NAME`） |
| `src/agent/AiSdkExecutor.ts` | **无需改动**（`providerName` 仍作为可选入参；Anthropic 下装配层不传，现有 `providerOpts` 分支逻辑已兼容） |
| `src/cli/commands/onboard.ts` | 见 §3.5：插入 provider 选择步骤；按 provider 分支问凭证；调用对应 validator；**将 provider 写入 config.yaml** |
| `src/cli/templates.ts` | `defaultConfigYaml(model, provider)` 签名新增 `provider`，在 `agent:` 块写 `provider: ${provider}` 行；`defaultEnv` 按 provider 生成两套变体（`DefaultEnvArgs` 为 discriminated union，anthropic 分支含 `ANTHROPIC_API_KEY` + 可选 `ANTHROPIC_BASE_URL`，**不含 AGENT_PROVIDER**） |
| `src/cli/validators.ts` | 新增 `validateAnthropic({ apiKey, baseUrl? })`，一期实装为形状校验（`sk-ant-` 前缀 + 非空），signature 预留 fetcher 注入位以后升级为真实网络校验 |
| `.env.example` | 精简为凭证/URL/debug 四组（Slack / LiteLLM / Anthropic / LOG_LEVEL）；不含 AGENT_* / PROVIDER_NAME |
| `README.md` | "配置"节新增 provider 矩阵与 env 清单 |
| `AGENTS.md` | Identity & Boundaries 一行从 "Vercel AI SDK + LiteLLM" 改为 "Vercel AI SDK（LiteLLM 默认；可切 Anthropic）"；Env 变更联动规则的字段集合收窄 |
| `package.json` | 新增 `@ai-sdk/anthropic` |

**不**需要动：`src/agent/tools/*`、`src/core/events.ts`、`src/orchestrator/*`、`src/store/*`。

---

## 8. 测试策略

沿用 `vitest`，与源文件同目录（`*.test.ts`）。

### 8.1 新增单测

- `src/application/createApplication.test.ts`：扩展
  - config.yaml 默认缺省 → 走 litellm 路径（回归保护）
  - `agent.provider=anthropic` 抛 `ConfigError('暂未实装')`（一期；P3 实装后改断言）
  - `agent.provider=anthropic` 时缺 `ANTHROPIC_API_KEY` 抛 `ConfigError`（P3 后生效，一期被"暂未实装"拦截前抛出的顺序依实现）
  - env `AGENT_PROVIDER` 不再影响选择（config 单一权威）
- `src/workspace/config.test.ts`：`agent.provider` 带默认值回归（litellm 默认、anthropic 合法、非法值报错、旧 config 带 `provider: litellm` 保留）
- `src/cli/commands/onboard.test.ts`：扩展
  - 选 anthropic → `config.yaml` 含 `agent.provider=anthropic`；`.env.local` 含 `ANTHROPIC_API_KEY`，不含 `LITELLM_*`，也**不含** `AGENT_PROVIDER`
  - 选 litellm（默认）→ `config.yaml` 含 `agent.provider=litellm`；`.env.local` 无 `AGENT_PROVIDER`（任何形式）
- `src/cli/validators.test.ts`：新增 `validateAnthropic` 的形状校验用例

### 8.2 既有测试回归

- `src/agent/AiSdkExecutor.test.ts`、`src/im/slack/SlackRenderer.test.ts`：现有用例必须全部通过，**本 spec 无需新增这里的测试**。

### 8.3 不做的测试

- **不**对 Anthropic 真实 API 发请求；用 AI SDK 的 mock LanguageModel（与现有 executor 测试一致）即可。

---

## 9. 文档更新

- `README.md`：新增"切换 Agent Provider"小节（env 矩阵）。
- `.env.example`：见 §3.1。
- `AGENTS.md`：见 §7 表格。
- 本 spec 作为权威定义；`2026-04-17` 旧 spec 里 "cli adapter 预留" 的措辞不受影响（本 spec 是 SDK 层扩展，非 CLI 适配）。

---

## 10. 里程碑切分（实装阶段参考，不在本 spec 落地）

| 阶段 | 内容 | 可独立交付 |
|---|---|---|
| P1 | config schema + ProviderSelector + 条件化 env 校验（`createApplication` 侧，仍默认 litellm，行为等价） | ✅ |
| P2 | onboard 流程改造（§3.5）：新增 provider 选择 + 分支凭证 + `validateAnthropic` + 模板改造 | ✅ |
| P3 | 接入 `@ai-sdk/anthropic`，跑通一次 Claude 对话；真实 litellm→anthropic 旧 session 回归验证 | ✅ |
| P4 | 文档：README / .env.example / AGENTS.md | ✅ |

每个阶段交付后按 `AGENTS.md` 的"任务完成已同步更新进度和 design doc"原则更新本 spec 的"状态"字段与进度记录。

---

## 11. 风险与 Open Questions

| # | 风险 | 缓解 |
|---|---|---|
| R1 | AI SDK anthropic provider 对 tool-call streaming 的 `fullStream` part 形态与 openai-compat 存在小差异（如 `tool-call-delta` 的有无） | 现有 executor 对未知 part 走 default case 忽略；新增 mock 测试覆盖 anthropic 的最小 happy path |
| R2 | 旧 session（由 litellm 产生）在切到 anthropic 后能否正常回放？ | 理论上 AI SDK 的 `CoreMessage` 层已抽象掉 provider 差异（见 §4.2），一期范围（不启用 prompt caching / extended thinking）下无兼容问题。P2 实装时跑一次真实"litellm 跑过的旧 session → 切 anthropic → 继续对话"回归验证 |
| R3 | Anthropic extended thinking 的 signature 事件（`reasoning-signature`）在 provider 切换时的透传差异 | 现有 executor 已对 `reasoning-signature` / `redacted-reasoning` 走空 case，行为一致 |
| R4 | Anthropic 的 prompt caching 需要 `providerOptions.anthropic.cacheControl`，一期不主动开启 | 一期不启用 cache_control；`cachedInputTokens` 字段存在 Anthropic 原生回传时仍能被 `updateUsage` 统计，不需额外代码 |

Open：

- **Q1**：是否需要在 `SessionRecord` 里持久化"创建时所用 provider"，便于未来切 provider 时给出明确警告？—— **建议 later**，一期靠文档提示。
- **Q2**：`config.yaml` 是否再加一层 `agent.providers.<name>.*` 嵌套以承载 provider 专属选项（`baseURL` 等）？—— **建议 later**，一期用 env 足够。
- **Q3**：未来 Codex（OpenAI Responses API）接入是否复用本 spec 的 `ProviderSelector` 结构？—— **是**；新增枚举值 `openai` 与新的分派分支即可，不需要改 executor。
