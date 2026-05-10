# 微信（个人号）IM 适配器接入设计

- 创建日期：2026-05-10
- 依赖前置：[2026-04-17-agent-slack-architecture-design.md](2026-04-17-agent-slack-architecture-design.md)（IM 抽象层与 Slack 接入现状）、[2026-04-23-ask-confirm-design.md](2026-04-23-ask-confirm-design.md)（confirm tool 当前实现）
- 参考实现：`external-references/CowAgent/channel/weixin/`（Python，HTTP-only 反向 SDK，跳过 OpenClaw runtime）

## 1. 目标

把当前仓库的 IM 抽象从"硬编码 Slack"扩展成"多 IM 同进程并存"，并把**个人微信号**作为第二个 IM 接入。微信通道只支持单聊文本（MVP），与 Slack 对等共用同一个 orchestrator / sessionStore / agent / memory。

**MVP 验证目标**：工作区配置 `im.enabled: ['wechat']` 后启动服务、扫码登录、个人微信给 bot 发"hi"、agent 跑完一轮工具调用、bot 回一条文本，Slack 路径无回归。

**非目标（MVP 外，后续切片立项）**：

- 入站图片 / 语音 / 文件 / 视频解析（需要 AES-128-ECB + CDN 解密）
- 出站图片 / 视频 / 文件发送（同上）
- 流式输出（微信无 `chat.update` 等价 API，强行实现等于反复刷半成品）
- 多账号同进程（凭证文件就一份，要切号删文件重启）
- Typing 指示（`sendtyping` API，先不上）
- Channel Tasks（cron 触发推送，Slack 当前用，wechat 单聊语义不同，等明确需求再设计）
- 群聊（OpenClaw plugin 自身不支持）
- 微信侧专属 system prompt（让 agent 知道自己在哪个 IM）

## 2. 接入路径选型

调研发现腾讯官方 `@tencent-weixin/openclaw-weixin` plugin 内部对接的就是 `https://ilinkai.weixin.qq.com/ilink/bot/*` 这套 HTTP API；CowAgent 的 `channel/weixin/` 已经是这套 API 的反向工程实现。

**决策**：直连 ilink bot HTTP API，不部署 OpenClaw runtime、不写 plugin 形态。直接把 CowAgent Python 翻译成 TypeScript。

依据：
- 不引入 OpenClaw runtime 这一额外部署组件
- 本仓库与 CowAgent 共用同一组 endpoint 和加解密协议
- 部署形态保持"一个 Node 进程"，与 Slack 对齐

## 3. 架构概览

```
                       createApplication
                                │
              ┌─────────────────┴────────────────┐
              ▼                                  ▼
       SlackAdapter                      WechatAdapter (新)
      (Socket Mode)                    (HTTP long-poll)
              │                                  │
              │  InboundMessage                  │  InboundMessage
              │  (imProvider:'slack',            │  (imProvider:'wechat',
              │   confirmSender:SlackConfirm)    │   confirmSender:undefined)
              │                                  │
              └────────────► Orchestrator ◄──────┘
                                  │
                           ToolsBuilder
                  (按 ctx.confirm 存在条件性
                  注入 ask_confirm / self_improve_confirm)
```

`Orchestrator` / `SessionStore` / `MemoryStore` / `ConfirmBridge` 等通用基础设施 IM-agnostic，不做改动。改动集中在 IM 抽象层、配置层、新增 `src/im/wechat/`、装配层。

## 4. 配置与环境变量

### 4.1 `src/workspace/config.ts` schema 改造

把现有 `im.provider: z.literal('slack')` 替换为多 IM 启用清单：

```ts
im: z.object({
  enabled: z.array(z.enum(['slack', 'wechat'])).min(1).default(['slack']),
  slack: z.object({
    resolveChannelName: z.boolean().default(true),
  }).default({}),
  wechat: z.object({
    baseUrl: z.string().default('https://ilinkai.weixin.qq.com'),
    cdnBaseUrl: z.string().default('https://novac2c.cdn.weixin.qq.com/c2c'),
  }).default({}),
}).default({}),
```

设计意图：
- `enabled` 是数组，可同时启用多个 IM；未来加 telegram / wecom 不破坏 schema
- `min(1)` 保底，禁止空数组
- `wechat.baseUrl` / `cdnBaseUrl` 暴露出来，方便腾讯改地址 / 测试 mock server 时不改代码（CowAgent 同样做法）

