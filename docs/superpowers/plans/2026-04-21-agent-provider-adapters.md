# Agent Provider 适配实施计划（Claude/Anthropic 接入）

> **Goal:** 让 `agent-slack` 在 env `AGENT_PROVIDER` 控制下可在 **LiteLLM（默认）** 与 **Anthropic** 之间切换；结构上为未来 Codex（OpenAI Responses）留好扩展位。

**Spec 对照**：`docs/superpowers/specs/2026-04-21-agent-provider-adapters.md`（以下简称 spec）。实现与 spec 冲突时以 spec 为准，需改 spec 再改代码。

**Range**：spec §3 所有条目（§3.1 env / §3.2 条件化校验 / §3.3 schema 精简 / §3.4 providerOptions 分派 / §3.5 onboard 流程）+ §6 依赖 + §9 文档。

**不包含**：Codex（OpenAI Responses）适配、CLI 子进程形式 Claude Code 适配、真实 Anthropic 网络 validator、自动 session 迁移。

---

## 原则

- **每个 chunk 都有一个"可观测性验证（Observability Check）"**——不是编译通过，而是一个明确的运行时信号（单测输出 / CLI 实跑截图 / env dump / Slack 消息 / log 片段），让用户能直接 review 看到"这步真的成了"。
- **用户 review 门禁**：每个 chunk 完成后我停下来给出观测方式，用户确认后再进下一个 chunk（遵循 `AGENTS.md` 里的 "chunk 执行完后给出测试建议让用户 review，不要直接提交代码"）。
- **默认 litellm 零回归**：P1、P2 完成后不引入 anthropic 依赖、不改 executor 行为，现有 litellm 流程**完全等价**。
- **提交粒度**：每个 Task 独立 commit，commit message 中文。

---

## Chunk P1：后端重构（config 精简 + ProviderSelector）

**目标**：把 provider 的选择点从 config 转移到 env + 装配层；引入 `ProviderSelector` 但只实装 `litellm` 分支（anthropic 分支抛 `ConfigError: 暂未实装`）。

**不引入新 npm 依赖**。行为对 litellm 用户完全等价。

### Task P1.1：移除 `agent.provider` schema 字段

**Files**：
- Edit `src/workspace/config.ts`
- Edit `src/workspace/config.test.ts`（若现有用例断言了 `provider: 'litellm'` 默认值，同步删除断言）

**Steps**：
1. 从 `ConfigSchema.agent` 中移除 `provider: z.literal('litellm').default('litellm')`
2. 检查并移除 `DEFAULT_CONFIG` / 类型推导处对 `provider` 的引用（若有）
3. 回归 `pnpm test src/workspace/config.test.ts`

**Observability Check（P1.1）**：
- ✅ `pnpm test src/workspace/config.test.ts` 通过
- ✅ 把旧 workspace 的 `.agent-slack/config.yaml`（含 `provider: litellm`）放到测试里 parse 一次，断言**不抛错**且结果里无 `provider` key —— 证明静默忽略生效（spec §3.3 向后兼容）

---

### Task P1.2：`ProviderSelector` 装配层

**Files**：
- Edit `src/application/createApplication.ts`
- Edit `src/application/createApplication.test.ts`

**Steps**：
1. 新增 `type AgentProvider = 'litellm' | 'anthropic'`
2. 新增函数 `selectProvider(): AgentProvider` —— 读 `process.env.AGENT_PROVIDER`，默认 `'litellm'`，非法值抛 `ConfigError`
3. 新增 `buildProviderRuntime(provider, logger)` 返回 `{ model, providerOptions, modelName }`：
   - `litellm` 分支：迁入现有 `createOpenAICompatible` + `chatModel(modelName)` 逻辑
   - `anthropic` 分支：**暂** `throw new ConfigError('AGENT_PROVIDER=anthropic 暂未实装，P3 阶段接入', '临时改用 litellm 或等待 P3')`
4. 条件化 env 校验：`litellm` 要求 `LITELLM_BASE_URL` / `LITELLM_API_KEY`；`anthropic` 要求 `ANTHROPIC_API_KEY`（容忍可选 `ANTHROPIC_BASE_URL`）
5. `createAiSdkExecutor` 调用处：litellm 下仍传 `providerName: env.providerName`；anthropic 分支 P1 阶段不会到达

