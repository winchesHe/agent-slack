# Telegram IM 适配器（outbound-only）设计

- 作者: winches（PM agent + spec reviewer 共审）
- 日期: 2026-05-12
- 状态: draft v2（PM 一审 + reviewer 一审改动已合入；待用户审）

## 1. 背景与目标

agent-slack 已有两个 IM 适配器：

- **Slack**：双向，承载 inbound（@bot / DM）+ scheduled tasks + channelTasks。
- **Wechat**：双向，但 [scheduled tasks 设计 §6.4](2026-05-10-wechat-im-adapter-design.md) 决定的 contextToken 长期方案要求**对端先发入站消息**才能拿到 fresh token；服务端 token TTL 实测 ~17 小时即失效，导致**纯无人值守的定时任务不可持续**。

用户的 4 条 scheduled tasks（self-chat / twitter-stock-dyn / aihot-virxact-3x / repo-pull-daily）都是定时主动推送。本期通过引入 Telegram 适配（outbound-only）解决 wechat 的不可持续问题。

### 目标

- 新增 `telegram` 作为 IM 提供方，**仅支持 outbound 推送 scheduled tasks 报告**到指定 chat_id。
- 复用 `runScheduled<IM>Session` 模式，scheduler / runner / CLI 不为新 IM 加 special case。
- daemon 启动期 `getMe` 探活，Telegram token 失效仅 warn 不阻塞 slack/wechat。
- sendMessage 4096 字符上限以下保留单条；超出按 markdown 段边界自动分片，片间 sleep 800ms 避 rate limit。

### 非目标（YAGNI）

- 不实现 inbound（webhook / long-poll）。bot 不响应用户消息。
- 不实现 ConfirmSender（outbound 用不到 ask-confirm）。
- 不实现 channelTasks 等价物。
- 不实现 sendDocument（一期分片连发足够；附件 fallback 等真撞 4096×N 上限再加）。
- 不实现自动重试（含 429 backoff）：失败写 history、人工排查。
- 不支持 `@username` 形式 target（私聊只能 chat_id；channel 走 chat_id 同样可行）。
- 不在 onboard / upgrade 中询问 telegram 凭证（用户手工 export）。
- selfImproveCollector 一期不收 telegram session（与 wechat 同样不被收集，已知可接受遗漏）。

## 2. 用户视角

```yaml
# .agent-slack/scheduled-tasks.yaml
- id: twitter-stock-dyn
  enabled: true
  cron: '1 8,12,22 * * *'
  prompt: |
    ...
  target:
    im: telegram
    to: '123456789'   # 你的 Telegram chat_id（私聊为正数；channel/group 为负数；本期只测过私聊）
```

```bash
# .agent-slack/.env.local
TELEGRAM_BOT_TOKEN=1234567890:ABCdefGHIjklMNOpqrSTUvwxYZ
```

启用最少 5 步（写进模板注释 + README）：

1. Telegram 找 `@BotFather`，`/newbot` 创建 bot 拿 token。
2. **打开你创建的 bot 私聊，发一条 `/start`**（必须做：bot API 不允许给从未交互的用户发消息；group/channel 则需把 bot 加为成员，channel 还需 administrator + post messages 权限）。
3. 浏览器开 `https://api.telegram.org/bot<TOKEN>/getUpdates` 拿 chat_id（`result[0].message.chat.id`）。**如果 result 是 `[]`：回去补做第 2 步并稍等几秒**。**如果返回 409**：说明你给同 bot 设过 webhook，先 `https://api.telegram.org/bot<TOKEN>/deleteWebhook` 再来。
4. `.agent-slack/.env.local` 加 `TELEGRAM_BOT_TOKEN=...`；`.agent-slack/config.yaml` 的 `im.enabled` 数组加 `telegram`。
5. `scheduled-tasks.yaml` 把 `target` 改为 `{ im: telegram, to: '<chat_id>' }`，重启 daemon。

CLI 手动触发与现有 IM 一致：

```bash
agent-slack scheduled-tasks run <id>
```

## 3. 架构