### 4.2 `im.provider` 字段直接删除（breaking change）

旧字段 `provider` 不保留兼容字段。本仓库仍处于早期，无外部稳定使用方。

`src/workspace/upgrade.ts` 增加迁移规则：检测到旧 yaml 含 `im.provider: slack` 自动转成 `im.enabled: ['slack']`，避免现有 workspace 启动炸开。

### 4.3 环境变量条件 require

[createApplication.ts:46-50](../../../src/application/createApplication.ts) 把硬性 `requireEnv('SLACK_BOT_TOKEN')` 等三件套（外加可选的 `SLACK_E2E_TRIGGER_USER_TOKEN`）抽到 `loadSlackEnv()`，仅在 `im.enabled.includes('slack')` 时调用。仅启用 wechat 的工作区不应因为缺 SLACK env 报错。

微信侧不读任何 env：凭证由扫码登录生成，存在工作区文件里。

### 4.4 Slack-only 装配项归类

下列基础设施仅在 Slack 启用时构造或使用：

- `SLACK_*` 环境变量（§4.3）
- [createApplication.ts:99-101](../../../src/application/createApplication.ts) 的 `channelTaskLedger` 和 [createApplication.ts:181-183](../../../src/application/createApplication.ts) 的 `channelTasks` 装配（cron 触发 Slack 频道消息推送，wechat 单聊语义不适用）
- `slackBotToken` / `slackAppToken` / `slackSigningSecret` 注入 `createSlackAdapter`

下列基础设施 IM-agnostic、双 IM 共享：

- `orchestrator` / `sessionStore` / `memoryStore` / `runQueue` / `abortRegistry`
- `mentionCommandRouter`（[ConversationOrchestrator.ts:295](../../../src/orchestrator/ConversationOrchestrator.ts)，对 `input.text` 做文本前缀解析触发 `/compact` 等命令；不依赖 Slack 字段，wechat 用户输入同样命令也能生效）
- `confirmBridge`（仅 Slack 路径会向其注册 pending；wechat 不写入也无副作用）
- `contextCompactor` / `selfImproveCollector` / `selfImproveGenerator` / `selfImproveSemanticDedup`
- `compactAgent`

### 4.5 工作区路径新增

`src/workspace/paths.ts` 新增：

```ts
wechatDir: path.join(root, 'wechat'),                         // .agent-slack/wechat/
wechatCredentialsFile: path.join(root, 'wechat', 'credentials.json'),
```

并新增 `wechatSessionDir(paths, userName, userId)` → `.agent-slack/sessions/wechat/<sanitized userName>.<userId>/`，与现有 `slackSessionDir` 并列。

## 5. IM 抽象层重塑

### 5.1 `src/im/IMAdapter.ts`

现状 `id: 'slack' | 'telegram'`（'telegram' 是历史占位、未实现），改造时一起清掉：

```ts
export type ImProvider = 'slack' | 'wechat'

export interface IMAdapter {
  readonly id: ImProvider
  start(): Promise<void>
  stop(): Promise<void>
}
```

### 5.2 `src/im/types.ts` — `InboundMessage`

字段名沿用 Slack 词汇（`threadTs` / `messageTs`），仅在类型注释里说明跨 IM 语义映射，避免全仓 rename：

```ts
export interface InboundMessage {
  imProvider: ImProvider
  /**
   * 频道/对话标识。
   *   Slack: channelId
   *   Wechat: from_user_id（单聊语义，与下方 threadTs 同值）
   * 用作 IM 侧路由（往哪个 channel/peer 回消息）。
   */
  channelId: string
  /**
   * 频道可读名。
   *   Slack: 频道名（resolved by resolveChannelName）
   *   Wechat: from_user_id（MVP 没有 nickname 来源；后续若 ilink 暴露 nickname 字段再补）
   */
  channelName: string
  /**
   * 会话标识。SessionStore key、ConfirmBridge per-session key。
   *   Slack: threadTs
   *   Wechat: from_user_id（单聊语义）
   */
  threadTs: string
  userId: string
  userName: string
  text: string
  /**
   * 入站消息 ID，用于去重。
   *   Slack: messageTs
   *   Wechat: message_id
   */
  messageTs: string
  confirmSender?: ConfirmSender
}
```

`ImProvider` 类型在 `IMAdapter.ts` 导出后此处复用。

### 5.3 `SessionStore` 解除 'slack' 硬绑定

