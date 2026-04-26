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

- 后续可继续增强 compact marker 结构化存储，减少自然语言前缀误判。

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

## Phase 3 实现结果

- `buildModelMessages()` 已识别最后一条 assistant 文本 `[compact:` summary 作为 compact boundary。
- 有 compact boundary 时，模型视图只保留最后 compact summary、boundary 后 tail、当前 user message，不再 replay 更早历史。
- compact summary 会被强制保留；预算裁剪只作用于 boundary 后 tail。
- Phase 1 裁剪提示和 Phase 2 tool-result microcompact 会继续作用于 boundary 后 tail。
- 单测覆盖最后 compact summary 续接、多次 compact 取最后一个、boundary 后 tail 裁剪、boundary 后 tool pair 保留。
- 新增 live E2E `compact-boundary`：先写入会被 compact 过滤的旧 marker，手动 compact 后再发下一轮消息，验证模型不会泄漏 boundary 前原始历史。

## Phase 4 设计决策

- 自动 compact 默认开启：达到 boundary 后候选模型视图预算 80% 时触发。
- 自动 compact 是主流程前置维护阶段：session 保持 `running`，同 thread 后续消息排队，compact 完成后继续本轮主 `AgentExecutor`。
- auto compact 等待期间 Slack 显示“正在整理上下文…”活动态；不把 `[compact: auto]` 当成最终回复展示。
- 自动 compact 成功后追加 `[compact: auto]` summary 并重建 model-view；失败时记录失败计数，回退 Phase 1/2 继续用户请求。
- 同 session 自动 compact 连续失败 2 次后熔断；手动 `/compact` 绕过熔断并继续向用户显示 compact 结果。

## Phase 4 实现结果

- 新增 `agent.context.autoCompact.enabled/triggerRatio/maxFailures` 配置，默认 `true/0.8/2`，同步 README 与 onboard 模板。
- `SessionStore` 扩展 `meta.context.autoCompact`，持久化 `failureCount`、`breakerOpen`、最近 attempt/success/failure 信息，并兼容旧 meta。
- `ContextCompactor.autoCompact()` 生成 `[compact: auto]` finalMessage，不走 Slack 可见 assistant-message。
- `ConversationOrchestrator` 在主 executor 前基于最后 compact boundary 后候选视图触发 auto compact；期间发送“正在整理上下文…”活动态，完成后 clear 并继续主 executor。
- auto compact 成功后追加 summary、重建 history/model-view、重置失败状态；失败时记录失败计数并继续 Phase 1/2，达到阈值后熔断。
- 新增 live E2E `auto-compact`，验证真实 Slack 下自动 compact 后主回复继续、`[compact: auto]` 持久化、不作为 Slack 回复展示、session 进入 idle 后再清理。
- 新增 live E2E `context-pruning-no-llm`，禁用 auto compact 并压低 `keepRecentMessages`，验证 deterministic pruning 隐藏旧上下文且不生成 `[compact:]` summary。

## 结构化 compact marker 与活动态 E2E 实现结果

- compact boundary 的权威 marker 改为 session 目录下的 `compact.jsonl`，每条记录包含 `schemaVersion/messageId/mode/createdAt`。
- `messages.jsonl` 仍保留 `[compact: manual|auto]` 人类可读摘要标题；模型视图优先用 `compact.jsonl.messageId` 找 boundary，旧 session fallback 到 `[compact:` 文本前缀。
- manual `/compact` 和 auto compact 成功后都会追加结构化 compact record。
- `auto-compact` live E2E 已显式捕获 Slack progress message `正在整理上下文…`，并验证 `compact.jsonl` 中存在 auto marker。
- `compact-command` live E2E 已验证 manual compact 会写入结构化 marker。

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
- `pnpm vitest run src/orchestrator/modelMessages.test.ts src/orchestrator/ConversationOrchestrator.test.ts`
- `pnpm test`（33 files / 243 tests）
- `pnpm e2e compact-boundary`（真实 Slack，验证 compact boundary 后不再回看 boundary 前原始历史）
- `pnpm vitest run src/workspace/config.test.ts src/store/SessionStore.test.ts src/orchestrator/modelMessages.test.ts src/orchestrator/ContextCompactor.test.ts src/orchestrator/ConversationOrchestrator.test.ts src/orchestrator/MentionCommandRouter.test.ts tests/live-e2e-cli.test.ts`
- `pnpm e2e auto-compact`（真实 Slack，验证自动 compact 和主流程继续）
- `pnpm e2e context-pruning-no-llm`（真实 Slack，验证无 LLM compact 的 deterministic pruning）
- `pnpm e2e context-pruning-no-llm compact-command compact-boundary auto-compact`（4 个 compact 覆盖场景全部 PASS）
- `pnpm vitest run src/store/SessionStore.test.ts src/orchestrator/modelMessages.test.ts src/orchestrator/ConversationOrchestrator.test.ts tests/live-e2e-cli.test.ts`
- `pnpm e2e compact-command auto-compact`（真实 Slack，验证 manual/auto 结构化 marker 与 auto 活动态）
- `pnpm e2e compact-boundary`（真实 Slack，验证结构化 marker 后 context boundary 仍成立）
