# Agent Provider 适配 - 执行进度

对应计划：`docs/superpowers/plans/2026-04-21-agent-provider-adapters.md`

## 进度记录

- [ ] P1 后端重构（config 精简 + ProviderSelector）
  - [x] P1.1 移除 `agent.provider` schema 字段 ✅ 2026-04-21
  - [x] P1.2 `ProviderSelector` 装配层 ✅ 2026-04-21
- [ ] P2 Onboard UX 改造
  - [x] P2.1 `validateAnthropic` 形状校验 ✅ 2026-04-21
  - [x] P2.2 `templates.ts` 分支模板 ✅ 2026-04-21
  - [x] P2.3 `onboard.ts` 流程改造 ✅ 2026-04-21
- [ ] P3 接入 `@ai-sdk/anthropic`
  - [ ] P3.1 引入依赖
  - [ ] P3.2 实装 anthropic 分支
  - [ ] P3.3 真实回归验证（手工）
- [ ] P4 文档
  - [x] P4.1 `.env.example` ✅ 2026-04-21（每字段补注释；`.env` 同步）
  - [ ] P4.2 `README.md`
  - [x] P4.3 `AGENTS.md` ✅ 2026-04-21（Identity 改为 "LiteLLM 默认；可切 Anthropic"；新增 Env 变更联动规则）
  - [ ] P4.4 spec 状态

## 时间线

### P1 完成（2026-04-21）

**改动文件**：
- `src/workspace/config.ts`：移除 `agent.provider` 字段
- `src/workspace/config.test.ts`：新增向后兼容测试
- `src/application/createApplication.ts`：
  - 新增 `AgentProvider` 类型 + `selectProvider()`（读 `AGENT_PROVIDER`，默认 litellm）
  - 新增 `loadProviderEnv()` 条件化 env 校验（litellm 要 LITELLM_*，anthropic 要 ANTHROPIC_API_KEY）
  - 新增 `buildProviderRuntime()`：litellm 分支迁入现逻辑，anthropic 分支抛"暂未实装"
  - 启动日志输出 `provider=xxx`
- `src/application/createApplication.test.ts`：新增 4 个分支用例

**验证**：`pnpm test` 166 pass / `pnpm lint` 通过

### P2 完成（2026-04-21）

**改动文件**：
- `src/cli/validators.ts`：新增 `validateAnthropic`（形状校验 `sk-ant-` 前缀 + 非空）
- `src/cli/validators.test.ts`：新增 3 用例
- `src/cli/templates.ts`：
  - `defaultConfigYaml` 去掉 `provider: litellm` 行
  - `DefaultEnvArgs` 改为 discriminated union（`provider: 'litellm' | 'anthropic'`）
  - `defaultEnv` 按 provider 分支渲染（anthropic 写 `AGENT_PROVIDER=anthropic` + `ANTHROPIC_API_KEY` + 可选 `ANTHROPIC_BASE_URL`；litellm 保持现状不写 `AGENT_PROVIDER`）
- `src/cli/commands/onboard.ts`：
  - Slack 三件套后插入 `provider` select（默认 litellm）
  - litellm 分支问 LiteLLM Base URL / API Key；anthropic 分支问 ANTHROPIC_API_KEY（sk-ant- 校验）+ 可选 ANTHROPIC_BASE_URL
  - 默认模型随 provider 切换（anthropic → claude-sonnet-4-5；litellm → claude-sonnet-4-6）
  - 对应 validator 分支调用
  - `defaultEnv(...)` 用 discriminated union 传参
- `src/cli/commands/onboard.test.ts`：新增 3 用例（anthropic / anthropic+baseUrl / litellm 回归），select 队列改为按序返回

**验证**：`pnpm test` 172 pass / `pnpm lint` 通过

### P4.1（含 P2 模板细化，2026-04-21）

**改动文件**：
- `.env.example`：精简，按 Slack / Provider 开关 / LiteLLM / Anthropic / 模型 / 日志分组；只给**需要选择/可选/值说明**的字段加注释
- `.env`（本地，gitignored）：同结构
- `src/cli/templates.ts` `defaultEnv`：重写分支模板 — 两个 provider 块都输出（当前启用的填值，另一个注释掉），注释仅保留在有选择空间的字段
- `src/cli/commands/onboard.test.ts`：调整 anthropic 断言为行首锚点（`^LITELLM_` / `^ANTHROPIC_BASE_URL=`），允许注释行存在

