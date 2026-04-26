# 2026-04-26 Phase 1 上下文裁剪实现记录

## 背景

- 已修复并提交 maxSteps 耗尽终态：commit `b510614 修复 maxSteps 耗尽终态`。
- 当前新任务：实现 session 上下文压缩 Phase 1，并保留完整 `messages.jsonl`。
- 设计文档已更新：
  - `docs/superpowers/specs/2026-04-17-agent-slack-architecture-design.md`
  - `docs/superpowers/specs/2026-04-22-self-improve-design.md`

## Phase 1 决策

- 先实现 deterministic model-view pruning，不做 LLM summary compact。
- `messages.jsonl` 保持 append-only，`SessionStore.loadMessages()` 仍可完整读取历史。
- 只裁剪传给 `AgentExecutor.execute()` 的 `messages`。
- 新配置走 `config.yaml`：`agent.context.maxApproxChars`、`agent.context.keepRecentMessages`。
- 裁剪提示必须包含真实路径：`path.join(session.dir, 'messages.jsonl')`。
- 裁剪边界必须保护 AI SDK tool-call / tool-result pair，不能产生 orphan tool result。

## 当前实现计划

1. 在 `src/workspace/config.ts` 增加 `agent.context` 默认值。
2. 更新 `src/cli/templates.ts` 和 `README.md` 的 config 示例。
3. 新增纯函数模块构造 model-view messages。
4. `ConversationOrchestrator` 调用纯函数，executor 只拿裁剪后的视图。
5. 补充单测覆盖短历史、长历史裁剪、当前 user 保留、tool pair 不拆、真实路径提示、orchestrator 落盘完整。

## 后续未实现

- Phase 3：LLM compact summary + compact boundary。
- Phase 4：自动触发与熔断。

## Phase 1 实现结果

- 新增 `src/orchestrator/modelMessages.ts`，实现 deterministic model-view pruning。
- `ConversationOrchestrator` 传给 executor 的 messages 已改为预算内模型视图。
- 裁剪提示会包含当前 session 的真实 `messages.jsonl` 路径。
- 裁剪边界会向前扩展保留 assistant tool-call，避免保留 orphan tool-result。
- 新增 `agent.context.maxApproxChars` / `keepRecentMessages` 配置默认值，并同步 onboard 模板与 README。

## @mention compact command 实现结果

- 新增 `src/agents/compact/`，包含 compact agent、prompt、types、index。
- self-improve collector/generator/prompts/semantic dedup 已迁移到 `src/agents/selfImprove/`。
- `src/agent/tools/*` 保留 self-improve tool wrapper，核心逻辑改从 `src/agents/selfImprove/*` 引入。
- 新增 `ContextCompactor`，负责手动 compact 的运行时编排。
- 新增 `MentionCommandRouter`，支持 `@bot /compact`、`@bot compact`、`@bot 压缩上下文`、`@bot 帮我压缩当前上下文`。
- `ConversationOrchestrator` 在主 agent executor 前拦截命令，命中 compact 时不进入主 agent、不消耗主任务 `maxSteps`。
- 新增 live E2E：`compact-command`。
- 用户反馈 compact 结果应显示在 ending blocks 之上；已调整命令路径为先发送 compact 结果回复，再发送 completed 收口，不再触发 started 状态条。
- `SlackEventSink` 只在确实添加过 ack reaction 后才移除 ack，避免命令路径未 started 时产生 no_reaction 警告。
- live E2E 暴露真实竞态：上一轮 seed 回复的 usage/ending 可能在用户已发送 `/compact` 后才落到 Slack，插到 compact 结果上方。
- `ConversationOrchestrator` 已把 `sink.finalize()` 纳入同 session 串行队列，避免 finalize 与下一轮 runner 并发。
- `SlackAdapter`/`SlackEventSink` 已在发送 usage 前检查：若同 session 已排队，或 Slack thread 中已有同一用户的新消息，则抑制这条 stale usage。
- `compact-command` live E2E 已新增断言：`/compact` 命令消息与 compact 回复之间不能出现 usage/ending。
- compact 输出已改为短内容：只发 `[compact: manual]` 和摘要，不再额外说“已压缩当前上下文”，不展示 session/jsonl/本地路径。
- compact prompt / formatter 已过滤握手测试、原样回复、`COMPACT_COMMAND_*` 这类低价值内容，并限制摘要长度。
- `compact-command` live E2E 已新增断言：compact 回复必须短、无路径、无 seed 噪音。
- 新增 `src/agents/selfImprove/collectorAgent.test.ts` 和 `generatorAgent.test.ts`，直接覆盖公共 `src/agents/` 目录中迁移后的 self-improve collector/generator 功能。
- 新增 live E2E `self-improve-collect`，强制真实 agent loop 调用 `self_improve_collect`，验证迁移后的 collector tool-call / tool-result 会持久化。

## Phase 2 实现结果

- 新增 `agent.context.keepRecentToolResults` 配置，默认值为 `20`，同步 onboard 模板、README 与架构设计文档。
- `buildModelMessages()` 已在模型视图层保留最近 N 个完整 tool-result，更旧 tool-result 的 `result` 替换为占位提示。
- tool-result microcompact 只影响传给模型的 messages，不回写 `messages.jsonl`，也不删除 tool-call/tool-result 消息结构。
- 占位提示包含真实 `messages.jsonl` 路径，便于模型需要时读取完整历史。
- 单测覆盖旧 tool-result 压缩、最近结果保留、原始 history 不变、tool pair 结构合法。

## 已验证

- `pnpm vitest run src/orchestrator/ConversationOrchestrator.test.ts src/im/slack/SlackEventSink.test.ts`
- `pnpm vitest run src/orchestrator/ConversationOrchestrator.test.ts src/im/slack/SlackEventSink.test.ts src/im/slack/SlackAdapter.test.ts`
- `pnpm vitest run src/orchestrator/ContextCompactor.test.ts src/orchestrator/ConversationOrchestrator.test.ts`
- `pnpm vitest run src/agents/selfImprove/generatorAgent.test.ts src/agents/selfImprove/collectorAgent.test.ts src/orchestrator/ContextCompactor.test.ts src/application/createApplication.test.ts`
- `pnpm test src/orchestrator/modelMessages.test.ts src/orchestrator/ConversationOrchestrator.test.ts src/workspace/config.test.ts`
- `pnpm typecheck`
- `pnpm test`（33 files / 237 tests）
- `pnpm lint`
- `pnpm build`
- `pnpm e2e compact-command`（含 stale usage/ending、短内容、无路径、无 seed 噪音断言）
- `pnpm e2e self-improve-collect`（真实 Slack，验证 self_improve_collect 调用与 tool-result 持久化）
- `pnpm vitest run src/orchestrator/modelMessages.test.ts src/orchestrator/ConversationOrchestrator.test.ts src/workspace/config.test.ts`
- `pnpm test`（33 files / 239 tests）