[SessionStore.ts](../../../src/store/SessionStore.ts) 现状：

- 内存 cache key 已经是 `${imProvider}:${channelId}:${threadTs}`（[SessionStore.ts:276](../../../src/store/SessionStore.ts)），含 imProvider 维度，无需改 key 结构
- `imProvider` 字段类型是 literal `'slack'`（`SessionMeta` 与 `GetOrCreateArgs` 上）—— 需要升级成 `ImProvider` union
- **真正的 bug**：`slackSessionDir(...)` 硬编码出现在两处：
  - [SessionStore.ts:280](../../../src/store/SessionStore.ts) `getOrCreate()` 创建会话目录
  - [SessionStore.ts:341](../../../src/store/SessionStore.ts) `appendEvent()` 探测会话目录是否存在
  两处都需要按 `imProvider` 分支选 `slackSessionDir` / `wechatSessionDir`。如果只改 280 不改 341，wechat 会话的 events.jsonl 会被探测到 `sessions/slack/...` 目录返回 false → 静默丢弃所有 event。

改造：

- `SessionMeta.imProvider` / `GetOrCreateArgs.imProvider` 类型升级为 `ImProvider`
- `getOrCreate()` 与 `appendEvent()` 内部按 `args.imProvider` 选目录拼接函数（两处都改）
- cache key 不动

迁移：现有磁盘 session 已经全部在 `sessions/slack/...` 下，物理路径不变，老数据无需迁移。

## 6. WechatApi HTTP 客户端

位置：`src/im/wechat/WechatApi.ts`，纯 HTTP 客户端，不依赖 orchestrator/config。

### 6.1 接口

```ts
export interface WechatCredentials {
  token: string                 // sendmessage / getupdates 鉴权 Bearer
  baseUrl: string               // ilink 主域，扫码后由服务端返回（可能与配置默认值不同）
  botId: string                 // 仅用于日志/可观察性，HTTP 调用不带
  userId: string                // 仅用于日志/可观察性，HTTP 调用不带
}

export class WechatApi {
  constructor(opts: { baseUrl: string; cdnBaseUrl: string; token?: string })

  // long-poll
  getUpdates(buf: string, signal?: AbortSignal): Promise<GetUpdatesResp>

  // 发文本（MVP 只用这个）
  sendText(to: string, text: string, contextToken: string): Promise<void>

  // 辅助
  getConfig(userId: string, contextToken?: string): Promise<unknown>

  // 扫码登录
  fetchQrCode(): Promise<{ qrcode: string; qrcodeImgContent: string }>
  pollQrStatus(qrcode: string): Promise<QrStatusResp>
}
```

### 6.2 实现要点（直接对照 CowAgent `weixin_api.py`）

- HTTP 客户端用原生 `globalThis.fetch` + `AbortSignal`，不引入 axios / undici
- 通用请求头：
  ```
  Authorization: Bearer <token>
  AuthorizationType: ilink_bot_token
  X-WECHAT-UIN: <每次请求随机 base64 uint32>
  iLink-App-Id: bot
  iLink-App-ClientVersion: 131072
  Content-Type: application/json
  ```
- 通用 body 注入 `base_info: { channel_version: '2.0.0' }`
- `getUpdates`：`POST /ilink/bot/getupdates`，body `{ get_updates_buf }`，timeout 40s = 35s long-poll + 5s 余量。超时返回 `{ ret: 0, msgs: [] }`（与 CowAgent 行为一致）
- `sendText`：`POST /ilink/bot/sendmessage`，body：
  ```ts
  {
    msg: {
      from_user_id: '',
      to_user_id,
      client_id: randomUUID().replace(/-/g, '').slice(0, 16),
      message_type: 2,        // BOT
      message_state: 2,       // FINISH
      item_list: [{ type: 1, text_item: { text } }],
      context_token,
    }
  }
  ```
- `fetchQrCode`：`GET /ilink/bot/get_bot_qrcode?bot_type=3`
- `pollQrStatus`：`GET /ilink/bot/get_qrcode_status?qrcode=<urlencoded>`

### 6.3 凭证管理

`src/im/wechat/CredentialsStore.ts`：

```ts
load(path: string): Promise<WechatCredentials | undefined>
save(path: string, creds: WechatCredentials): Promise<void>  // 写完 chmod 0600
clear(path: string): Promise<void>                           // relogin 时清掉
```