**Observability Check（P1.2）**：
- ✅ 新增单测：
  - `AGENT_PROVIDER` 未设 → 成功 → 调用 `createOpenAICompatible`（用 vi.spyOn 或 mock 模块断言）
  - `AGENT_PROVIDER=anthropic` → 抛 `ConfigError` 文案含"暂未实装"
  - `AGENT_PROVIDER=anthropic` 但缺 `ANTHROPIC_API_KEY` → 抛 `ConfigError` 文案含 `ANTHROPIC_API_KEY`
  - `AGENT_PROVIDER=foo` → 抛 `ConfigError` 文案含"非法 provider"
- ✅ **端到端运行**（用户手工）：`pnpm dev` 在当前 `.env` 下启动，日志里第一行 agent tag 显示 provider=litellm；@mention 一次走通（回归保护）。给用户看 consola 输出即可。

---

### Chunk P1 完成门禁

提交 commit（建议 3 条：P1.1 移除 schema 字段 / P1.2 ProviderSelector 骨架 / P1.3 测试补齐）。

**给用户 review 的观测物**：
1. `pnpm test` 全绿截图
2. `pnpm dev` 启动日志片段（证明旧 litellm 路径等价）
3. 一次 Slack @mention 的回复截图（证明用户链路无回归）

用户确认后 → 进 P2。

---

## Chunk P2：Onboard UX 改造（provider 选择 + 分支凭证 + 分支模板 + validator）

**目标**：`agent-slack onboard` 新增 provider 选择步骤；按选择分支问凭证、跑 validator、写不同 `.env.local`；`config.yaml` 不再写 `provider:` 行。

### Task P2.1：`validateAnthropic` 形状校验

**Files**：
- Edit `src/cli/validators.ts`
- Edit `src/cli/validators.test.ts`

**Steps**：
1. 新增 `ValidateAnthropicArgs { apiKey: string; baseUrl?: string; fetcher?: typeof fetch }`
2. 新增 `validateAnthropic(args): Promise<ValidationResult>`
   - 一期仅做形状校验：`apiKey` 必须以 `sk-ant-` 开头、非空；不匹配则 `{ ok: false, reason: 'API key 需以 sk-ant- 开头' }`
   - `fetcher` 入参**仅预留**，一期不发请求；后续升级为 `POST {baseUrl}/v1/messages` 一个最小请求
3. 在 `validators.test.ts` 加覆盖用例（合法 key / 非法前缀 / 空串）

**Observability Check（P2.1）**：
- ✅ `pnpm test src/cli/validators.test.ts` 绿

---

### Task P2.2：`templates.ts` 分支模板

**Files**：
- Edit `src/cli/templates.ts`

**Steps**：
1. `defaultConfigYaml(model)` —— 移除 `provider: litellm` 行（签名不变）
2. 改造 `DefaultEnvArgs` 为 discriminated union：
   ```ts
   type DefaultEnvArgs =
     | { provider: 'litellm'; slack*: string; litellmBaseUrl; litellmApiKey }
     | { provider: 'anthropic'; slack*: string; anthropicApiKey; anthropicBaseUrl?: string }
   ```
3. `defaultEnv(args)` 按 `args.provider` 生成两套字符串（见 spec §3.5）：
   - litellm 分支：保留现状，**不**写 `AGENT_PROVIDER`（未设即默认）
   - anthropic 分支：`AGENT_PROVIDER=anthropic` + `ANTHROPIC_API_KEY=...` + 条件 `ANTHROPIC_BASE_URL=...`

**Observability Check（P2.2）**：
- ✅ 直接在 node REPL / 单测里调用 `defaultEnv({ provider: 'anthropic', ... })`，输出字符串通过字段断言：含 `AGENT_PROVIDER=anthropic`、含 `ANTHROPIC_API_KEY=`、**不含** `LITELLM_`
- ✅ litellm 分支输出断言：**不含** `AGENT_PROVIDER`、**不含** `ANTHROPIC_`

---

### Task P2.3：`onboard.ts` 流程改造

**Files**：
- Edit `src/cli/commands/onboard.ts`
- Edit `src/cli/commands/onboard.test.ts`
- Edit `src/cli/prompts.ts`（若 Prompter 缺 `select` 类型签名需要补，但现有代码已有 `prompter.select`）

**Steps**：
1. `OnboardDeps` 增加 `validateAnthropic: (args: ValidateAnthropicArgs) => Promise<ValidationResult>`（注入点）
2. `buildDefaultDeps` 连接 `validateAnthropic`
3. 在 Slack 三件套问完后、LiteLLM 问卷之前，**插入**：
   ```ts
   const provider = await prompter.select<'litellm' | 'anthropic'>({
     message: 'Agent provider',
     options: [
       { label: 'LiteLLM（默认，通过代理层走多家）', value: 'litellm' },
       { label: 'Anthropic（官方 Claude API）', value: 'anthropic' },
     ],
     initialValue: 'litellm',
   })
   ```
