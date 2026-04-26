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

- Phase 2：旧 tool-result microcompact。
- Phase 3：LLM compact summary + compact boundary。
- Phase 4：自动触发与熔断。
- @mention command router 的 `compact` 手动入口。
- `src/agents/` 目录迁移与 compact/selfImprove agents 归口。

## Phase 1 实现结果

- 新增 `src/orchestrator/modelMessages.ts`，实现 deterministic model-view pruning。
- `ConversationOrchestrator` 传给 executor 的 messages 已改为预算内模型视图。
- 裁剪提示会包含当前 session 的真实 `messages.jsonl` 路径。
- 裁剪边界会向前扩展保留 assistant tool-call，避免保留 orphan tool-result。
- 新增 `agent.context.maxApproxChars` / `keepRecentMessages` 配置默认值，并同步 onboard 模板与 README。

## 已验证

- `pnpm test src/orchestrator/modelMessages.test.ts src/orchestrator/ConversationOrchestrator.test.ts src/workspace/config.test.ts`
- `pnpm typecheck`
- `pnpm test`
- `pnpm lint`
- `pnpm build`