```
┌────────────────── daemon process ───────────────────────────┐
│  ScheduledTaskScheduler                                     │
│    └─ cron fire ─► runner.runOnce(rule, 'cron')             │
│                      └─ if rule.target.im === 'telegram':   │
│                         └─ telegramScheduledHook.run({...}) │
│                            └─ runScheduledTelegramSession() │
│                               ├─ build InboundMessage       │
│                               ├─ TelegramEventSink(api,to)  │
│                               └─ orchestrator.handle(...)   │
│                                  └─ EventSink.finalize()    │
│                                     └─ Renderer.flush()     │
│                                        └─ chunks.forEach    │
│                                           ├─ api.sendMessage│
│                                           └─ sleep 800ms    │
│                                                             │
│  TelegramAdapter.start() ── api.getMe() （warn-only）       │
└─────────────────────────────────────────────────────────────┘

CLI: agent-slack scheduled-tasks run <id>
  └─ 独立进程 createApplication()
     └─ env TELEGRAM_BOT_TOKEN 缺失 → ConfigError throw（exit 1）
        └─ 与 daemon 共用 runner.runOnce(rule, 'manual')（不直接调 scheduled function）
```

### 模块边界 — `src/im/telegram/`

| 文件 | 职责 | 行数估算 |
|---|---|---:|
| `TelegramApi.ts` | 裸 fetch 封装 Bot API：`sendMessage` / `getMe` / `_post`；catch 429 → 从 `parameters.retry_after` 富化 error message。**构造签名 `new TelegramApi({ token })`**，token 在构造时注入；不实现 `setToken` / `loadCredentialsOnly`（与 wechat 不同——wechat 有扫码后 token 切换需求，telegram 没有）。 | ~50 |
| `TelegramRenderer.ts` | 累积 agent 流式事件 → flush 时 markdown→HTML（标题→`<b>`、表格→`<pre>`、链接→`<a>`、其它 escape `<>&`）→ 按 `\n\n`→`\n`→硬切 三级 fallback 切成 ≤4000 字符 chunks。**硬切按 code point**（`[...str]`）避免 UTF-16 代理对截断。 | ~120 |
| `TelegramEventSink.ts` | 实现 `EventSink`；**首次 `onEvent` 调用时**（不是某个特定 lifecycle phase）fire-and-forget 发起始消息 `⏳ 任务执行中...`；finalize 时拿 chunks 循环 sendMessage，**片间 sleep 800ms**；HTML parse_mode 失败 → 该 chunk 自动降级 `parse_mode=undefined` 重发一次（保证用户至少收到内容） | ~100 |
| `TelegramAdapter.ts` | 实现 `IMAdapter`（`id='telegram'` / `start()` 调 getMe 仅 warn / `stop()` no-op）；暴露 `scheduledHook.run({ taskId, to, prompt })` 构造 InboundMessage + EventSink 链路 | ~120 |
| `scheduled.ts` | `runScheduledTelegramSession({ taskId, to, prompt, api, deps })` 纯函数，CLI 与 daemon hook 共用 | ~50 |
| `*.test.ts` | 同目录 vitest（详见 §7）| - |

**对外暴露**（与 SlackAdapterHandle / WechatAdapterHandle 同形态）：

```ts
export interface TelegramAdapterHandle {
  adapter: IMAdapter
  scheduledHook: { run(args: { taskId: string; to: string; prompt: string }): Promise<void> }
}

// 注意 deps 比 wechat / slack 简化：telegram 不需要 runQueue / abortRegistry / confirmBridge / channelTasks
export function createTelegramAdapter(deps: {
  api: TelegramApi
  orchestrator: ConversationOrchestrator
  logger: Logger
}): TelegramAdapterHandle
```

`IMAdapter` 公共接口（`id` / `start` / `stop`）保持不动。`createApplication` 装配增量 ≈ 一行 push 进 adapters[]、一行注入 hook 给 runner、可选一行 `app.telegramHandle = handle`（CLI / 测试拿 handle）。

### 与 wechat 的关键简化