凭证文件路径 = `paths.wechatCredentialsFile`（§4.5），即 `.agent-slack/wechat/credentials.json`。
chmod 0600 失败（如 Windows）时静默忽略，CowAgent 同样处理。

## 7. WechatAdapter

位置：`src/im/wechat/WechatAdapter.ts`，对照 [SlackAdapter.ts](../../../src/im/slack/SlackAdapter.ts) 的入口职责。

### 7.1 启动流程

```ts
async start() {
  // 1. 加载凭证；不存在则进入扫码登录（阻塞，最长 480s）
  // 2. 启动 long-poll 异步循环（不 await，让 start() 返回）
}
```

扫码登录 UX：
- 终端用 `qrcode-terminal`（轻量、无依赖）打印 ASCII 二维码 + URL（防终端不支持 unicode）
- 状态机轮询 `pollQrStatus`，间隔 1s：`wait` / `scaned` / `expired` / `confirmed`
- `expired` 自动 `fetchQrCode` 刷新，最多 10 次
- 总超时 480s，超时 `start()` 抛错（让 createApplication 报错退出）
- 扫码窗口期间 `stop()` 被调（如 daemon supervisor 主动终止）：状态机 abort 后立即 `start()` reject（不 hang 到 480s）

### 7.2 Long-poll loop

伪代码：

```ts
while (!stop.signal.aborted) {
  try {
    const resp = await api.getUpdates(buf, stop.signal)
    if (resp.errcode === -14) {                     // session 过期
      await credentialsStore.clear(credentialsFile)
      await reloginViaQr()
      buf = ''
      continue
    }
    if (resp.ret !== 0 || resp.errcode !== 0) {
      consecutiveFailures++
      if (consecutiveFailures >= 3) await sleep(30_000)  // backoff
      else await sleep(2_000)
      continue
    }
    consecutiveFailures = 0
    if (resp.get_updates_buf) buf = resp.get_updates_buf
    for (const raw of resp.msgs ?? []) processMessage(raw)
  } catch (e) {
    if (stop.signal.aborted) break
    consecutiveFailures++
    if (consecutiveFailures >= 3) await sleep(30_000)
    else await sleep(2_000)
  }
}
```

### 7.3 processMessage

- 跳过 `message_type !== 1`（非用户消息）
- 入站消息去重：`Map<msgId, expireAt>`，TTL 7 小时；定时清理过期项
- `context_token` 缓存：`Map<userId, contextToken>`，每次入站消息更新（出站 `sendText` 必须回传该 token，CowAgent 同设计）。**仅内存**，bot 重启后该 Map 清空；重启后第一次入站消息前**无法主动 sendText**（这条限制对 MVP 无影响——MVP 不做主动推送 / channel tasks）
- `get_updates_buf` 同步游标也仅内存，重启后从 `''` 起拉。配合去重 Map 也清空，重启后短窗口内可能见到一次重复消息——MVP 接受（CowAgent 同设计）
- 解析 `item_list`：MVP 只看 `type === 1` 的 text_item
  - 遇到 `type === 2/3/4/5`（image/voice/file/video）：打日志 `[Wechat] 暂不支持媒体消息（MVP 阶段），已忽略`，并立即调 `sendText` 回一条 "目前暂不支持图片/语音/文件/视频，请发送文字消息" 提示
  - 媒体 + 文本混合：取文本部分继续处理，媒体部分丢弃 + 提示
  - **顺序保证**：处理顺序固定为 ① 更新 contextToken 缓存 → ② 解析 item_list → ③ 调 sendText 发提示或入 orchestrator。这样首条媒体消息也能拿到 token、提示能发出去
- 构造 `InboundMessage`：
  ```ts
  {
    imProvider:    'wechat',
    channelId:     from_user_id,
    channelName:   from_user_id,    // MVP 无 nickname
    threadTs:      from_user_id,
    messageTs:     message_id,
    userId:        from_user_id,
    userName:      from_user_id,
    text:          text_item.text,
    confirmSender: undefined,        // §9 决定不注入
  }
  ```
- 经 `runQueue` 进 orchestrator，与 Slack 路径一致

## 8. WechatRenderer / WechatEventSink

### 8.1 `WechatRenderer`

对照 [SlackRenderer.ts](../../../src/im/slack/SlackRenderer.ts) 但**剧烈精简**：

