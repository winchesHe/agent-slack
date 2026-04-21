# Agent Provider 适配 - 执行进度

对应计划：`docs/superpowers/plans/2026-04-21-agent-provider-adapters.md`

## 进度记录

- [ ] P1 后端重构（config 精简 + ProviderSelector）
  - [x] P1.1 移除 `agent.provider` schema 字段 ✅ 2026-04-21
  - [x] P1.2 `ProviderSelector` 装配层 ✅ 2026-04-21
- [ ] P2 Onboard UX 改造
  - [ ] P2.1 `validateAnthropic` 形状校验
  - [ ] P2.2 `templates.ts` 分支模板
  - [ ] P2.3 `onboard.ts` 流程改造
- [ ] P3 接入 `@ai-sdk/anthropic`
  - [ ] P3.1 引入依赖
  - [ ] P3.2 实装 anthropic 分支
  - [ ] P3.3 真实回归验证（手工）
- [ ] P4 文档
  - [ ] P4.1 `.env.example`
  - [ ] P4.2 `README.md`
  - [ ] P4.3 `AGENTS.md`
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