| 关注点 | wechat | telegram |
|---|---|---|
| 凭证持久化 | `CredentialsStore` + QR 登录主循环 | env 变量直读 |
| Token 刷新 | `ContextTokenStore`（per-peer，入站时 save） | 无 token，bot token 长期有效 |
| `loadCredentialsOnly` | 必须，CLI 走它避免触发 QR | 不需要，CLI 直接走 runner |
| Inbound | long-poll + ContextToken 落盘 | 不实现 |
| `scheduled.ts` 行数 | ~80 | ~50 |
| Adapter deps | 含 `runQueue` / `abortRegistry` / `contextTokenStore` | 仅 `api` / `orchestrator` / `logger` |

## 4. 配置与 Schema

### 4.1 `ImProvider` 类型扩展

```ts
// src/im/IMAdapter.ts（既有文件）
export type ImProvider = 'slack' | 'wechat' | 'telegram'
```

### 4.2 ScheduledTask target 类型与 schema

**`src/scheduledTasks/types.ts`**（必须改，否则 runner.buildTarget 类型不收敛）：

```ts
export type ScheduledTaskTarget =
  | { im: 'slack'; channelId: string }
  | { im: 'wechat'; to: string }
  | { im: 'telegram'; to: string }   // 新增
```

**`src/scheduledTasks/config.ts`**：

```ts
const TelegramTargetSchema = z.object({
  im: z.literal('telegram'),
  to: z.string().min(1),   // chat_id 字符串形式（zod discriminated union 内部统一字符串）
})

const TargetSchema = z.discriminatedUnion('im', [
  SlackTargetSchema,
  WechatTargetSchema,
  TelegramTargetSchema,
])
```

### 4.3 `config.yaml` schema

```ts
// src/workspace/config.ts
im: z.object({
  enabled: z.array(z.enum(['slack', 'wechat', 'telegram'])).default([...]),
})
```

### 4.4 IM 启用交叉校验

`createApplication` 在加载 scheduled-tasks.yaml 后，对每条 enabled 的 task 检查 `target.im` 是否在 `config.im.enabled` 中。未启用直接抛错（沿用 wechat 已有行为）。

### 4.5 Env 与启动 fail-fast

`createApplication` 在 `config.im.enabled.includes('telegram')` 时：

- `process.env.TELEGRAM_BOT_TOKEN` 缺失 → 走 `requireEnv('TELEGRAM_BOT_TOKEN')`（既有 helper，抛 `ConfigError`，与 slack/wechat 缺凭证一致归类）→ daemon / CLI 进程 exit 1。

### 4.6 `runner.ts` 增量

**必改**（reviewer 必撞点）：

- `CreateScheduledTaskRunnerDeps` 加 `telegramHook?: TelegramScheduledHookLike`
- `runOnce` 路由分支加 `if (rule.target.im === 'telegram')`：缺 hook → history failed `error: 'adapter-not-enabled'`（与 slack/wechat 镜像）；有 hook → 调 `deps.telegramHook.run({...})`
- `buildTarget` 加 telegram case：`return { im: 'telegram', to: rule.target.to }`

### 4.7 `SessionStore.pickSessionDir` 增量

**必改**（reviewer 必撞点 — exhaustive switch 加 telegram 后 `const _exhaustive: never` 编译失败）：

```ts
// src/store/SessionStore.ts:268
switch (imProvider) {
  case 'slack': ...
  case 'wechat': ...
  case 'telegram':
    // telegram: per-chat 单会话，channelName=channelId=threadTs=chatId
    return telegramSessionDir(paths, args.channelId)
  default:
    const _exhaustive: never = imProvider
    ...
}
```

新加 `telegramSessionDir(paths, chatId): string` helper 在 `src/workspace/paths.ts`，落 `sessions/telegram/<chat_id>/`。

### 4.8 `Application` 类型扩展

```ts
// src/application/types.ts
export interface Application {
  ...
  wechatHandle?: WechatAdapterHandle
  telegramHandle?: TelegramAdapterHandle   // 新增
  ...
}
```

CLI 测试 / 手工调试可拿到 handle。

### 4.9 模板源联动