4. 按 `provider` 分支问凭证：
   - litellm → 现有 `litellmBaseUrl` / `litellmApiKey` 问卷
   - anthropic → `prompter.password({ message: 'ANTHROPIC_API_KEY', validate: ... })` + `prompter.text({ message: 'ANTHROPIC_BASE_URL（可选，回车跳过）', initialValue: '' })`
5. 默认模型的 `initialValue` 随 provider：litellm 保留 `claude-sonnet-4-6`（现值）；anthropic 用 `claude-sonnet-4-5`
6. 校验分支：litellm → `validateLiteLLM`；anthropic → `validateAnthropic`
7. 写模板：`defaultConfigYaml(model)` + `defaultEnv({ provider, ... })` 用 discriminated union

**Observability Check（P2.3）**：
- ✅ 单测新增 3 个用例：
  - 选 anthropic → 写入的 `.env.local` 含 `AGENT_PROVIDER=anthropic` + `ANTHROPIC_API_KEY=sk-ant-xxx`；不含 `LITELLM_*`；`config.yaml` 里不含 `provider:`
  - 选 anthropic + 留空 baseUrl → `.env.local` 不含 `ANTHROPIC_BASE_URL` 行
  - 选 litellm（默认）→ 与现状完全一致（字段级断言）
- ✅ **实跑观测**（用户手工）：在一个临时目录跑 `pnpm build && ./bin/cli.mjs onboard`（或 `node --import tsx bin/cli.ts onboard`），两次：一次选 litellm、一次选 anthropic；查看生成的 `.env.local` / `config.yaml` 内容贴给用户 review

---

### Chunk P2 完成门禁

提交 commit（建议 3 条：P2.1 validator / P2.2 templates / P2.3 onboard 流程）。

**给用户 review 的观测物**：
1. `pnpm test` 全绿
2. 两次真实 `onboard` 跑完后的 `.env.local` + `config.yaml` 文件内容对比
3. onboard 交互截图（新的 provider 选择步骤）

用户确认后 → 进 P3。

---

## Chunk P3：接入 `@ai-sdk/anthropic`（真实打通 Claude）

**目标**：把 `ProviderSelector` 的 anthropic 分支从"抛未实装"替换为真实 `createAnthropic(...).languageModel(modelName)`；新增依赖；走一次真实 Claude 对话。

### Task P3.1：引入依赖

**Files**：
- Edit `package.json`

**Steps**：
1. 运行 `pnpm add @ai-sdk/anthropic`
2. 版本对齐：与现有 `@ai-sdk/openai-compatible` 的 AI SDK 主版本线一致（以 lockfile 实际解析为准）
3. commit：`feat: 引入 @ai-sdk/anthropic 依赖`

**Observability Check（P3.1）**：
- ✅ `pnpm install` 无 peer 冲突
- ✅ `cat pnpm-lock.yaml | grep @ai-sdk/anthropic` 能看到版本

---

### Task P3.2：实装 anthropic 分支

**Files**：
- Edit `src/application/createApplication.ts`
- Edit `src/application/createApplication.test.ts`

**Steps**：
1. `buildProviderRuntime` 的 anthropic 分支：
   ```ts
   const anthropic = createAnthropic({
     apiKey: env.anthropicApiKey,
     ...(env.anthropicBaseUrl ? { baseURL: env.anthropicBaseUrl } : {}),
   })
   return {
     model: anthropic.languageModel(modelName),
     providerOptions: undefined,  // 不注入 stream_options
     modelName,
   }
   ```
2. `createAiSdkExecutor` 调用：anthropic 下不传 `providerName`（保持 `undefined`，避免构造 `providerOptions`）
3. 更新单测：anthropic + 完整 env 不再抛 ConfigError，改为断言 `createAnthropic` 被以期望参数调用

**Observability Check（P3.2）**：
- ✅ 单测：mock `createAnthropic` 断言以 `apiKey='sk-ant-xxx'` 调用
- ✅ 单测：mock `streamText` / `createAiSdkExecutor`，断言 anthropic 分支下 `providerName` 为 `undefined`（不注入 stream_options）

---

### Task P3.3：真实 litellm→anthropic 回归验证（用户手工，**不自动化**）