- 没有 Block Kit / thinking spinner / chat.update
- 产物是 `string[]`（待发送的文本段列表），不是结构化"块"
- 行为：
  - 起始消息固定为 `"开始处理..."` 文本一段（首段），让用户立刻看到 bot 已在处理
  - 工具调用过程：在最终消息前增加一段汇总 `🔧 使用了工具: bash, read_file, ...`（按调用顺序去重）
  - final assistant text：单条或多条，超 4000 字符按 `\n\n / \n / 硬切` 三级分段
  - terminal phase = `failed`：追加一条 `"⚠️ 处理失败：<简短错误>"`，不暴露 stack trace

### 8.2 `WechatEventSink`

对照 [SlackEventSink.ts](../../../src/im/slack/SlackEventSink.ts) 但只在 finalize 阶段统一发送。

**构造时由 `WechatAdapter.processMessage` 注入快照**：`{ toUserId, contextToken, api, renderer, logger }`。`contextToken` 来自 §7.3 的入站消息上的最新值；finalize 全程使用同一个 token，避免中途被新入站消息更新覆盖（避免错位）。

```ts
class WechatEventSink implements EventSink {
  async onEvent(event) {
    // 累积到 renderer 内部状态
    // 首个 event 时触发"开始处理..."的发送
  }
  async finalize() {
    const segments = renderer.flush()  // string[]
    for (const [i, seg] of segments.entries()) {
      try {
        await api.sendText(toUserId, seg, contextToken)
      } catch (err) {
        logger.error('[Wechat] 段发送失败', { i, err })
        // 不重试（容易触发限流被风控）；尝试发"[消息发送失败]"提示
      }
      if (i < segments.length - 1) await sleep(500)  // 防限流
    }
  }
}
```

设计取舍：
- **不流式**：微信无 `chat.update` 等价物。MVP 选择 finalize 一次性发完整结果
- **失败不重试**：避免 spam 嫌疑触发风控
- **段间 500ms sleep**：与 CowAgent 一致

## 9. confirm tool 按 IM 启用清单条件注入

### 9.1 现状问题

[src/agent/tools/index.ts:40](../../../src/agent/tools/index.ts) 的 `ask_confirm` 与 `self_improve_confirm` 是**无条件**注入 ToolSet 的，仅靠运行时 `if (!ctx.confirm)` 降级返回 `{ reason: 'no_confirm_channel' }`。模型仍然能在 schema 里看见这两个 tool。

需求是：微信启用时模型**根本看不见** confirm tool。

### 9.2 改造

`buildBuiltinTools` 改为按 `ctx.confirm` 存在与否条件性加入 ToolSet：

```ts
export function buildBuiltinTools(ctx: ToolContext, deps: BuiltinToolDeps): ToolSet {
  const tools: ToolSet = {
    bash: bashTool(ctx),
    edit_file: editFileTool(ctx),
    save_memory: saveMemoryTool(ctx, { memoryStore: deps.memoryStore }),
    self_improve_collect: selfImproveCollectTool(ctx, { collector: deps.selfImproveCollector }),
  }
  if (ctx.confirm) {
    tools.ask_confirm = askConfirmTool(ctx, { bridge: deps.confirmBridge, logger: deps.logger })
    tools.self_improve_confirm = selfImproveConfirmTool(ctx, {
      generator: deps.selfImproveGenerator,
      ...(deps.selfImproveSemanticDedup ? { semanticDedup: deps.selfImproveSemanticDedup } : {}),
      paths: deps.paths,
      logger: deps.logger,
    })
  }
  return tools
}
```

WechatAdapter 在 §7.3 构造 `InboundMessage` 时 `confirmSender: undefined`，链路上 `ctx.confirm` 自然 undefined，两个 confirm tool 不进 schema。

### 9.3 副作用

- Slack 路径：`ctx.confirm` 总是存在 → ToolSet 完全不变 → 行为不变
- Wechat 路径：confirm tool 从 schema 中消失 → 模型看不到 → 不会调
- system prompt 已知风险（MVP 不修，登记到 §13）：现有 prompt 可能引导模型在微信下调不存在的 tool，会被 ai-sdk 在 tool resolve 阶段拒掉；需要观察实际行为再决定是否做 IM-aware prompt

## 10. createApplication 装配改造

[createApplication.ts](../../../src/application/createApplication.ts) 主要改动：