| 文件 | 改动 |
|---|---|
| `examples/config.example.yaml` | `im.enabled` 注释加 `# - telegram   # 启用：取消注释；首次启动需 export TELEGRAM_BOT_TOKEN=xxxxx 到 .env.local` |
| `examples/scheduled-tasks.example.yaml` | 加一条 telegram target 示例任务（注释引导 5 步启用） |
| `examples/.env.example` | **加在文件 `# ---------- 日志 & 调试 ----------` sentinel 之前**（避免与 `templates/env.ts` 的 TAIL 切分冲突）；只追加注释行 `# TELEGRAM_BOT_TOKEN=` |
| `src/workspace/templates/env.ts` | 不动（onboard 不询问 telegram；`generateEnvLocal` 不为 telegram 注入兜底） |
| `src/workspace/templates/templates.test.ts` | 跑一遍守护字节断言；如失败按 examples 改动同步 |

### 4.10 联动检查清单（按 AGENTS.md §Env/Config）

| # | 项 | 是否动 |
|---|---|---|
| 1 | Schema | ✅ §4.1 / §4.2 / §4.3 |
| 2 | 模板源 | ✅ §4.9 |
| 3 | upgrade.ts | ❌ 仅扩枚举值 + 子 schema，无新顶层 key |
| 4 | Dashboard 字段表单 | ❌ target 是 task 粒度，走 raw yaml |
| 5 | 运行时装配 | ✅ `createApplication.ts` 加 telegram 分支 |
| 6 | examples/ 模板 | ✅ §4.9 |
| 7 | env | ✅ `.env.example` 仅追加注释（位置见 §4.9）|
| 8 | spec / README | ✅ 本 spec + README + 架构 spec |
| 9 | **runner.ts** | ✅ §4.6（reviewer 补） |
| 10 | **types.ts (ScheduledTaskTarget)** | ✅ §4.2（reviewer 补） |
| 11 | **SessionStore.pickSessionDir** | ✅ §4.7（reviewer 补） |
| 12 | **paths.ts (telegramSessionDir)** | ✅ §4.7（reviewer 补） |
| 13 | **Application 类型** | ✅ §4.8（reviewer 补） |
| 14 | selfImproveCollector | ❌ 一期不收 telegram session（已知遗漏，与 wechat 一致） |
| 15 | onboard CLI | ❌ 一期不询问 telegram 凭证（用户手工 export） |

## 5. 数据流详解

### 5.1 daemon 启动期

```
agent-slack daemon start
└─ createApplication()
   ├─ load config.yaml → im.enabled.includes('telegram')?
   ├─ if yes:
   │   ├─ requireEnv('TELEGRAM_BOT_TOKEN') → 缺失抛 ConfigError（exit 1）
   │   ├─ new TelegramApi({ token })
   │   ├─ const tgHandle = createTelegramAdapter({ api, orchestrator, logger })
   │   │   └─ adapter.start() 内部 await api.getMe()
   │   │       ├─ ok → logger.info "Telegram adapter 已就绪 botUsername=@xxx"
   │   │       └─ err → logger.warn "Telegram getMe 失败: <err>，daemon 仍继续；scheduled 触发会再失败一次"
   │   │           注意：getMe ok **不等于** chat_id 可达；bot 是否被踢 group / 是否被 block / chat_id 是否合法仅在 sendMessage 才知道。
   │   ├─ adapters.push(tgHandle.adapter)
   │   ├─ runner deps.telegramHook = tgHandle.scheduledHook
   │   └─ app.telegramHandle = tgHandle
└─ daemon.start()
   └─ 各 adapter.start() —— telegram 已在装配期 start，这里调用相当于 no-op（start 实现需幂等）
```

### 5.2 cron fire 一次

