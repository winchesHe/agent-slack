1. [2026-04-21] Agent Provider Adapters（Claude/Codex 适配）spec + plan

## 背景
用户要求为 agent-slack 新增 Claude / Codex 适配（原只支持 LiteLLM）。
经多轮澄清，范围收窄为：
- 一期只做 Anthropic（Claude），Codex 延后
- 走 Vercel AI SDK 的 `@ai-sdk/anthropic` provider（禁 CLI 子进程、禁 Claude Agent SDK）
- 默认仍保持 litellm

## 关键决策
- **架构**：复用单一 `AiSdkExecutor`，不分叉 executor。三家都走 AI SDK `streamText`，
  事件流形态一致，避免 ~400 行聚合/节流/usage/abort/redact 逻辑分叉。
- **Provider 选择**：只在 `.env` 中用 `AGENT_PROVIDER=litellm|anthropic` 切换；
  `agent.provider` 字段**从 config.yaml schema 移除**（zod 非 strict → 旧 config 残留字段静默忽略，向后兼容）。
- **providerOptions 分派**：litellm 下注入 `stream_options.include_usage=true`
  （否则流式 usage 全 NaN）；anthropic 下不注入（原生回传 usage）。
- **Cost**：零改动。`extractCostFromMetadata` 对 Anthropic 返 undefined → `?? 0` 兜底
  → `SlackRenderer.ts:133` 的 `totalCostUSD > 0` 条件已自动隐藏 cost 行。
  `SlackRenderer.test.ts:461` 已有现成测试覆盖。
- **Session 兼容**：AI SDK `CoreMessage` 是 provider-agnostic，
  一期不启用 prompt caching / extended thinking 前提下跨 provider 读旧 session 无问题。
- **默认模型**：litellm 保留 `claude-sonnet-4-6`（原代码值）；anthropic 用 `claude-sonnet-4-5`。
- **Anthropic validator**：一期**只做形状校验**（`sk-ant-` 前缀 + 非空），不发真实请求；
  签名预留 `fetcher?` 未来升级。

## 产出
- `docs/superpowers/specs/2026-04-21-agent-provider-adapters.md` - 完整 spec
- `docs/superpowers/plans/2026-04-21-agent-provider-adapters.md` - 4 chunks 实施 plan，
  每 task 带 Observability Check，每 chunk 带用户 review 门禁

## Plan 结构
- P1 后端重构：schema 移除 provider 字段 + createApplication 装配条件化
  （完成后 litellm 行为完全等价，anthropic 分支抛 ConfigError: 暂未实装）
- P2 Onboard UX：provider 单选 + 分支问凭证 + templates.ts + validators.ts
- P3 接入 `@ai-sdk/anthropic`：真实装配、providerOptions 分派、Slack 实测
- P4 文档：`.env.example` / `AGENTS.md` / README 同步

## 用户明令禁止
- 不生成总结性 Markdown 文档
- 不生成测试脚本（允许新增 `*.test.ts` 源文件）
- 不编译、不运行（用户自行执行）
- 每个 chunk 完成必须通过 cunzhi 给用户 review，不能自行推进

## 当前状态
spec + plan 完成；等待用户明确授权进入 P1.1 代码实装。
尚未 commit 任何代码；两份 doc 已写入仓库。
