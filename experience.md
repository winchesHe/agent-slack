# 工程经验

> 改 provider / 写 e2e / 加单测 / 排查异常 前必读。
> 每条 = 触发条件 + 强制动作（不带反例叙述、不带历史故事）。
> 新条只在"已踩坑且会复发"时加。

## ai-sdk / Provider 装配

| 触发 | 强制 |
|---|---|
| 用 `createOpenAI({ name: X })` 透传字段 | `providerOptions` 的 key 必须用 SDK 内部字面量（@ai-sdk/openai 是 `'openai'`），与 `name` 无关。验证：`grep parseProviderOptions node_modules/.pnpm/@ai-sdk+*/dist/index.js` |
| provider 切到 `provider.responses(...)` | 不传 `providerNameForOptions`（让上游 stream_options 注入跳过）；`/responses` finish chunk 自带 usage |
| Tools 含 zod `.optional()` 字段 + provider=openai-responses | 必须 `providerOptions.openai.strictSchemas: false`，否则 LiteLLM 返回 400 `invalid_function_parameters`（required 必须含 properties 全部 keys） |
| 依赖 `@ai-sdk/openai` 的 reasoning-model 识别 | 锁版本下限到引入该 feature 的 commit。`gpt-5*` 识别需 ≥ 1.3.24（更早只匹配 `o*`） |
| 新增第三 provider 分支 | 三处必改：`AgentProvider` union / `ProviderEnv` union / `loadProviderEnv` + `buildProviderRuntime` 的显式 if 分支（不要 fallthrough，方便后续再加） |

## Live E2E

| 触发 | 强制 |
|---|---|
| 设计新 provider 的端到端冒烟 | prompt 必须**能触发 tools 调用**。不能用 `Do not use tools` 的 prompt 当 Phase 1 出口（会跳过 tools schema 校验等真实路径） |
| 想在 e2e 里拦 wire 请求做断言 | 不要用 `globalThis.fetch = spy`：在含 axios/Slack WebClient 的 import 链下不可靠（拦得到 Slack 拦不到 ai-sdk）。用业务终态反推：`(N thinking)` 出现 ⟹ /responses 端点 + reasoning + ai-sdk 解码全链路 OK |
| e2e 要用与默认 config 不同的 provider/option | 用 cwd workspace 临时备份 + 改写 `.agent-slack/config.yaml`，finally 还原。不要 tmp workspace（实测 socket mode 下 mention 进不来） |
| 依赖 reasoning summary 流式的 e2e | 包内部 retry：`for attempt in 1..2`，失败重置 matched 状态再 trigger；总 timeout = 单次 × 2 |
| live e2e 命名 | `src/e2e/live/run-<id>.ts`；scenario `id` 与文件名 `run-<id>.ts` 一致；`runDirectly(scenario)` 自动在 `process.argv[1]` 匹配时跑 |

## 单测（vitest）

| 触发 | 强制 |
|---|---|
| `vi.fn()` mock 接受 deps 的工厂 | 显式声明参数：`vi.fn((_deps: unknown) => ...)`，否则 `mock.calls[0]?.[0]` 推断为空 tuple，TS 报 `Tuple type '[]' has no element at index '0'` |
| 被测代码用懒调用工厂模式（`(tools) => createX(...)`） | 测试中从上游 mock 取 `args.executorFactory`，手动 `args.executorFactory(args.toolsBuilder({...}, {}))` 触发，再断 `createX.mock.calls[0]?.[0]` |
| 实现"零值时字段缺省" | 用 `...(x > 0 ? { x } : {})` spread 写法；测试用 `expect('x' in obj).toBe(false)` 验证（`obj.x === undefined` 对显式 `x: 0` 也 pass，不等价） |
| 修 bug 同步加单测 | 锁住反向断言（如 `providerName === undefined`、`strictSchemas === false`），防 review 时被"看似合理的优化"误删 |

## 错误诊断

**error path 用结构化 dump**：`src/agent/AiSdkExecutor.ts` 的 `case 'error'` 与 `catch (err)` 必须 log `errorJson` + `errorStack` + `responseBody` + `errorCause`。`redactErrorMessage(err)` 只做敏感词脱敏，会丢 stack 和 wire 响应体——不能作为唯一日志。

**日志去向取决于运行模式**：

| 模式 | log 位置 |
|---|---|
| `pnpm dev`（前台 tsx watch） | 终端 stdout |
| daemon | `.agent-slack/logs/agent-YYYY-MM-DD.log` |

排查 dev 模式不要 `tail` daemon log file。

**bot 异常状态分流**：

| 现象 | 含义 | 看哪里 |
|---|---|---|
| ❌ red_x reaction | application 进 lifecycle `failed`，**有具体错误** | `[error-part]` / `[catch-error]` log（结构化 dump） |
| 完全无 reaction、无 progress block | 没收到 mention 或 LLM stream hang | socket 状态 / LLM 请求 timeout / 多 daemon 抢 socket |

## Config schema 演进

| 触发 | 强制 |
|---|---|
| 新增 provider enum value | 同步改 `config.example.yaml`（注释 + model 提示）+ `.env.example`（凭证使用规则） |
| 新增 provider-specific 子字段（如 `agent.responses`） | example 写明"仅 X provider 时生效，其他 provider 不读但允许写"，避免用户误删 |
| 新增 sub-config 对象 | 必须 `.default({})`，不要 required（避免老 yaml 全部需要加 stub，零行为变化变 breaking） |

## 协作

| 触发 | 强制 |
|---|---|
| 当前 PR 范围外发现既存代码不一致 | 用 `mcp__ccd_session__spawn_task` 起独立 worktree 修，不要 commit 进当前 PR 历史 |
| spec/plan 实施过程中发现"事先没考虑"的问题 | 回写 spec 的"风险与回滚"或"实施发现"段落，给下一个类似项目用 |

## 速查路径

| 用途 | 文件 |
|---|---|
| Provider 装配 | `src/application/createApplication.ts:35-260` |
| Stream 事件处理 | `src/agent/AiSdkExecutor.ts` `ExecutorStreamPart` union + `for await` 循环 |
| Slack progress / usage 渲染 | `src/im/slack/SlackRenderer.ts` `buildProgressBlocks` / `formatUsageLine` |
| Live e2e 入口 / scenario 自动发现 | `src/e2e/live/cli.ts` `discoverScenarios` |
| Workspace 路径 | `src/workspace/paths.ts` `resolveWorkspacePaths` |