```
croner job 触发
└─ scheduler in-flight Map 检查（per taskId）
   ├─ has → history append skipped（与 slack/wechat 路径一致）
   └─ runner.runOnce(rule, 'cron')
      ├─ runId = `${rule.id}:${ISO}:cron`
      ├─ history append started
      ├─ buildTarget(rule) —— telegram case 返回 { im:'telegram', to: rule.target.to }
      ├─ rule.target.im === 'telegram' 分支：
      │   ├─ if !deps.telegramHook → history failed error='adapter-not-enabled'
      │   └─ deps.telegramHook.run({ taskId, to, prompt })
      │      └─ runScheduledTelegramSession 纯函数：
      │         ├─ inbound = {
      │         │     imProvider: 'telegram',
      │         │     channelId: to,
      │         │     channelName: to,           // 不调 getChat 一期，省一次 API
      │         │     threadTs: to,              // session 路由 key（per-chat 单会话隔离）
      │         │     messageTs: <generated id>,
      │         │     userId: 'scheduler',
      │         │     userName: 'scheduler',
      │         │     text: prompt,
      │         │     // confirmSender 不携带（A 方案不支持）
      │         │   }
      │         ├─ const sink = new TelegramEventSink({ api, chatId: to, renderer: new TelegramRenderer() })
      │         │   首次 onEvent 调用时 fire-and-forget sendMessage("⏳ 任务执行中...")
      │         │   失败 → logger.warn 不阻塞主流程
      │         └─ orchestrator.handle(inbound, sink)
      │            └─ agent 跑完 → sink.finalize()
      │               ├─ renderer 把累积 markdown → HTML → 切 chunks
      │               └─ for chunk of chunks:
      │                  ├─ try api.sendMessage(to, chunk, { parse_mode: 'HTML', disable_web_page_preview: true })
      │                  ├─ catch (parse_mode 错 / "can't parse entities") → 重发一次 parse_mode=undefined
      │                  ├─ if 仍失败 → throw（runner 写 history failed）
      │                  └─ if not last chunk: await sleep(800)
      ├─ ok → history success
      └─ throw → history failed; error 含 retry_after（如果是 429）/ description（4xx）
```

`confirmSender` 留空 → toolsBuilder 不挂 confirm tool → agent 看不到 ask-confirm（与现有 scheduled 路径一致）。

### 5.3 CLI 手动触发

**关键修正**（reviewer 指出原 spec 错）：CLI **不直接调 `runScheduledTelegramSession`**，而是和 daemon 一样走 `app.scheduledTasks.runner.runOnce(rule, 'manual')`。这意味着 telegram 在 `scheduledTasks.ts` CLI 里**零改动**（不像 wechat 需要 `prepareForManualRun` preflight）。

```
agent-slack scheduled-tasks run <id>
└─ createApplication()  // 独立进程
   ├─ load yaml → 找 rule by id（找不到 exit 2，沿用既有 code）
   ├─ rule.target.im === 'telegram':
   │   ├─ requireEnv('TELEGRAM_BOT_TOKEN') 已在 createApplication 阶段做 fail-fast
   │   └─ runner / hook 在 createApplication 里都装配好了
   └─ await app.scheduledTasks.runner.runOnce(rule, 'manual')
```

**CLI exit code 表**（含已有 5；不发明 telegram 专属 code）：

| code | 触发 |
|---|---|
| 0 | 成功 |
| 1 | 一般运行时错误 / 凭证缺失（含 telegram）/ ConfigError |
| 2 | rule 不存在 |
| 3 | wechat 凭证缺失（既有专门 code，沿用）|
| 4 | target.im 对应 IM 在 config.im.enabled 中未启用 |
| 5 | yaml 缺失 / schema 错（既有，sched-tasks.ts:39,43）|

## 6. 错误处理与边界

