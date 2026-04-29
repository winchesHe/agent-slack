# 工程经验

> 每条都已踩坑且**会复发**；本次实施特定事件不进。
> 改 provider / 写 e2e / 加单测 / 排查异常前必读。

## ai-sdk / Provider 集成

| 触发 | 强制 |
|---|---|
| 用 `createOpenAI / createAnthropic / ...({ name: X })` 透传字段 | `providerOptions` 的 key 用 SDK 内部字面量（@ai-sdk/openai 写死 `'openai'`），与 `name` 无关。验证：`grep parseProviderOptions node_modules/.pnpm/@ai-sdk+*/dist/index.js` |
| 切上游 SDK 的新端点 / 新 mode | 实测 tool schema 与流式 usage 行为是否变。OpenAI Responses API 例：默认 strict function schema → 工具用 zod `.optional()` 必须 `providerOptions.openai.strictSchemas: false`；流式 finish 自带 usage → 不要透 `stream_options`（设 `providerNameForOptions: undefined`） |
| 依赖 SDK 某个 feature 的最新分支判断 | 锁 `package.json` 版本下限到引入该分支的 commit（例：`gpt-5*` reasoning 识别需 @ai-sdk/openai ≥ 1.3.24，1.3.22 只匹配 `o*`） |

## Live E2E

| 触发 | 强制 |
|---|---|
| 设计新 provider/feature 的端到端冒烟 | prompt 必须**能触发 tools 调用**。`Do not use tools` 类 prompt 会跳过 tools schema 校验等关键路径，给虚假绿灯 |
| 想在 e2e 拦 wire 请求做断言 | 不用 `globalThis.fetch = spy`：含 axios / Slack WebClient 的 import 链下不可靠（实测拦得到 Slack 拦不到 ai-sdk）。用业务终态反推（如 `(N thinking)` 出现 ⟹ 端点 + reasoning + 解码全链路 OK） |
| e2e 要换 provider/option 跑全链路 | 用 cwd workspace 临时备份 + 改写 `.agent-slack/config.yaml`，finally 还原。不要 tmp workspace（实测 socket mode 下 mention 进不来） |
| reasoning 流式 / 长上下文 e2e | 内置 `for attempt in 1..2` retry，失败重置 matched 状态再 trigger，总 timeout = 单次 × 2 |

## 单测（vitest）

| 触发 | 强制 |
|---|---|
| `vi.fn()` mock 接受参数的函数 | 显式声明：`vi.fn((_x: unknown) => ...)`，否则 `mock.calls[0]?.[0]` 推断为空 tuple，TS 报 `Tuple type '[]' has no element at index '0'` |
| 被测代码用懒调用工厂（`(tools) => createX(...)`） | 测试从上游 mock 取 args，手动 `args.factory(args.builder(...))` 触发，再断 `createX.mock.calls[0]?.[0]` |
| 实现"零值字段缺省" | 实现用 `...(x > 0 ? { x } : {})` spread；测试用 `expect('x' in obj).toBe(false)`（`obj.x === undefined` 对显式 `x: 0` 也 pass，不等价） |

## 错误诊断

**结构化 dump，不要只 `redactErrorMessage`**：`AiSdkExecutor` 的 `case 'error'` 与 `catch (err)` 必须 log `errorJson` + `errorStack` + `responseBody` + `errorCause`。`redactErrorMessage` 只做敏感词脱敏，会丢 stack 和 wire 响应体，无法定位是 ai-sdk 哪一层抛的或 wire 端拒了什么字段。

| 现象 | 排查方向 |
|---|---|
| bot ❌ red_x reaction | lifecycle `failed`，看 `[error-part]` / `[catch-error]` 结构化 log |
| bot 完全无 reaction、无 progress block | 没收到 mention 或 LLM stream hang。看 socket 状态 / LLM timeout / 多 daemon 抢 socket |
| `pnpm dev` 模式排查 | log 在终端 stdout，**不要** tail `.agent-slack/logs/`（那是 daemon mode） |

## Config schema

| 触发 | 强制 |
|---|---|
| 新增 sub-config 对象 | 必须 `.default({})`，避免老 yaml 全部加 stub 才能解析 — 否则零行为变化变 breaking |

## 协作

| 触发 | 强制 |
|---|---|
| 当前 PR 范围外发现既存代码不一致 / 待修小坑 | 用 `mcp__ccd_session__spawn_task` 起独立 worktree 修，不污染当前 PR commit 历史 |
