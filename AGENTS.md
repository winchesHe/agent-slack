# agent-slack System Rules

## Identity & Boundaries

单进程绑定 `process.cwd()` 的 Slack agent 服务；一期基座 = Vercel AI SDK（LiteLLM 默认；可切 Anthropic），存储 = 全 files。

**Do not**:
- 引入 SQLite / Drizzle / 任何 ORM — 全 files 存储（JSON/JSONL/Markdown）
- 引入 Claude Agent SDK / `@openai/agents` / 其他 agent 编排 SDK — 只用 `ai` 包
- 写全局单例或 import 时副作用 — 所有依赖经 `createApplication()` 注入
- 在 `IMAdapter` / `AgentExecutor` 之外硬编码 Slack 或模型细节
- 做架构层级变更而不先更新 design doc

## Core Behavior Rules

- 用户沟通和 commit 信息用中文（遵循 `~/.claude/CLAUDE.md` 全局指令）。
- 任务执行默认按 chunk 执行，执行完后给出测试建议让用户 review，不要直接提交代码，等用户确认后，再提交代码和执行下一步。
- 生成的代码需要中文注释。

## Code Standards

- 包管理 `pnpm`；禁用 `npm` / `yarn`。
- Node ≥ 22，TypeScript strict，ESM only。
- 路径别名 `@/` → `src/`；不跨目录用相对路径。
- 测试 `vitest`；`*.test.ts` 与源文件同目录；跨模块集成测试放 `tests/`。
- Slack live E2E 在 `src/e2e/live/run-*.ts`；用 `pnpm e2e:list` 查看，`pnpm e2e <id>` 或 `pnpm e2e` 运行（真实 Slack）。
- 修改 Slack 交互 / SlackRenderer / SlackAdapter / SlackEventSink / Slack tool UI 时，尽量补充或更新对应 live E2E 场景；不可自动化的交互在 PR/交付说明中写明原因。
- Lint `pnpm lint`（`eslint`）作为完成前最后一步；hook 失败修根因而非 `--no-verify`。
- Don't 用 `any` — 用 `unknown` + type guard。
- Don't 裸用 `console.*` — 用 `logger.withTag('<tag>')`。
- Don't 把凭证拼字符串 — 从 env 读并经 `redactor` 脱敏。

### Env / Config 单一权威原则（方案 A）
- **行为配置**（model / provider / maxSteps / skills / im / agent.name）只在 `config.yaml`；env 不参与。
- **env** 只放凭证（`SLACK_*` / `LITELLM_*` / `ANTHROPIC_*`）、部署差异（`*_BASE_URL`）、调试（`LOG_LEVEL` / `SLACK_RENDER_DEBUG`）。
- 禁止重新引入 `AGENT_MODEL` / `AGENT_PROVIDER` / `PROVIDER_NAME` 这类行为类 env 变量；如确需加新行为选项，加到 `src/workspace/config.ts` schema。

### Env 变更联动规则
对任何 env 变量的引入/修改/删除，必须**同步**更新以下处：
1. `src/application/createApplication.ts`（以及相关校验 / `loadProviderEnv` 分支）
2. `src/cli/templates.ts` 的 `defaultEnv`（onboard 写入模板）
3. `.env.example`（开源示例）
4. `.env`（本地开发模板，存在时追加注释块即可，**不动已有值**）
5. 相关 spec / README 对应段落

### Changing architecture
改 design doc → 用户 review → 改代码。Don't 在代码里做未登记的架构决策。

## Extra Context Sources

| 触发条件 | 查阅位置 |
|---|---|
| 架构 | `docs/superpowers/specs/2026-04-17-agent-slack-architecture-design.md` |

## Task Completion Checklist

- [ ] 相关 `*.test.ts` 全部通过
- [ ] 修改测试代码后，必须跑通对应测试，并用 `cunzhi` 告知测试结果
- [ ] Slack 交互变更已补/更新 live E2E，或说明无法自动化原因
- [ ] `pnpm lint` 无错误
- [ ] 任务完成已同步更新进度和 design doc
- [ ] 架构级变更已同步更新 design doc