| 场景 | 行为 |
|---|---|
| `TELEGRAM_BOT_TOKEN` 缺失（启用 telegram） | daemon / CLI 启动 ConfigError throw，exit 1 |
| `getMe` 启动失败（token 错 / 网络） | logger.warn，daemon 继续起；首次 sendMessage 才再次报错 |
| **HTML parse_mode 失败**（`can't parse entities`） | catch → 同 chunk 自动重发一次 `parse_mode=undefined`（plain text）；仍失败 → throw |
| `sendMessage` HTTP 429 | catch 后从 `response.parameters.retry_after` 拼 error message 抛出；**不自动 retry** |
| `sendMessage` 403 `bot can't initiate conversation with a user` | throw → history failed，error 提示"对端需先发 /start" |
| `sendMessage` 403 `bot was kicked` / `not a member of channel chat` / `need administrator rights` | throw → history failed，error 含 raw description；README 注明 group/channel 配置要点 |
| `sendMessage` 400 `chat not found` | throw → history failed，error 提示"检查 chat_id 是否正确" |
| `sendMessage` 5xx / 网络 timeout | throw → history failed |
| 单条 chunk 发失败 → 后续 chunks 跳过 | 是（first error 立刻 propagate；不发 partial 后再 throw 的复杂模式） |
| 起始消息 fire-and-forget 失败 | logger.warn，不阻塞主流程 |
| 内容为空 | renderer 输出 0 chunks → finalize 直接返回 → history success（与 slack/wechat 一致） |
| daemon SIGTERM 期间 chunk 间 sleep 800ms | 裸 setTimeout 不被 abort，最多多等 800ms；fetch 会被 process exit 中断 |
| daemon SIGTERM | scheduler.stop() + adapters.stop()；in-flight 不 graceful drain |
| 中文字符被切到代理对中间 | renderer 切片用 `[...str]` 按 code point 切，不会截到代理对 |
| global rate limit 30 msg/sec | 用户 4 个 task 不可能撞，不防御；如未来 fan-out 出现需补 |
| per-chat 1 msg/sec | 已用 800ms 段间隔 cover |

### 6.1 起始消息策略（与 wechat 对齐）

scheduled task 30s+ 无反馈，用户体感差。`TelegramEventSink` 在**首次 `onEvent` 调用时**（任意事件类型，不依赖某个特定 lifecycle phase——参考 wechat 实现）fire-and-forget 发一条 `⏳ 任务执行中...`：

- 不 await（不阻塞 onEvent 返回）
- 失败只 logger.warn，不影响后续 chunks
- finalize 时正常发完整报告 chunks

> 如果未来发现起始消息打扰用户（例如 self-chat 这种 5 字任务也发占位），可在 task 粒度加 `silent: true` 选项跳过起始消息。一期不做。

## 7. 测试策略

### 7.1 单测

| 文件 | 覆盖点 |
|---|---|
| `TelegramApi.test.ts` | mock `globalThis.fetch`：sendMessage 正常 / 429（验 retry_after 进 error）/ 400 含 description / 5xx / timeout；getMe 成功失败两路 |
| `TelegramRenderer.test.ts` | markdown→HTML 转换（标题 `#` → `<b>`、表格 → `<pre>`、链接 → `<a>`、特殊字符 escape `<>&`）；分片：≤4000 不切 / 4001 按 `\n\n` 切 / 长无段边界硬切 / 中文不被切到代理对中间（用 `'\u{1F600}'` repeat 验代理对） |
| `TelegramEventSink.test.ts` | **首次 onEvent 调用触发起始消息 fire-and-forget**（不依赖特定 phase）；起始消息失败 warn 不 throw；finalize 调 sendMessage 次数 = chunks 数；**HTML parse_mode 失败自动降级 plain text 重发**（mock fetch 第一次返回 400 "can't parse entities"，第二次 200，验第二次 body 不带 parse_mode）；**用 `vi.useFakeTimers()` + `await vi.advanceTimersByTimeAsync(800)` 验证片间真过 800ms**（不只是验调用次数；用 await 形式避免循环 await sendMessage 后未推进 microtask 导致测试 hang）；sendMessage 抛错 → finalize 抛错且后续 chunks 跳过 |
| `TelegramAdapter.test.ts` | start 调 getMe；getMe 失败仅 warn 不 throw；start 幂等（多次调用安全）；scheduledHook.run 路径正确（mock orchestrator.handle 验 hook.run 触发）|
| `scheduled.test.ts` | **独立保留**（reviewer 反对 PM 的"合并"建议，理由：pure function 单独测更天然）。覆盖 InboundMessage 字段：imProvider='telegram'、channelId=channelName=threadTs=to、userId=userName='scheduler'、confirmSender undefined、text=prompt |

### 7.2 集成测

