# agent-slack System Rules

## Identity & Boundaries

单进程绑定 `process.cwd()` 的 Slack agent 服务；一期基座 = Vercel AI SDK + LiteLLM，存储 = 全 files。

**Do not**:
- 引入 SQLite / Drizzle / 任何 ORM — 全 files 存储（JSON/JSONL/Markdown）
- 引入 Claude Agent SDK / `@openai/agents` / 其他 agent 编排 SDK — 只用 `ai` 包
- 写全局单例或 import 时副作用 — 所有依赖经 `createApplication()` 注入
- 在 `IMAdapter` / `AgentExecutor` 之外硬编码 Slack 或模型细节
- 做架构层级变更而不先更新 design doc

## Core Behavior Rules

- 用户沟通和 commit 信息用中文（遵循 `~/.claude/CLAUDE.md` 全局指令）。
- 任务执行默认按 chunk 执行，执行完后给出测试建议让用户 review 后，再让用户确认执行下一步，除非用户特殊指定一次完成全部任务。
- 生成的代码需要中文注释。

## Code Standards

- 包管理 `pnpm`；禁用 `npm` / `yarn`。
- Node ≥ 22，TypeScript strict，ESM only。
- 路径别名 `@/` → `src/`；不跨目录用相对路径。
- 测试 `vitest`；`*.test.ts` 与源文件同目录；跨模块集成测试放 `tests/`。
- Lint `pnpm lint`（`eslint`）作为完成前最后一步；hook 失败修根因而非 `--no-verify`。
- Don't 用 `any` — 用 `unknown` + type guard。
- Don't 裸用 `console.*` — 用 `logger.withTag('<tag>')`。
- Don't 把凭证拼字符串 — 从 env 读并经 `redactor` 脱敏。

### Changing architecture
改 design doc → 用户 review → 改代码。Don't 在代码里做未登记的架构决策。

## Extra Context Sources

| 触发条件 | 查阅位置 |
|---|---|
| 架构 | `docs/superpowers/specs/2026-04-17-agent-slack-architecture-design.md` |

## Task Completion Checklist

- [ ] 相关 `*.test.ts` 全部通过
- [ ] `pnpm lint` 无错误
- [ ] 任务完成已同步更新 design doc
- [ ] 架构级变更已同步更新 design doc