**验证**：`pnpm test` 172 pass / `pnpm lint` 通过

### P1.1 回调（保留 agent.provider，2026-04-21）

按新决策 "config > env 优先级"：
- `src/workspace/config.ts`：重新引入 `agent.provider` 为可选枚举 `z.enum(['litellm','anthropic']).optional()`
- `src/workspace/config.test.ts`：4 条用例（litellm/anthropic 合法、undefined 缺省、非法值报错）
- `src/application/createApplication.ts`：
  - `selectProvider(configProvider?)` 优先 config；为 undefined 时 fallback 到 env；再 fallback 默认 litellm
  - 加载流程改为先 bootstrap logger（仅 Slack secrets）→ loadWorkspaceContext → selectProvider(ctx.config.agent.provider) → 加 provider secrets → 重建最终 logger
- `src/application/createApplication.test.ts`：新增 2 用例（config 锁 anthropic 优先；config 锁 litellm 覆盖 env anthropic）
- spec §3.3 / §3.5 ⑧ / §1.1 / §8.1 同步更新

**验证**：`pnpm test` 177 pass / `pnpm lint` 通过

### 方案 A 实施：env / config 单一权威收敛（2026-04-21）

**背景**：AGENT_MODEL / AGENT_PROVIDER / PROVIDER_NAME 同时存在于 env 与 config.yaml，形成二重来源。用户选方案 A —— **config.yaml 单一权威管行为配置**，env 只放凭证 / 部署差异 / debug。

**改动文件**：
- `src/workspace/config.ts`：
  - `agent.provider` 从 `.optional()` 改为 `.default('litellm')`（必填带默认，空 config 也能跑）
  - 移除 `process.env.AGENT_MODEL` fallback —— model 只从 config 读取
- `src/workspace/config.test.ts`：4 条用例对齐新默认语义
- `src/application/createApplication.ts`：
  - `selectProvider(configProvider)` 简化为类型收窄（合法性由 zod 在解析时保证，env 不再参与）
  - `modelName` 只从 `ctx.config.agent.model` 读
  - `loadProviderEnv` litellm 分支 `providerName` 硬编码 `'litellm'`（删 `PROVIDER_NAME` env）
  - 错误文案：`AGENT_PROVIDER=anthropic 暂未实装` → `agent.provider=anthropic 暂未实装（改 config.yaml）`
- `src/application/createApplication.test.ts`：5 条用例重写（mock loadWorkspaceContext 返回的 config 默认带 `provider: 'litellm'`；新增 "env AGENT_PROVIDER 不再影响选择" 回归）
- `src/cli/templates.ts`：
  - `defaultConfigYaml(model, provider)` 签名新增 `provider`，在 `agent:` 块写 `provider: ${provider}` 行
  - `defaultEnv` 去掉"模型 & Provider 选项"段和 AGENT_PROVIDER 注释行
- `src/cli/commands/onboard.ts`：
  - 调用 `defaultConfigYaml(model, provider)` 时传 provider
  - providerHint 改为"编辑 config.yaml 切换 provider"
- `src/cli/commands/onboard.test.ts`：3 条 provider 相关用例改为断言 config.yaml 的 `provider: <value>`；断言 `.env.local` 完全不含 `AGENT_PROVIDER`
- `src/cli/commands/doctor.ts`：文案 `model=AGENT_MODEL 或 gpt-5.4` → `model=gpt-5.4 / provider=litellm`
- `.env.example` / `.env`：精简到 Slack / LiteLLM / Anthropic / LOG_LEVEL / SLACK_RENDER_DEBUG 五组；不含 AGENT_* / PROVIDER_NAME
- `AGENTS.md`：新增"Env / Config 单一权威原则（方案 A）"节，明确禁止行为类 env 变量
- spec §1.1 / §2.2 / §2.3 / §3.1 / §3.3 / §3.4 / §3.5 / §7 / §8.1 全面同步为方案 A 描述

**验证**：`pnpm vitest run` 175 pass / `pnpm lint` 通过