```ts
const enabled = ctx.config.im.enabled  // ['slack'] | ['wechat'] | ['slack','wechat']

const slackEnv = enabled.includes('slack') ? loadSlackEnv() : undefined

const secrets = [
  ...(slackEnv ? [slackEnv.botToken, slackEnv.appToken, slackEnv.signingSecret] : []),
  ...(slackEnv?.e2eTriggerUserToken ? [slackEnv.e2eTriggerUserToken] : []),
  ...providerEnv.secrets,
]

// 通用基础设施（sessionStore / memoryStore / confirmBridge / runQueue / abortRegistry / orchestrator）
// 不变

const adapters: IMAdapter[] = []

if (enabled.includes('slack')) {
  adapters.push(createSlackAdapter({ /* 现有参数 + slackEnv */ }))
}

if (enabled.includes('wechat')) {
  const api = new WechatApi({
    baseUrl: ctx.config.im.wechat.baseUrl,
    cdnBaseUrl: ctx.config.im.wechat.cdnBaseUrl,
  })
  adapters.push(createWechatAdapter({
    api,
    credentialsFile: ctx.paths.wechatCredentialsFile,
    orchestrator,
    abortRegistry,
    runQueue,
    sessionStore,
    renderer: createWechatRenderer({ logger }),
    logger,
  }))
}

return {
  adapters,
  abortRegistry,
  async start() { for (const a of adapters) await a.start() },  // 串行
  async stop()  { for (const a of adapters) await a.stop() },
}
```

### 10.1 启动顺序：串行

`for...of await a.start()` 严格串行。Slack 启动快，wechat 若需扫码会阻塞最长 480s。在扫码完成前整个服务未启动完成——这是明确语义，与 daemon supervisor 的状态机吻合（要么"未启动"要么"已启动"，避免半启动状态）。

### 10.2 多 IM 共用基础设施

一个 Node 进程内 Slack + Wechat 两个 adapter 共用：
- 同一个 `orchestrator`、`sessionStore`、`memoryStore`
- 同一份 system prompt 与 agent 配置
- 同一个 `runQueue`（队列 key 含 imProvider，互不串扰）
- 同一份 `confirmBridge`（仅 Slack 路径会向其注册 pending）

会话物理隔离：`sessions/slack/...` vs `sessions/wechat/...`；逻辑 key 含 imProvider 维度（§5.3）。

## 11. 文件清单

新增：
- `src/im/wechat/WechatApi.ts`
- `src/im/wechat/CredentialsStore.ts`
- `src/im/wechat/WechatAdapter.ts`
- `src/im/wechat/WechatRenderer.ts`
- `src/im/wechat/WechatEventSink.ts`
- 上述各文件对应 `.test.ts`
- 在现有 [src/agent/tools/tools.test.ts](../../../src/agent/tools/tools.test.ts) 追加 `buildBuiltinTools` 条件注入用例（不新建文件，避免重叠）

修改：
- `src/im/IMAdapter.ts`：导出 `ImProvider`、`id` 改为 union
- `src/im/types.ts`：`InboundMessage.imProvider` 改为 union；字段注释补 wechat 语义
- `src/agent/tools/index.ts`：`buildBuiltinTools` 改条件注入
- `src/store/SessionStore.ts`：`imProvider` 类型升级；替换 `getOrCreate` / `appendEvent` 两处 `slackSessionDir` 硬编码为按 `imProvider` 分支选目录
- `src/workspace/config.ts`：schema 改造（删 `provider`，加 `enabled` 与 `wechat` 子对象）
- `src/workspace/paths.ts`：新增 `wechatDir` / `wechatCredentialsFile`、新增 `wechatSessionDir()`
- `src/workspace/upgrade.ts`：迁移规则 `provider: 'slack'` → `enabled: ['slack']`
- `src/workspace/templates/`：模板里的 `im.provider` 改为 `im.enabled`
- `src/application/createApplication.ts`：装配按 enabled 分支、env 条件 require
- 现有测试同步更新（[createApplication.test.ts](../../../src/application/createApplication.test.ts)、[config.test.ts](../../../src/workspace/config.test.ts)、[SessionStore.test.ts](../../../src/store/SessionStore.test.ts) 等）

依赖：
- 新增 `qrcode-terminal` 到 `package.json`（小、无依赖）

## 12. 测试策略

### 12.1 单测