**Steps**（给用户的操作指南，不在代码里）：
1. 用 litellm 跑一次 Slack @mention，确认历史消息写入 `.agent-slack/sessions/...jsonl`
2. 停服 → `.env.local` 改为 `AGENT_PROVIDER=anthropic` + `ANTHROPIC_API_KEY=...` → 重启
3. 同一 thread 再 @mention 一次
4. 观察：
   - Slack 回复正常
   - 日志无 "unknown part type" / 消息 schema 错误
   - `modelUsage` 里出现 anthropic 模型名的 token 计数
   - Slack 的 usage 行**不显示 $cost**（现有 renderer 条件生效）

**Observability Check（P3.3）**：
- ✅ 用户在 Slack 里的真实对话截图 + consola 日志截图
- ✅ `.agent-slack/logs/*.jsonl` 最近一条 `usage-info` 事件里 `modelUsage[0].model` 为 claude 模型名、`totalCostUSD===0`

---

### Chunk P3 完成门禁

**给用户 review 的观测物**：
1. `pnpm test` 全绿
2. 真实 Slack Claude 对话截图
3. `.agent-slack/logs/` 的 usage 事件 JSONL 片段

用户确认后 → 进 P4。

---

## Chunk P4：文档

**目标**：把 provider 能力用户可发现、可配置、可排错。

### Task P4.1：`.env.example`

**Files**：`.env.example`

**Steps**：在文件末追加：

```dotenv
# ===== Provider 切换（默认 litellm）=====
# AGENT_PROVIDER=litellm   # litellm | anthropic

# ===== Anthropic（AGENT_PROVIDER=anthropic 时必填）=====
# ANTHROPIC_API_KEY=sk-ant-...
# ANTHROPIC_BASE_URL=https://api.anthropic.com/v1  # 可选
```

**Observability Check（P4.1）**：`grep -E '^(# )?AGENT_PROVIDER|ANTHROPIC_' .env.example` 能看到 3 行。

---

### Task P4.2：`README.md`

**Files**：`README.md`

**Steps**：在"配置"章节新增小节"切换 Agent Provider"，列矩阵（provider / 底层 / 所需 env / 建议模型）+ 切换步骤（改 `.env.local` → 重启）。

**Observability Check（P4.2）**：README 渲染后肉眼 review；用户在 GitHub 预览里确认。

---

### Task P4.3：`AGENTS.md`

**Files**：`AGENTS.md`

**Steps**：把 Identity & Boundaries 的 "Vercel AI SDK + LiteLLM" 改为 "Vercel AI SDK（LiteLLM 默认；可切 Anthropic）"。

**Observability Check（P4.3）**：`grep -n "LiteLLM" AGENTS.md` 确认措辞更新。

---

### Task P4.4：更新 spec 状态

**Files**：`docs/superpowers/specs/2026-04-21-agent-provider-adapters.md`

**Steps**：把开头"状态：待 review"改为"状态：已实装"+追加进度段。

**Observability Check（P4.4）**：`head -10 docs/superpowers/specs/2026-04-21-agent-provider-adapters.md`。

---

### Chunk P4 完成门禁

**给用户 review 的观测物**：
1. 四处文档的 diff 摘要
2. `pnpm lint` 绿（虽然 md 不过 lint，但整个仓库不应被 doc 改动影响）

---

## 全局检查（实装全部完成后）

- [ ] `pnpm test` 全绿
- [ ] `pnpm lint` 无错
- [ ] Slack 两种 provider 各跑一次 @mention 成功
- [ ] spec 状态更新 + 进度段落
- [ ] 每个 chunk 完成时已停下给用户 review，得到确认后才推进（遵循 AGENTS.md）

---

## 风险 & 回滚

| 风险 | 触发 | 回滚方案 |
|---|---|---|
| `@ai-sdk/anthropic` 与当前 `ai` 主版本不兼容 | `pnpm install` 报 peer 警告 / 类型错 | P3.1 回滚到未装，把 anthropic 分支维持 `ConfigError`，spec 标记"延后 P3 + ai 主版本升级"单起 spec |
| Anthropic 的 `fullStream` part 形态与 openai-compat 小差异导致 executor 未知分支 | P3.2 后 Slack 实测日志出现 `unknown part` | 为 executor 的 switch 增加缺失分支（视需要），写进 spec 的 §11 R1 更新 |
| 真实 Anthropic 调用报 401 / 403 | P3.3 实跑失败 | `validateAnthropic` 未来升级版可提前发现；当前先人肉检查 key |

---

## 进度记录

（每个 chunk 完成后追加时间戳 + 观测物链接 / 截图引用 / commit SHA）

- P1 启动：_待填_
- P1 完成：_待填_
- P2 启动：_待填_
- P2 完成：_待填_
- P3 启动：_待填_
- P3 完成：_待填_
- P4 启动：_待填_
- P4 完成：_待填_