- `src/application/createApplication.test.ts` 扩：
  - im.enabled 含 telegram + 缺 env → ConfigError throw
  - im.enabled 含 telegram + env 齐 → handle 装配成功 + adapter 进 adapters[] + scheduledHook 注入到 runner + `app.telegramHandle` 可读
- `src/scheduledTasks/runner.test.ts` 扩：
  - target.im='telegram' 路由到 telegramScheduledHook（mock）
  - **target.im='telegram' 但 deps.telegramHook 缺失 → history failed error='adapter-not-enabled'**（slack/wechat hook 缺失镜像用例）
  - history 起止记录 + trigger 标签

### 7.3 已有 adapter 测试守护重构

不涉及（slack / wechat 适配本次零修改）。

### 7.4 Live E2E（follow-up，不进本期 PR）

按 AGENTS.md，仅 Slack 强制 live E2E。本期 PR 范围控住单测 + 集成测足以发 4 个 scheduled task 跑通。

后续可加 `src/e2e/live/run-scheduled-task-telegram.ts`：
- 跑前需 env `TELEGRAM_BOT_TOKEN` + `TELEGRAM_TEST_CHAT_ID`，缺则 skip
- 测三类长度（<200 / ~3000 / ~10000 字符）确认分片正确
- 作为独立 follow-up commit

## 8. 依赖与库选择

新增 npm 依赖：**0**。

裸 `fetch`（Node 22 内置）调 Telegram Bot API。理由（PM Q2）：sendMessage + getMe 两个端点共 ~50 行，加 grammy/telegraf 反而打破 wechat 已有的"裸 fetch + 自实现 _post"风格一致性。

## 9. 文档与上游联动

- 本 spec：`docs/superpowers/specs/2026-05-12-telegram-im-adapter-design.md`
- README 加一节 "Telegram outbound（scheduled tasks）"，给最少 5 步启用步骤；现有 Slack 入门叙述（`@agent-slack 你好`）不变
- 架构 spec [`2026-04-17-agent-slack-architecture-design.md`](2026-04-17-agent-slack-architecture-design.md) "模块组成"段落补 telegram 模块引用
- AGENTS.md 已有 wechat 出站约束段落 → 新增并列段落 "Telegram 出站约束（含 scheduled tasks）"，明确：
  - 仅 outbound，bot 不响应入站
  - target.to 必须是数字 chat_id 字符串（私聊正、group/channel 负，本期只测过私聊）
  - 私聊：对端必须先发 /start；group：bot 加为成员；channel：bot 加为 administrator + post messages 权限
  - 长报告按 4000 字符自动分片，5-10 条连发是预期行为
  - HTML parse_mode 失败自动降级 plain text，仍失败才 history failed

## 10. 已知风险与权衡

| 决策 | 权衡 |
|---|---|
| 不实现 inbound | bot 不能接收用户消息或 ConfirmSender；与 A 方案目标一致，未来加 webhook 增量小 |
| 裸 fetch 不引库 | 缺少类型完善的 method namespace；但 outbound 只用 sendMessage + getMe，trade-off 划算 |
| HTML parse_mode + plain text fallback | 表格用 `<pre>` 等宽块视觉一般；但比 MarkdownV2 转义稳定一个量级，且 fallback 兜底"渲染挂掉也能收到内容" |
| 不自动重试 429 | 与 slack/wechat 一致；retry_after 进 error message 给人工排查 |
| 起始消息 fire-and-forget | 给用户即时反馈，代价是每次 task 多一条消息；可接受 |
| 不实现 sendDocument | 一期分片连发够用；真撞 4096×N 上限再加附件 fallback |
| 单 chunk 失败立刻停 | 简化逻辑；partial 发了一半再 fail 用户更困惑 |
| 硬切按 code point | UTF-16 代理对截断会显示乱码；用 `[...str]` 切代价 O(N)，对 10K 字符可接受 |
| selfImproveCollector 不收 telegram session | 一期遗漏，与 wechat 一致；如未来 self-improve 重要再扩 collector |
| onboard 不询问 telegram 凭证 | 用户手工 export 即可；onboard 加新分支不在本期范围 |