| 文件 | 关键 case |
|---|---|
| `WechatApi.test.ts` | mock fetch；headers/body 字段拼装；`base_info` 注入；long-poll timeout 返回 `{ret:0,msgs:[]}`；errcode -14 透传 |
| `CredentialsStore.test.ts` | tmp dir 写入 → 读回；不存在文件返回 undefined；非 Windows 验证 0600 |
| `WechatAdapter.test.ts` | 凭证存在直接进 long-poll；凭证不存在走扫码；type=1 文本 → orchestrator；type=2/3/4/5 忽略 + 提示；errcode -14 → 清凭证重扫；`stop()` 触发 abort 退出 |
| `WechatRenderer.test.ts` | 仅 final text → 单段；含工具调用 → 摘要前缀；超长按 `\n\n/\n/硬切` 分段；failed → 错误提示文案 |
| `WechatEventSink.test.ts` | mock api.sendText；段间 sleep 500ms；起始 "开始处理" 立刻发；段内失败记日志不抛 |
| `tools/tools.test.ts`（追加用例） | `ctx.confirm` 存在 → keys 含 `ask_confirm`/`self_improve_confirm`；undefined → 不含 |

### 12.2 改造现有测试

- [createApplication.test.ts](../../../src/application/createApplication.test.ts)：仅 slack / 仅 wechat / 双开 三 case；仅 wechat 时不要求 SLACK_BOT_TOKEN
- [SessionStore.test.ts](../../../src/store/SessionStore.test.ts)：跨 IM 同 channelId/threadTs 不冲撞回归
- [config.test.ts](../../../src/workspace/config.test.ts)：`im.enabled` 数组校验、旧 `im.provider` schema error 行为、upgrade 转换正确

### 12.3 不做

- 真扫码 / 真微信账号 CI（无法自动化）
- 假 server 集成测试（本仓库 Slack 也未做，保持一致）

### 12.4 手动验证清单

实现到 `WechatAdapter.start()` 真跑流程时，需要扫码就停下，等用户扫完后再继续。验证步骤：

1. 仅启用 wechat：`im.enabled: ['wechat']`，启动服务 → 终端打印二维码 + URL → 微信 8.0.69+ 扫码 → 凭证写入 `.agent-slack/wechat/credentials.json` → 给 bot 发"hi" → 收到 bot 文本回复
2. 重启复用凭证：停服务，重启 → 不再扫码，直接进入 long-poll → 给 bot 发文本仍有回复
3. 模拟 -14 复盘 relogin：手动把凭证文件 token 改成非法值 → 重启 → next getUpdates 返回 -14 → 自动清凭证重扫
4. 双开：`im.enabled: ['slack', 'wechat']`，串行启动；Slack 路径正常 @ bot 收回复；微信路径正常发文本收回复；两个会话互不串扰
5. 媒体消息忽略：给 bot 发图片 / 语音 / 文件 / 视频 → bot 回 "目前暂不支持..." 提示，agent 未被触发
6. 超长文本分段：让 agent 产出 >4000 字符回复 → 用户在微信看到分段消息，段间间隔 ~500ms

## 13. 已知风险 / 后续待办

**MVP 阶段已知风险**：

1. **个人微信号灰度风险**：账号被风控的实际风险尚未在公司环境验证过；MVP 用最小 surface 验证主链路，再决定是否扩展媒体支持
2. **system prompt 引导调不存在的 tool**：现有 prompt 可能让模型在微信下调 `ask_confirm`，被 ai-sdk 拒掉。MVP 不动 prompt，观察实际行为
3. **凭证文件 chmod 0600 在 Windows 静默忽略**：CowAgent 同设计，工作区文件本身已经在用户私有目录下，可接受
4. **daemon supervisor 启动超时 vs 扫码 480s**：若 supervisor 启动超时阈值小于 480s，初次扫码可能被强制终止。手动验证清单（§12.4）中应核对一次现有 supervisor 的超时阈值；若不够长，要么调高 supervisor 阈值，要么把扫码流程从 `start()` 解耦（不在 MVP 范围）

**后续切片登记**（不做、spec 留 issue 提示）：

- S4：入站媒体（图片/语音/文件/视频）解析 + CDN 解密下载
- S5：出站媒体（图片/视频/文件）发送 + AES-128-ECB CDN 上传
- S6：错误恢复加固（更精细的错误码字典、限流退避策略、消息去重持久化）
- 多账号同进程
- IM-aware system prompt
- Wechat 友好的 channel tasks / 主动推送 trigger 设计
