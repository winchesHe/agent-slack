# 当前执行进度

当前进行中：

- `pi-slack-agent-foundation` 新基座技术方案已起草：spec 位于 [docs/superpowers/specs/2026-05-31-pi-slack-agent-foundation.md](../docs/superpowers/specs/2026-05-31-pi-slack-agent-foundation.md)；飞书架构设计文档已生成并重排为富文本版，总体架构已拆成 `启动装载` / `运行时请求流` 两张飞书画板，核心运行链路也已改为飞书画板渲染，且已明确 `Workspace Runtime -> RuntimeContext -> RunCoordinator -> SessionResolver -> Pi Runtime Adapter` 的职责和调用边界：[Moego Pi Slack Agent 基座架构设计](https://mengshikeji.feishu.cn/wiki/XIJYwjVf7inxwYkXRgEcIheznbf)。
- 已对齐关键决策：
  - 新项目不是 `agent-slack` 原地重构，也不是 `moego-sherlock` 产品化 fork，而是吸收两者优势的新 agent foundation。
  - workspace 目录名：`.moego-agent`。
  - 底层 runtime：`pi-agent-core` / `pi-ai` / `pi-coding-agent`。
  - session 模式：MVP 每轮 run open/resume pi transcript，结束 dispose；不做 warm session cache / idle sweep。
  - extension：单层，仅暴露 pi native extension / hook；不定义 `MoegoExtension` 包装层。
  - 事件：对 renderer 封装 `AgentRuntimeEvent`，不直接暴露 pi event。
  - 持久化：pi `transcript.jsonl` 是模型上下文恢复权威；产品侧只存 `meta.json` / `runs.jsonl` / logs，默认不存完整 `events.jsonl`；audit / artifacts 仅保留扩展位，MVP 不实现。
- 下一步：等待用户 review 飞书架构设计文档；确认后按 flow-spec 判定需要单独生成 plan（当前预计命中跨仓/SDK + schema，建议需要 plan）。

**最近完成（2026-05-28）：**

- `feature-current-thread-context` 分支冲突修复完成：保留当前 `runSlackSession` / queue usage 抑制逻辑，移除 `buildBuiltinTools` 中的全局 `current_thread_context` 注入。
- `current_thread_context` 改为 Slack adapter 入站路径（app mention / channel task）通过 `adapterTools` 注入；Wechat / Telegram / scheduled 非真实 Slack thread 路径不注入该工具。
- 验证：`pnpm vitest run src/agent/tools/tools.test.ts src/im/slack/SlackAdapter.test.ts src/orchestrator/ConversationOrchestrator.test.ts`、`pnpm typecheck`、变更文件 targeted ESLint/Prettier 均通过。完整 `pnpm lint` 仍受仓库既有非本次改动问题阻塞（`external-references/` JSX 解析、既有 `console.*`、`tests/upgrade.test.ts` 的 `any`）。

**最近完成（2026-05-16）：**

- agent-slack upgrade 命令补强 v0.1.9 schema 迁移漏洞（branch `feat/upgrade-im-migration`，plan：[docs/superpowers/plans/2026-05-16-upgrade-im-schema-migration.md](../docs/superpowers/plans/2026-05-16-upgrade-im-schema-migration.md)）
  - P0-1: `im.provider` → `im.enabled` 持久化字段改名迁移（用 yaml Document AST 保留注释/格式；运行时 `migrateLegacyImProvider` 不变，仍作没跑 upgrade 用户的兜底）
  - P0-2: scheduled-tasks `target.im` 跨文件校验 vs `config.im.enabled`，输出 warning + 修复建议（不自动改 enabled）
  - P1: 嵌套缺失警告附 generator 模板片段（agent.responses / agent.context.* / im.slack 等），剥离公共缩进供用户复制
- 触发场景：用户跑 `daemon start` 报"未在 config.im.enabled 中启用"，根因是 config.yaml 旧 `provider` 字段未持久化迁移 + scheduled-tasks 用 telegram 但 enabled=[slack]
- 端到端 dry-run 在用户实际 workspace 上一次复现两个根因

**最近完成（2026-05-11）：**

- scheduledTasks 主线 12 切片（归档：[memory/archive/process-2026-05-10-scheduled-tasks.md](archive/process-2026-05-10-scheduled-tasks.md)）
- 验证暴露的 2 个 bug fix：redactor `{err:{}}` 黑洞 + WechatAdapter.prepareForManualRun baseUrl 归一化
- spec §6.4 contextToken 持久化长期方案落地（Slice A-D）
- **filehelper 路径全量删除（Slice E）**：实测 filehelper 也需要 contextToken，没有"兜底联系人"特殊性
  - `runScheduledWechatSession` 改为：store 未命中 → 抛 `MissingContextTokenError`（runner 写 history failed）
  - `WechatAdapterDeps.contextTokenStore` 改必填
  - examples / README / spec §6.4 / e2e 脚本注释全部重写为唯一支持路径："target.to 必须是 store 已命中的 microid"
  - 错误信息友好指引（提示用户去补入站消息建立 token 缓存）

## 行为契约（最终）

微信 scheduled tasks 上线门槛：
1. daemon 必须先跑起来
2. target 联系人**先给 bot 发过一条入站消息**（store 自动落盘 token）
3. `target.to` 填那个联系人的 ilink_user_id（推 bot ↔ 管理员私聊：填 credentials.json 的 userId）

未命中 store → 抛 MissingContextTokenError → history failed，错误信息指引用户怎么修。

---

## 最近归档

- `memory/archive/process-2026-05-10-scheduled-tasks.md`：scheduledTasks 主线（4 chunk / 12 切片）
- `memory/archive/process-2026-05-10-spec-b.md`：Spec B 配置中心化
- `memory/archive/process-2026-04-29-spec-a.md`：Spec A
- `memory/archive/process-2026-04-29.md`：频道任务监听首版完结
- `memory/archive/process-2026-04-26.md`：上下文压缩执行过程
- `memory/archive/process-2026-04-23.md`：上下文压缩链路 Phase 1-4

## 下一步恢复提示

如需继续历史任务，先读对应归档文件，再检查 `git --no-pager status --short` 和最新提交。
