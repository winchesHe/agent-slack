# 微信（个人号）IM 适配器 MVP 实现计划

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把当前仓库的 IM 抽象解耦"slack 硬编码"，新增个人微信 adapter（仅文本、单聊），双 IM 可同进程共存；不破坏现有 Slack 行为。

**Architecture:**
直连腾讯 ilink bot HTTP API（`https://ilinkai.weixin.qq.com/ilink/bot/*`），long-poll 拉消息、扫码登录、凭证存工作区文件。WechatAdapter 与 SlackAdapter 共用同一个 orchestrator / sessionStore / agent / memory，按 `im.enabled` 数组配置启用。confirm tool 改为按 `ctx.confirm` 存在条件性注入（微信不注入）。

**Tech Stack:** TypeScript / Node 18+ / vitest / 原生 fetch / `qrcode-terminal`

**Spec:** [docs/superpowers/specs/2026-05-10-wechat-im-adapter-design.md](../specs/2026-05-10-wechat-im-adapter-design.md)

**关键编码偏好（按用户 CLAUDE.md）：**
- 编码顺序：代码 → 测试文件 → (设计文档已写完) → memory（不必新建）
- 切片粒度：可运行闭环 / 可验证切片 → 渐进增强；每步说明观察点和验证方式
- 不使用 TDD（不是先写失败测试，是写完代码立即写测试再跑全套验证）

**全局测试运行：**
- 单文件：`pnpm vitest run path/to/file.test.ts`
- 全套：`pnpm vitest run`
- 类型检查：`pnpm tsc -b`

---

## Chunk 1: 抽象层 + 配置改造（S1）

**Chunk 目标：** 解耦 IM 抽象层、配置 schema、env 条件 require、SessionStore 多 IM 路径分桶、confirm tool 条件注入。本 chunk 完成后**仅启用 slack 的工作区行为零差异**。微信 adapter 还未实现。

**Chunk 验证终点（运行 `pnpm vitest run` 全绿）：**
- 现有 Slack / orchestrator / store / config 测试全绿
- 新增 `tools.test.ts` 条件注入用例绿
- 新增 `config.test.ts` `im.enabled` schema 用例绿
- 新增 `WorkspaceContext.test.ts` 旧 `im.provider` 自动迁移用例绿
- 新增 `paths.test.ts` `wechatSessionDir` 用例绿
- `pnpm tsc -b` 类型零错

---

### Task 1.1: `IMAdapter.ts` 解耦 + 导出 `ImProvider`

**Files:**
- Modify: `src/im/IMAdapter.ts`

清理历史 `'telegram'` 占位，改为 `'slack' | 'wechat'`，并导出 `ImProvider` 类型供其他模块复用。

- [ ] **Step 1.1.1: 改 `src/im/IMAdapter.ts`**

```ts
export type ImProvider = 'slack' | 'wechat'

export interface IMAdapter {
  readonly id: ImProvider
  start(): Promise<void>
  stop(): Promise<void>
}
```

- [ ] **Step 1.1.2: 类型检查**

Run: `pnpm tsc -b`
Expected: 可能有 SlackAdapter / SessionStore 等处的类型错（因为它们的 `imProvider: 'slack'` 字段类型从 literal 收窄到 union 后兼容；'telegram' 应该没有引用）。这些错在后续 task 一起修。如果出现意料之外的错（telegram 引用），记录后再处理。

- [ ] **Step 1.1.3: 不 commit**（与 Task 1.2 / 1.3 一起 commit，避免类型半改）

---

### Task 1.2: `InboundMessage.imProvider` 改 union + 注释

**Files:**
- Modify: `src/im/types.ts:49-61`

字段名沿用 Slack 词汇（`threadTs` / `messageTs` 不改名），仅在类型注释里加跨 IM 语义映射。

- [ ] **Step 1.2.1: 改 `src/im/types.ts`**

import 区追加：

```ts
import type { ImProvider } from './IMAdapter.ts'
```

`InboundMessage` 改写为：

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
   *   Wechat: from_user_id（MVP 没有 nickname 来源）
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

- [ ] **Step 1.2.2: 类型检查**

Run: `pnpm tsc -b`
Expected: 类型可能仍有错（SessionStore 等处），下个 task 修。

---

### Task 1.3: `paths.ts` 新增 wechat 路径 + 测试

**Files:**
- Modify: `src/workspace/paths.ts`
- Modify: `src/workspace/paths.test.ts`

新增 `wechatDir`、`wechatCredentialsFile` 字段以及 `wechatSessionDir()` 函数，与现有 `slackSessionDir` 并列。

- [ ] **Step 1.3.1: 改 `src/workspace/paths.ts`**

`WorkspacePaths` 接口加两字段：

```ts
wechatDir: string
wechatCredentialsFile: string
```

`resolveWorkspacePaths` 返回对象加：

```ts
wechatDir: path.join(root, 'wechat'),
wechatCredentialsFile: path.join(root, 'wechat', 'credentials.json'),
```

文件末尾追加：

```ts
/**
 * 微信单聊会话目录。微信单聊语义下 channelId/threadTs 都等同 from_user_id，
 * 这里取 userName / userId 即可（CowAgent 同设计）。
 */
export function wechatSessionDir(
  paths: WorkspacePaths,
  userName: string,
  userId: string,
): string {
  const safe = sanitizeFsSegment(userName)
  return path.join(paths.sessionsDir, 'wechat', `${safe}.${userId}`)
}
```

- [ ] **Step 1.3.2: 改 `src/workspace/paths.test.ts`**

import 区加 `wechatSessionDir`。在 describe 里加用例：

```ts
it('resolveWorkspacePaths includes wechat dir/credentials', () => {
  const p = resolveWorkspacePaths('/tmp/ws')
  expect(p.wechatDir).toBe('/tmp/ws/.agent-slack/wechat')
  expect(p.wechatCredentialsFile).toBe('/tmp/ws/.agent-slack/wechat/credentials.json')
})

it('wechatSessionDir uses sanitized userName + userId', () => {
  const p = resolveWorkspacePaths('/tmp/ws')
  // 注意 sanitizeFsSegment 把空格和 / 都替换为 _
  // '张 三/4' → '张_三_4'
  expect(wechatSessionDir(p, '张 三/4', 'uABC')).toBe(
    '/tmp/ws/.agent-slack/sessions/wechat/张_三_4.uABC',
  )
})
```

- [ ] **Step 1.3.3: 跑测试**

Run: `pnpm vitest run src/workspace/paths.test.ts`
Expected: 全绿

- [ ] **Step 1.3.4: 提交 Task 1.1 + 1.2 + 1.3**

```bash
git add src/im/IMAdapter.ts src/im/types.ts src/workspace/paths.ts src/workspace/paths.test.ts
git commit -m "$(cat <<'EOF'
refactor(im): IM 抽象层解耦 'slack'/'telegram' literal 为 ImProvider union

- IMAdapter 导出 ImProvider = 'slack' | 'wechat'，删历史 'telegram' 占位
- InboundMessage.imProvider 改 union，字段注释补 wechat 语义映射
- paths.ts 新增 wechatDir / wechatCredentialsFile / wechatSessionDir()
- 暂未引入 wechat adapter；Slack 路径行为不变

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

### Task 1.4: `config.ts` schema 改造 + 测试

**Files:**
- Modify: `src/workspace/config.ts`
- Modify: `src/workspace/config.test.ts`

把 `im.provider: z.literal('slack')` 替换为 `im.enabled: z.array(z.enum(['slack','wechat']))` 数组，并加 `im.wechat` 子对象。注意：旧 `im.provider` 的迁移逻辑放在 Task 1.5 的 `loadWorkspaceContext` 预处理里，**不**靠 zod 兼容；本 task schema 直接是新形态。

- [ ] **Step 1.4.1: 改 `src/workspace/config.ts:48-53`**

```ts
im: z
  .object({
    enabled: z.array(z.enum(['slack', 'wechat'])).min(1).default(['slack']),
    slack: z.object({ resolveChannelName: z.boolean().default(true) }).default({}),
    wechat: z
      .object({
        baseUrl: z.string().default('https://ilinkai.weixin.qq.com'),
        cdnBaseUrl: z.string().default('https://novac2c.cdn.weixin.qq.com/c2c'),
      })
      .default({}),
  })
  .default({}),
```

- [ ] **Step 1.4.2: 检查 `src/workspace/config.test.ts` 现有用例**

Run: `grep -n "im\." src/workspace/config.test.ts`
Expected: 列出现有 im 相关 case。重点关注 `expect(() => parseConfig({ im: { provider: 'discord' } })).toThrow()` 这种"非法 provider 抛错"用例（line ~55）——删掉或改成 `im.enabled` 的对应等价 case，因为 `provider` 字段已不存在。

- [ ] **Step 1.4.3: 改/加用例到 `src/workspace/config.test.ts`**

```ts
it('im.enabled 默认为 [slack]', () => {
  const c = parseConfig({})
  expect(c.im.enabled).toEqual(['slack'])
})

it('im.enabled 数组校验：空数组拒绝', () => {
  expect(() => parseConfig({ im: { enabled: [] } })).toThrow()
})

it('im.enabled 拒绝未知 provider', () => {
  expect(() => parseConfig({ im: { enabled: ['discord'] } })).toThrow()
})

it('im.enabled 接受 [slack, wechat] 双开', () => {
  const c = parseConfig({ im: { enabled: ['slack', 'wechat'] } })
  expect(c.im.enabled).toEqual(['slack', 'wechat'])
})

it('im.wechat 默认 baseUrl/cdnBaseUrl', () => {
  const c = parseConfig({})
  expect(c.im.wechat.baseUrl).toBe('https://ilinkai.weixin.qq.com')
  expect(c.im.wechat.cdnBaseUrl).toBe('https://novac2c.cdn.weixin.qq.com/c2c')
})
```

把原 `provider: discord` 那个 throw 用例删掉（如果存在）。

- [ ] **Step 1.4.4: 跑 config 测试**

Run: `pnpm vitest run src/workspace/config.test.ts`
Expected: 全绿

---

### Task 1.5: 旧 `im.provider` 迁移（in-memory 预处理）

**Files:**
- Modify: `src/workspace/WorkspaceContext.ts`
- Modify: `src/workspace/WorkspaceContext.test.ts`

**为什么不用 `upgrade.ts`**：现有 `planUpgradeYaml(userYaml, templateYaml)` 是**纯文本追加式**算法（不破坏用户已有内容、不改写已有 key、只追加缺失字段），与"把 `im.provider` 改名成 `im.enabled` 数组"这种 in-place 改写语义不兼容。强行扩展会违反其设计原则。

**正确方案**：在 `loadWorkspaceContext` 里 yaml parse 完到 parseConfig 之前，加一步小型 in-memory 预处理 `migrateLegacyImProvider(raw)`：若 `raw.im.provider` 存在且 `raw.im.enabled` 不存在，则改写为 `enabled: [provider]` 并删 provider。本 task 只改这一个点，且不影响 `planUpgradeYaml`。

- [ ] **Step 1.5.1: 在 `src/workspace/WorkspaceContext.ts` 加迁移函数**

文件顶部不动；在 `loadWorkspaceContext` 之前（与 `composeSystemPrompt` 同级）加：

```ts
/**
 * Spec §4.2：旧 yaml 的 `im.provider: slack` → `im.enabled: [slack]` 迁移。
 * 仅做 in-memory 改写，不写回磁盘；下次用户主动编辑 yaml 时会自然落到新形态。
 *
 * 不放进 zod schema 兼容层（避免新代码长期挂着旧字段名），
 * 也不放进 planUpgradeYaml（那是纯追加式、不改写已有 key）。
 */
export function migrateLegacyImProvider(raw: unknown): unknown {
  if (typeof raw !== 'object' || raw === null) return raw
  const obj = raw as Record<string, unknown>
  const im = obj.im
  if (typeof im !== 'object' || im === null) return raw
  const imObj = im as Record<string, unknown>
  if (typeof imObj.provider === 'string' && !Array.isArray(imObj.enabled)) {
    imObj.enabled = [imObj.provider]
    delete imObj.provider
  }
  return raw
}
```

`loadWorkspaceContext` 里第 27-29 行修改：

```ts
const config = existsSync(paths.configFile)
  ? parseConfig(migrateLegacyImProvider(YAML.parse(await readFile(paths.configFile, 'utf8'))))
  : parseConfig({})
```

- [ ] **Step 1.5.2: 加用例到 `src/workspace/WorkspaceContext.test.ts`**

Run: `cat src/workspace/WorkspaceContext.test.ts` 先看现有测试结构。

加用例（紧邻其他 describe 内）：

```ts
import { migrateLegacyImProvider } from './WorkspaceContext.ts'

describe('migrateLegacyImProvider', () => {
  it('迁移 im.provider: slack → im.enabled: [slack]', () => {
    const raw = { im: { provider: 'slack' as const } }
    migrateLegacyImProvider(raw)
    expect(raw.im).toEqual({ enabled: ['slack'] })
  })

  it('已有 im.enabled 不被覆盖，provider 也不删', () => {
    const raw = { im: { enabled: ['wechat'], provider: 'slack' } }
    migrateLegacyImProvider(raw)
    expect((raw.im as Record<string, unknown>).enabled).toEqual(['wechat'])
    // 决策：enabled 已存在时不动 provider，避免误删 user 故意写的双字段；
    // parseConfig 默认 loose，不识别 provider 字段时会忽略
    expect((raw.im as Record<string, unknown>).provider).toBe('slack')
  })

  it('无 im 字段时不抛错', () => {
    const raw = { agent: {} }
    expect(() => migrateLegacyImProvider(raw)).not.toThrow()
  })

  it('null / undefined / 非对象 直接返回', () => {
    expect(migrateLegacyImProvider(null)).toBe(null)
    expect(migrateLegacyImProvider(undefined)).toBe(undefined)
    expect(migrateLegacyImProvider('foo')).toBe('foo')
  })
})
```

注意：上面"已有 enabled 不被覆盖"分支里是否要 delete provider，决定一致性。我倾向**只在迁移成功时 delete**（即只在 enabled 缺失时改写并删 provider）。这样行为更可预测。如果你看了 1.5.1 实现确认是这个逻辑，本测试就对。

- [ ] **Step 1.5.3: 跑测试**

Run: `pnpm vitest run src/workspace/WorkspaceContext.test.ts`
Expected: 全绿

---

### Task 1.6: 工作区模板 / 示例 yaml / e2e 脚本同步更新

**Files:**
- Modify: `examples/config.example.yaml:69-73`
- Modify: `src/workspace/templates/templates.test.ts:55-67`
- Modify: `src/workspace/templates/config.ts:30`（注释）
- Modify: `src/e2e/live/run-thinking-responses.ts:75`
- Modify: `src/workspace/upgrade.test.ts:65`（fixture 字符串）

把所有写死的 `provider: slack` 旧字段改为 `enabled:` 数组形态，并同步反向断言的测试。

- [ ] **Step 1.6.1: grep 全部命中点**

Run:

```bash
grep -rn "provider: slack\|im\.provider\|provider: 'slack'\|provider: \"slack\"" src examples
```

Expected: 6 个文件命中：

- `examples/config.example.yaml:70`
- `src/workspace/templates/templates.test.ts:65-66`
- `src/workspace/templates/config.ts:30`（注释，可改可不改但顺手改）
- `src/e2e/live/run-thinking-responses.ts:75`
- `src/workspace/upgrade.test.ts:65`（fixture string）
- 可能还有其他 - 全部列出。

- [ ] **Step 1.6.2: 改 `examples/config.example.yaml:69-73`**

```yaml
im:
  enabled:
    - slack
  slack:
    # true 时会通过 Slack API 解析 channel name；失败时回退 unknown。
    resolveChannelName: true
  # wechat:                        # 启用微信通道时取消注释
  #   baseUrl: https://ilinkai.weixin.qq.com
  #   cdnBaseUrl: https://novac2c.cdn.weixin.qq.com/c2c
```

- [ ] **Step 1.6.3: 改 `src/workspace/templates/templates.test.ts:55-67`**

把第 65-66 行的 `expect(out).toContain('provider: slack')` 改为：

```ts
// im.enabled: [slack] 不被影响（im 块内的 provider 替换不涉及 im 配置）
expect(out).toMatch(/^\s*-\s+slack\s*$/m)
```

注意上下文断言原意是"`agent.provider` 替换不会误改 im 块"——现在 im 块没有 provider 字段了，断言要换成"im.enabled 数组里仍有 slack"或类似不变性表达。

- [ ] **Step 1.6.4: 改 `src/workspace/templates/config.ts:30`（注释）**

把 `// examples/config.example.yaml 的字段顺序保证 agent.provider 在 im.provider 之前出现。` 改为：

```ts
// examples/config.example.yaml 的字段顺序保证 agent.provider 在 im 块之前出现，
// 所以替换 agent.provider 时不会误碰 im 配置。
```

- [ ] **Step 1.6.5: 改 `src/e2e/live/run-thinking-responses.ts:75`**

把那一行 `'  provider: slack',` 替换为：

```ts
'  enabled:',
'    - slack',
```

确保 yaml 字符串拼接的缩进正确（im 是顶层 key，enabled 是其子项）。

- [ ] **Step 1.6.6: 改 `src/workspace/upgrade.test.ts:65`**

这里是某个 fixture 字符串里有 `provider: slack`。把它改成 `enabled:\n    - slack` 同样形态，并确认测试断言（如果断言 yaml 内容包含某 keyword）一致。

如果该测试是对 `planUpgradeYaml` 输出的断言（比如"yaml 末尾应追加缺失字段"），那 `provider: slack` 出现在用户 yaml 里只是 fixture 输入；改输入即可，不影响断言主旨。

- [ ] **Step 1.6.7: 跑相关测试**

Run: `pnpm vitest run src/workspace`
Expected: 全绿

- [ ] **Step 1.6.8: 提交 Task 1.4 + 1.5 + 1.6**

```bash
git add src/workspace/config.ts src/workspace/config.test.ts \
        src/workspace/WorkspaceContext.ts src/workspace/WorkspaceContext.test.ts \
        examples/config.example.yaml \
        src/workspace/templates/templates.test.ts \
        src/workspace/templates/config.ts \
        src/e2e/live/run-thinking-responses.ts \
        src/workspace/upgrade.test.ts
git commit -m "$(cat <<'EOF'
refactor(config): im.enabled 数组 schema + 旧 provider 自动迁移

- config.ts: 删 im.provider literal，改 im.enabled (slack|wechat 数组)
  + im.wechat 子对象 (baseUrl/cdnBaseUrl)
- WorkspaceContext.ts: 加 migrateLegacyImProvider 预处理，旧 yaml
  的 im.provider 在 parse 前自动改写为 im.enabled
- 工作区示例 yaml / 模板测试 / e2e fixture 同步新形态
- 不动 planUpgradeYaml（追加式 yaml 处理与 in-place 改写不兼容）

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

### Task 1.7a: `SessionStore.ts` 类型升级 + appendEvent 签名扩展

**Files:**
- Modify: `src/store/SessionStore.ts`

按 spec §5.3：cache key 不动；`imProvider` 字段类型升级为 `ImProvider` union；`appendEvent` 签名扩展为含 `imProvider` + `imUserId`（必需，wechat 走 wechatSessionDir 时要用）。`getOrCreate` 与 `appendEvent` 内部都改为按 `imProvider` 分支选目录。

- [ ] **Step 1.7a.1: 改 `src/store/SessionStore.ts` import 区**

追加：

```ts
import type { ImProvider } from '@/im/IMAdapter.ts'
import { slackSessionDir, wechatSessionDir } from '@/workspace/paths.ts'
```

（`slackSessionDir` 已 imported，新增 `wechatSessionDir`；`ImProvider` 全新）

- [ ] **Step 1.7a.2: 类型升级（两处 literal → union）**

`SessionMeta` 第 36 行：`imProvider: 'slack'` → `imProvider: ImProvider`
`GetOrCreateArgs` 第 74 行：`imProvider: 'slack'` → `imProvider: ImProvider`

- [ ] **Step 1.7a.3: `appendEvent` 接口签名扩展**

第 98-101 行：

```ts
appendEvent(
  args: {
    imProvider: ImProvider
    channelName: string
    channelId: string
    threadTs: string
    /**
     * Slack 路径下不参与目录计算（slackSessionDir 不用此字段），仅为类型对齐传任意值即可。
     * Wechat 路径下作为 wechatSessionDir(paths, userName, userId) 的 userId 维度，必需。
     */
    imUserId: string
  },
  event: SessionEvent,
): Promise<void>
```

- [ ] **Step 1.7a.4: 加内部 helper `pickSessionDir`**

`createSessionStore` 函数闭包内部（或文件顶层）加：

```ts
function pickSessionDir(
  imProvider: ImProvider,
  paths: WorkspacePaths,
  args: { channelName: string; channelId: string; threadTs: string; imUserId: string },
): string {
  if (imProvider === 'slack') {
    return slackSessionDir(paths, args.channelName, args.channelId, args.threadTs)
  }
  // wechat: 单聊语义，channelName=userName, imUserId=userId
  return wechatSessionDir(paths, args.channelName, args.imUserId)
}
```

- [ ] **Step 1.7a.5: 改 `getOrCreate` 第 280 行**

```ts
const dir = pickSessionDir(args.imProvider, paths, {
  channelName: args.channelName,
  channelId: args.channelId,
  threadTs: args.threadTs,
  imUserId: args.imUserId,
})
```

- [ ] **Step 1.7a.6: 改 `appendEvent` 第 340-343 行**

```ts
async appendEvent(args, event) {
  const dir = pickSessionDir(args.imProvider, paths, {
    channelName: args.channelName,
    channelId: args.channelId,
    threadTs: args.threadTs,
    imUserId: args.imUserId,
  })
  if (!existsSync(path.join(dir, 'meta.json'))) return
  await appendFile(path.join(dir, 'events.jsonl'), JSON.stringify(event) + '\n')
},
```

- [ ] **Step 1.7a.7: 类型检查**

Run: `pnpm tsc -b`
Expected: 现在会在调用方报错（SlackAdapter.ts:137 / ConversationOrchestrator.ts:204 调 appendEvent 没传 imProvider/imUserId）。下个 task 修。

---

### Task 1.7b: 修 `appendEvent` 调用方

**Files:**
- Modify: `src/im/slack/SlackAdapter.ts:137`
- Modify: `src/orchestrator/ConversationOrchestrator.ts:204`
- Modify: `src/store/SessionStore.test.ts`

- [ ] **Step 1.7b.1: 看现有调用与 ConfirmActionContext**

Run:

```bash
grep -B2 -A12 "sessionStore\.appendEvent" src/im/slack/SlackAdapter.ts src/orchestrator/ConversationOrchestrator.ts
grep -A14 "interface ConfirmActionContext" src/im/slack/SlackAdapter.ts
```

确认事实（已 verify）：
- `ConfirmActionContext`（SlackAdapter.ts:54-67）有 `userId?: string`（optional，line 66）。Slack 路径调用 appendEvent 时它就是"点击按钮的用户 id"
- `SessionMeta.imUserId: string`（SessionStore.ts:41）必填，是会话所属用户 id
- Slack 路径下 imUserId **不参与目录计算**，仅为接口类型一致

- [ ] **Step 1.7b.2: 改 SlackAdapter.ts:137-142 调用**

把 `appendEvent` 第一参数从：

```ts
{
  channelName: ctx.channelName,
  channelId: ctx.channelId,
  threadTs: ctx.threadTs,
}
```

改为：

```ts
{
  imProvider: 'slack',
  channelName: ctx.channelName,
  channelId: ctx.channelId,
  threadTs: ctx.threadTs,
  imUserId: ctx.userId ?? '',  // slack 路径不参与目录计算，空 fallback 即可
}
```

- [ ] **Step 1.7b.3: 改 ConversationOrchestrator.ts:204 调用**

从 `session.meta` 拿 imProvider / imUserId（`SessionMeta` 都有）。在调用点附近（先 grep 看清楚现有 args 怎么构造），把：

```ts
{
  channelName: session.meta.channelName,
  channelId: session.meta.channelId,
  threadTs: session.meta.threadTs,
}
```

改为：

```ts
{
  imProvider: session.meta.imProvider,
  channelName: session.meta.channelName,
  channelId: session.meta.channelId,
  threadTs: session.meta.threadTs,
  imUserId: session.meta.imUserId,
}
```

如果 orchestrator 处没有 `session` 变量但有 `inboundMsg`，则用 `inboundMsg` 的对应字段（`imProvider` / `userId` 等），按上下文调整。

- [ ] **Step 1.7b.4: 改 `src/store/SessionStore.test.ts`**

加用例（在合适的 describe 内）：

```ts
it('wechat session 写到 sessions/wechat/ 目录', async () => {
  const paths = resolveWorkspacePaths(tmpDir)
  const store = createSessionStore(paths)
  const sess = await store.getOrCreate({
    imProvider: 'wechat',
    channelId: 'uABC',
    channelName: '张三',
    threadTs: 'uABC',
    imUserId: 'uABC',
  })
  expect(sess.dir).toContain(`${path.sep}sessions${path.sep}wechat${path.sep}`)
  expect(sess.meta.imProvider).toBe('wechat')
})

it('跨 IM 同 (channelId, threadTs) 不冲撞：cache key 含 imProvider', async () => {
  const paths = resolveWorkspacePaths(tmpDir)
  const store = createSessionStore(paths)
  const slackSess = await store.getOrCreate({
    imProvider: 'slack',
    channelId: 'C1', channelName: 'general', threadTs: '1700000000.0001', imUserId: 'U1',
  })
  const wechatSess = await store.getOrCreate({
    imProvider: 'wechat',
    channelId: 'C1', channelName: 'C1', threadTs: '1700000000.0001', imUserId: 'C1',
  })
  expect(slackSess.id).not.toBe(wechatSess.id)
  expect(slackSess.dir).not.toBe(wechatSess.dir)
})

it('appendEvent 按 imProvider 写到对应桶', async () => {
  const paths = resolveWorkspacePaths(tmpDir)
  const store = createSessionStore(paths)
  const sess = await store.getOrCreate({
    imProvider: 'wechat',
    channelId: 'uABC', channelName: '张三', threadTs: 'uABC', imUserId: 'uABC',
  })
  await store.appendEvent({
    imProvider: 'wechat',
    channelName: '张三', channelId: 'uABC', threadTs: 'uABC', imUserId: 'uABC',
  }, { type: 'test', payload: 1 } as never)
  // 验证 sessions/wechat/.../events.jsonl 存在且非空
  const fs = await import('node:fs/promises')
  const content = await fs.readFile(`${sess.dir}/events.jsonl`, 'utf8')
  expect(content).toContain('"type":"test"')
})
```

`tmpDir` 怎么来照现有 SessionStore.test.ts 模式（`mkdtempSync(...)`）。

- [ ] **Step 1.7b.5: 跑 SessionStore + orchestrator 测试**

Run: `pnpm vitest run src/store/SessionStore.test.ts src/orchestrator`
Expected: 全绿

- [ ] **Step 1.7b.6: 类型检查**

Run: `pnpm tsc -b`
Expected: 零错（除非还有别的调用方未识别到——再 grep 一遍）

- [ ] **Step 1.7b.7: 提交 Task 1.7a + 1.7b**

```bash
git add src/store/SessionStore.ts src/store/SessionStore.test.ts \
        src/im/slack/SlackAdapter.ts src/orchestrator/ConversationOrchestrator.ts
git commit -m "$(cat <<'EOF'
refactor(store): SessionStore imProvider 类型升级 + 解 slack 硬编码

- imProvider 字段类型从 'slack' literal 升级为 ImProvider union
- 引入 pickSessionDir(imProvider, ...) helper：按 imProvider 选目录
  (slackSessionDir / wechatSessionDir)
- getOrCreate / appendEvent 两处硬编码 slackSessionDir 替换为 helper
  (修复 wechat events 静默丢失隐患：appendEvent 探测错目录返回 false)
- appendEvent 接口签名扩展加 imProvider + imUserId 字段；同步两处
  调用方 (SlackAdapter / ConversationOrchestrator)

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

### Task 1.8: `tools/index.ts` confirm tool 条件注入 + 测试

**Files:**
- Modify: `src/agent/tools/index.ts:26-45`
- Modify: `src/agent/tools/tools.test.ts`

按 spec §9：`buildBuiltinTools` 改为按 `ctx.confirm` 存在条件性注入 `ask_confirm` 与 `self_improve_confirm`。Slack 路径行为不变。

- [ ] **Step 1.8.1: 先确认 `ToolSet` 类型支持动态 key 赋值**

Run: `grep -n "type ToolSet" node_modules/ai/dist/*.d.ts | head -5`
Expected: 看到 ToolSet 的定义。它通常是 `Record<string, Tool>` 或类似宽签名。如果是 `Record<string, Tool>`，直接 `tools.ask_confirm = ...` 后赋值类型 OK。

如果不是宽签名（罕见），改用 spread + conditional object literal：

```ts
return {
  ...baseTools,
  ...(ctx.confirm ? confirmTools : {}),
}
```

- [ ] **Step 1.8.2: 改 `src/agent/tools/index.ts:26-45`**

```ts
export function buildBuiltinTools(ctx: ToolContext, deps: BuiltinToolDeps): ToolSet {
  const tools: ToolSet = {
    bash: bashTool(ctx),
    edit_file: editFileTool(ctx),
    save_memory: saveMemoryTool(ctx, { memoryStore: deps.memoryStore }),
    self_improve_collect: selfImproveCollectTool(ctx, {
      collector: deps.selfImproveCollector,
    }),
  }
  if (ctx.confirm) {
    tools.ask_confirm = askConfirmTool(ctx, {
      bridge: deps.confirmBridge,
      logger: deps.logger,
    })
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

如果 1.8.1 发现 ToolSet 不接受动态 key 赋值，改用上面的 spread 写法。

- [ ] **Step 1.8.3: 看现有 tools.test.ts 结构 + ToolContext 含 confirm 字段的写法**

Run: `grep -n "ToolContext\|confirm" src/agent/tools/bash.ts src/agent/tools/index.ts | head -10`

确认 ToolContext 的 confirm 字段是 optional（`confirm?: ConfirmSender`）。

- [ ] **Step 1.8.4: 加用例到 `src/agent/tools/tools.test.ts`**

import 区加：

```ts
import { buildBuiltinTools, type BuiltinToolDeps } from './index.ts'
```

文件末尾加 describe block：

```ts
describe('buildBuiltinTools 条件注入', () => {
  const stubDeps = (): BuiltinToolDeps => ({
    memoryStore: {} as never,
    selfImproveCollector: {} as never,
    selfImproveGenerator: {} as never,
    confirmBridge: {} as never,
    paths: {} as never,
    logger: stubCtx().logger,
  })

  it('ctx.confirm 存在 → 含 ask_confirm 与 self_improve_confirm', () => {
    const ctx: ToolContext = {
      ...stubCtx(),
      confirm: { sessionId: 't', send: async () => {} },
    }
    const tools = buildBuiltinTools(ctx, stubDeps())
    expect(Object.keys(tools)).toEqual(
      expect.arrayContaining(['bash', 'edit_file', 'ask_confirm', 'self_improve_confirm']),
    )
  })

  it('ctx.confirm undefined → 不含 ask_confirm 与 self_improve_confirm', () => {
    const ctx = stubCtx()
    const tools = buildBuiltinTools(ctx, stubDeps())
    expect(Object.keys(tools)).not.toContain('ask_confirm')
    expect(Object.keys(tools)).not.toContain('self_improve_confirm')
    expect(Object.keys(tools)).toEqual(
      expect.arrayContaining(['bash', 'edit_file', 'save_memory', 'self_improve_collect']),
    )
  })

  it('两种 ctx 工具数差为 2', () => {
    const withConfirm: ToolContext = {
      ...stubCtx(),
      confirm: { sessionId: 't', send: async () => {} },
    }
    const without = stubCtx()
    expect(Object.keys(buildBuiltinTools(withConfirm, stubDeps())).length -
           Object.keys(buildBuiltinTools(without, stubDeps())).length).toBe(2)
  })
})
```

注：`stubCtx()` 是该文件已有 helper（line 12-25）。`ToolContext.confirm` 字段必须存在且 optional —— 如果当前 `ToolContext` 接口没有 `confirm` 字段，先在 bash.ts 的 `ToolContext` 接口加：

```ts
import type { ConfirmSender } from '@/im/types.ts'

export interface ToolContext {
  cwd: string
  logger: Logger
  currentUser?: { userName: string; userId: string }
  confirm?: ConfirmSender
}
```

具体看 bash.ts 现有签名再改。

- [ ] **Step 1.8.5: 跑测试**

Run: `pnpm vitest run src/agent/tools/tools.test.ts`
Expected: 全绿

- [ ] **Step 1.8.6: 跑全套验证 Slack 路径无回归**

Run: `pnpm vitest run`
Expected: 全绿。如果 askConfirm/selfImproveConfirm 相关测试有回归（依赖了"无条件注入"），调整测试在 confirm 存在分支验证。

---

### Task 1.9: `createApplication.ts` env 条件 require + adapters 数组装配

**Files:**
- Modify: `src/application/createApplication.ts`
- Modify: `src/application/createApplication.test.ts`

按 spec §10：`SLACK_*` env 三件套抽到 `loadSlackEnv()`，仅在 `enabled.includes('slack')` 时调用；`adapters` 数组按 enabled 分支构造。本 task 暂不实际新增 wechat adapter 代码（仅留 TODO 注释），以保证本 chunk 终点"仅 slack 工作区行为零差异 + 仅 wechat 工作区可启动但 adapters 空"。空 adapters 情况下打 warn 日志提示用户。

- [ ] **Step 1.9.1: 在 `createApplication.ts` 末尾加 `loadSlackEnv()` 函数**

```ts
interface SlackEnv {
  botToken: string
  appToken: string
  signingSecret: string
  e2eTriggerUserToken?: string
  secrets: string[]
}

function loadSlackEnv(): SlackEnv {
  const botToken = requireEnv('SLACK_BOT_TOKEN')
  const appToken = requireEnv('SLACK_APP_TOKEN')
  const signingSecret = requireEnv('SLACK_SIGNING_SECRET')
  const e2eTriggerUserToken = process.env.SLACK_E2E_TRIGGER_USER_TOKEN?.trim()
  return {
    botToken,
    appToken,
    signingSecret,
    ...(e2eTriggerUserToken ? { e2eTriggerUserToken } : {}),
    secrets: [
      botToken,
      appToken,
      signingSecret,
      ...(e2eTriggerUserToken ? [e2eTriggerUserToken] : []),
    ],
  }
}
```

- [ ] **Step 1.9.2: 重构 `createApplication` 函数主体**

按以下顺序（重要：`enabled` 取自 ctx，所以必须 ctx 加载之后取）：

```ts
export async function createApplication(args: CreateApplicationArgs): Promise<Application> {
  loadWorkspaceEnv({ workspaceDir: args.workspaceDir })

  const logLevel = parseLogLevel(process.env.LOG_LEVEL)
  const logFile = resolveDailyLogFile(args.workspaceDir)

  // bootstrap：尚未知 enabled / IM secrets，redactor 先空。
  // 注意：此阶段（loadWorkspaceContext 内部）不会接触 IM secrets，可接受。
  const bootstrapRedactor = createRedactor([])
  const bootstrapLogger = createLogger({ level: logLevel, redactor: bootstrapRedactor, logFile })

  const ctx = await loadWorkspaceContext(args.workspaceDir, bootstrapLogger)
  const channelTasksConfig = await loadChannelTasksConfigFile(ctx.paths.channelTasksFile)

  const enabled = ctx.config.im.enabled
  const slackEnv = enabled.includes('slack') ? loadSlackEnv() : undefined

  const provider = selectProvider(ctx.config.agent.provider)
  const providerEnv = loadProviderEnv(provider)

  const redactor = createRedactor([
    ...(slackEnv?.secrets ?? []),
    ...providerEnv.secrets,
  ])
  const logger = createLogger({ level: logLevel, redactor, logFile })
  logger.withTag('agent').info(`provider=${provider} im.enabled=${enabled.join(',')}`)

  const sessionStore = createSessionStore(ctx.paths)
  const memoryStore = createMemoryStore(ctx.paths)
  const selfImproveCollector = createSelfImproveCollector({ paths: ctx.paths, logger })
  const selfImproveGenerator = createSelfImproveGenerator()
  const confirmBridge = createConfirmBridge({ logger })
  const runQueue = new SessionRunQueue()
  const abortRegistry = new AbortRegistry<string>()

  const modelName = ctx.config.agent.model
  const runtime = buildProviderRuntime(provider, providerEnv, modelName)
  const selfImproveSemanticDedup = createSemanticDedup({ model: runtime.model, logger })
  const compactAgent = createCompactAgent({ model: runtime.model, logger })
  const contextCompactor = createContextCompactor({
    compactAgent,
    logger,
    keepRecentToolResults: ctx.config.agent.context.keepRecentToolResults,
  })
  const mentionCommandRouter = createMentionCommandRouter({ compactor: contextCompactor })
  const channelTaskLedger = enabled.includes('slack') && channelTasksConfig
    ? createChannelTaskTriggerLedger(ctx.paths.channelTaskTriggersFile)
    : undefined

  const toolsBuilder = (
    currentUser: { userName: string; userId: string },
    imContext: { confirm?: ConfirmSender },
  ) =>
    buildBuiltinTools(
      {
        cwd: ctx.cwd,
        logger,
        currentUser,
        ...(imContext.confirm ? { confirm: imContext.confirm } : {}),
      },
      {
        memoryStore,
        selfImproveCollector,
        selfImproveGenerator,
        selfImproveSemanticDedup,
        confirmBridge,
        paths: ctx.paths,
        logger,
      },
    )

  const extraProviderOptions = /* 维持原逻辑不变 */
    provider === 'openai-responses' ? { /* ... 原 openai-responses 块 ... */ } : undefined

  const executorFactory = (tools: ReturnType<typeof toolsBuilder>) =>
    createAiSdkExecutor({ /* 原参数不变 */ })

  const orchestrator = createConversationOrchestrator({
    toolsBuilder,
    executorFactory,
    sessionStore,
    memoryStore,
    runQueue,
    abortRegistry,
    systemPrompt: ctx.systemPrompt,
    modelMessageBudget: ctx.config.agent.context,
    mentionCommandRouter,
    contextCompactor,
    logger,
  })

  const adapters: IMAdapter[] = []

  if (enabled.includes('slack') && slackEnv) {
    const renderer = createSlackRenderer({ logger })
    const slackConfirm = createSlackConfirm({ logger })
    const slack = createSlackAdapter({
      orchestrator,
      abortRegistry,
      runQueue,
      renderer,
      slackConfirm,
      confirmBridge,
      sessionStore,
      ...(channelTasksConfig && channelTaskLedger
        ? { channelTasks: { config: channelTasksConfig, ledger: channelTaskLedger } }
        : {}),
      logger,
      botToken: slackEnv.botToken,
      appToken: slackEnv.appToken,
      signingSecret: slackEnv.signingSecret,
    })
    adapters.push(slack)
  }

  if (enabled.includes('wechat')) {
    // TODO(Chunk 3): 装配 WechatAdapter
    logger.warn('im.enabled 含 wechat，但 WechatAdapter 尚未实现（计划在 Chunk 3 落地）')
  }

  if (adapters.length === 0) {
    logger.warn('警告：adapters 为空，没有 IM 在线（检查 im.enabled 配置）')
  }

  return {
    adapters,
    abortRegistry,
    async start() { for (const a of adapters) await a.start() },
    async stop()  { for (const a of adapters) await a.stop() },
  }
}
```

**关键变化点 checklist**：
- [ ] 删除原顶层 `slackBotToken`/`slackAppToken`/`slackSigningSecret`/`slackE2eTriggerUserToken`（行 46-49）四个 const
- [ ] redactor 改成根据 enabled 动态构造
- [ ] `channelTaskLedger` 只在 slack enabled 时构造
- [ ] adapters 数组按 enabled 分支
- [ ] 双重 warn 提醒：wechat enabled 但未实现 + adapters 为空

- [ ] **Step 1.9.3: 看 createApplication.test.ts 现有 fixture**

Run: `head -80 src/application/createApplication.test.ts`

了解现有测试搭建（如何 mock workspace / env）。

- [ ] **Step 1.9.4: 加测试用例**

```ts
it('仅 slack：现有行为不变，adapters 长度 1', async () => {
  // 沿用现有正常 case 即可，断言 app.adapters.length === 1, app.adapters[0].id === 'slack'
})

it('仅 wechat 启用：不要求 SLACK_BOT_TOKEN，adapters 数组为空（adapter 暂未实现）', async () => {
  // 工作区 yaml 写 im.enabled: ['wechat']
  // env 中删 SLACK_*  
  // 期望：createApplication 不抛错；返回的 app.adapters 为空数组
  // 期望日志：'WechatAdapter 尚未实现' + 'adapters 为空'（用 logger spy 或 stdout 捕获）
})

it('双开 [slack, wechat]：仍要求 SLACK env，但 adapters 仍只有 slack 一个', async () => {
  // 工作区 im.enabled: ['slack', 'wechat']
  // 完整 SLACK env
  // 期望：app.adapters.length === 1, app.adapters[0].id === 'slack'（wechat 还没实现）
  // 不报缺 SLACK env 错（因为含 slack）
})
```

具体测试搭建（mock workspace / env）按现有模式抄。如果现有用例已直接读真 env，可能需要 `vi.stubEnv`。

- [ ] **Step 1.9.5: 跑测试**

Run: `pnpm vitest run src/application/createApplication.test.ts`
Expected: 全绿

- [ ] **Step 1.9.6: 类型检查**

Run: `pnpm tsc -b`
Expected: 零错

- [ ] **Step 1.9.7: 提交 Task 1.8 + 1.9**

```bash
git add src/agent/tools/index.ts src/agent/tools/tools.test.ts \
        src/application/createApplication.ts src/application/createApplication.test.ts
git commit -m "$(cat <<'EOF'
refactor(app, tools): confirm tool 条件注入 + im.enabled 装配分支

- buildBuiltinTools 改按 ctx.confirm 存在条件注入 ask_confirm /
  self_improve_confirm（之前无条件注入仅靠运行时降级）
- createApplication: SLACK_* env 抽到 loadSlackEnv()，仅 enabled
  含 slack 时加载；adapters 数组按 enabled 分支构造；wechat
  分支暂留 TODO + warn 日志（Chunk 3 实装）；adapters 为空时
  打 warn 提醒
- channelTaskLedger 也只在 slack enabled 时构造

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

### Task 1.10: Chunk 1 终验

- [ ] **Step 1.10.1: 全套测试**

Run: `pnpm vitest run`
Expected: 全绿

- [ ] **Step 1.10.2: 类型检查**

Run: `pnpm tsc -b`
Expected: 零错

- [ ] **Step 1.10.3: 验证仅 slack 工作区行为不变（手动）**

启动现有 slack 工作区（默认 yaml `im.enabled: [slack]`，或迁移自 `im.provider: slack` 的旧 yaml），@bot 发一条消息，确认 bot 正常回复，无回归。

- [ ] **Step 1.10.4: 验证仅 wechat 工作区可启动（手动）**

新建一个空工作区或手改 `.agent-slack/config.yaml` 里的 `im.enabled: ['wechat']`（不要求 SLACK_BOT_TOKEN env），启动服务。预期：

- 日志看到 `provider=... im.enabled=wechat`
- 看到 warn `WechatAdapter 尚未实现（计划在 Chunk 3 落地）`
- 看到 warn `adapters 为空`
- 进程启动后保持运行（虽然没 IM 在跑），可以正常 SIGTERM 退出
- 不报"缺少 SLACK_BOT_TOKEN"错

---

## Chunk 2: WechatApi HTTP 客户端 + 凭证管理（S2 一半）

**Chunk 目标：** 实现纯 HTTP 客户端 `WechatApi`（getUpdates / sendText / fetchQrCode / pollQrStatus / getConfig）+ 凭证文件读写 `CredentialsStore`。两个模块都可独立单测，不依赖 orchestrator / config。本 chunk 完成后**仍未引入 WechatAdapter**（adapters 仍为空数组），但底层所有 HTTP 能力已具备并被覆盖测试。

**Chunk 验证终点（运行 `pnpm vitest run` 全绿）：**
- 新增 `WechatApi.test.ts` 全绿（mock fetch；headers / base_info / endpoint paths / timeout 行为 / errcode 透传）
- 新增 `CredentialsStore.test.ts` 全绿（写读、不存在文件、chmod 0600 在非 Windows 验证）
- 现有所有测试无回归
- `pnpm tsc -b` 类型零错

**参考文件**：
- [external-references/CowAgent/channel/weixin/weixin_api.py](../../../external-references/CowAgent/channel/weixin/weixin_api.py)（直接对照 Python 反向 SDK）
- spec §6（接口定义、实现要点、凭证管理）

---

### Task 2.1: 装 `qrcode-terminal` 依赖

**Files:**
- Modify: `package.json`

`qrcode-terminal` 用于在 WechatAdapter 启动时打印 ASCII 二维码（Chunk 3 用，本 chunk 提前装好以避免 chunk 边界 dependency churn）。

- [ ] **Step 2.1.1: 装包**

Run: `pnpm add qrcode-terminal && pnpm add -D @types/qrcode-terminal`
Expected: `package.json` 与 `pnpm-lock.yaml` 更新

- [ ] **Step 2.1.2: 验证**

Run: `pnpm tsc -b`
Expected: 零错（暂未使用）

- [ ] **Step 2.1.3: 提交**

```bash
git add package.json pnpm-lock.yaml
git commit -m "chore(deps): 添加 qrcode-terminal 依赖（wechat 扫码登录用）"
```

---

### Task 2.2: 定义 wechat 协议类型 + WechatApi 接口骨架

**Files:**
- Create: `src/im/wechat/protocol.ts`（HTTP 响应/请求类型）
- Create: `src/im/wechat/WechatApi.ts`（接口骨架，实现见后续 task）

把腾讯 ilink bot 的 JSON 协议类型集中在 `protocol.ts`，让 `WechatApi.ts` 与 `WechatAdapter.ts` 都可引用，不至于把 string literal 散落各处。

- [ ] **Step 2.2.1: 创建 `src/im/wechat/protocol.ts`**

```ts
// 腾讯 ilink bot HTTP 协议类型定义
// 反向工程自 CowAgent channel/weixin/weixin_api.py

/** 消息 item 类型（CowAgent 的 ITEM_* 常量） */
export const enum WeixinItemType {
  TEXT = 1,
  IMAGE = 2,
  VOICE = 3,
  FILE = 4,
  VIDEO = 5,
}

/** 消息发送方类型 */
export const enum WeixinMessageType {
  USER = 1,  // 用户发给 bot
  BOT = 2,   // bot 发给用户
}

export const enum WeixinMessageState {
  /** sendmessage 必须传 2 = FINISH，CowAgent 同设计 */
  FINISH = 2,
}

export interface WeixinTextItem {
  type: WeixinItemType.TEXT
  text_item: { text: string }
}

export interface WeixinMediaItem {
  type: WeixinItemType.IMAGE | WeixinItemType.VOICE | WeixinItemType.FILE | WeixinItemType.VIDEO
  // MVP 不解析，保留字段以便日志
  [key: string]: unknown
}

export type WeixinItem = WeixinTextItem | WeixinMediaItem

export interface InboundWeixinMessage {
  message_type: WeixinMessageType
  message_id?: string
  seq?: string | number
  from_user_id: string
  to_user_id: string
  context_token: string
  create_time_ms?: number
  item_list: WeixinItem[]
}

export interface GetUpdatesResp {
  ret?: number
  errcode?: number
  errmsg?: string
  /** 同步游标，下次 getUpdates 透传 */
  get_updates_buf?: string
  msgs?: InboundWeixinMessage[]
}

export interface QrStatusResp {
  /** wait | scaned | expired | confirmed */
  status: string
  qrcode?: string
  bot_token?: string
  ilink_bot_id?: string
  ilink_user_id?: string
  baseurl?: string
}

export interface FetchQrCodeResp {
  qrcode: string
  qrcode_img_content: string
}

/** errcode -14 = session 过期，触发 relogin */
export const ERRCODE_SESSION_EXPIRED = -14
```

- [ ] **Step 2.2.2: 创建 `src/im/wechat/WechatApi.ts` 骨架**

```ts
import { randomUUID } from 'node:crypto'
import {
  ERRCODE_SESSION_EXPIRED,
  WeixinItemType,
  WeixinMessageState,
  WeixinMessageType,
  type FetchQrCodeResp,
  type GetUpdatesResp,
  type QrStatusResp,
} from './protocol.ts'

export interface WechatCredentials {
  /** sendmessage / getupdates 鉴权 Bearer */
  token: string
  /** ilink 主域，扫码后由服务端返回（可能与配置默认值不同） */
  baseUrl: string
  /** 仅用于日志/可观察性，HTTP 调用不带 */
  botId: string
  /** 仅用于日志/可观察性，HTTP 调用不带 */
  userId: string
}

export interface WechatApiOpts {
  baseUrl: string
  cdnBaseUrl: string
  token?: string
}

const CHANNEL_VERSION = '2.0.0'
const CLIENT_VERSION = '131072'  // 2.0.0 编码 = 0x00020000
const BOT_TYPE = '3'
const DEFAULT_LONG_POLL_TIMEOUT_MS = 35_000
const LONG_POLL_BUFFER_MS = 5_000
const DEFAULT_API_TIMEOUT_MS = 15_000

export class WechatApi {
  baseUrl: string
  cdnBaseUrl: string
  private token: string

  constructor(opts: WechatApiOpts) {
    this.baseUrl = opts.baseUrl.endsWith('/') ? opts.baseUrl : opts.baseUrl + '/'
    this.cdnBaseUrl = opts.cdnBaseUrl
    this.token = opts.token ?? ''
  }

  setToken(token: string): void {
    this.token = token
  }

  // 实现见后续 task
  async getUpdates(_buf: string, _signal?: AbortSignal): Promise<GetUpdatesResp> {
    throw new Error('not implemented')
  }
  async sendText(_to: string, _text: string, _contextToken: string): Promise<void> {
    throw new Error('not implemented')
  }
  async getConfig(_userId: string, _contextToken?: string): Promise<unknown> {
    throw new Error('not implemented')
  }
  async fetchQrCode(): Promise<FetchQrCodeResp> {
    throw new Error('not implemented')
  }
  async pollQrStatus(_qrcode: string): Promise<QrStatusResp> {
    throw new Error('not implemented')
  }
}

export { ERRCODE_SESSION_EXPIRED }
```

- [ ] **Step 2.2.3: 类型检查**

Run: `pnpm tsc -b`
Expected: 零错（仅骨架，未导出未引用）

- [ ] **Step 2.2.4: 不 commit**（与 Task 2.3 一起 commit）

---

### Task 2.3: WechatApi 实现 `_post` 通用方法 + headers + base_info

**Files:**
- Modify: `src/im/wechat/WechatApi.ts`
- Create: `src/im/wechat/WechatApi.test.ts`

实现 `_post` 私有方法（统一 headers / body / timeout）。这是其他 endpoint 方法的基础。

- [ ] **Step 2.3.1: 在 `WechatApi` 类内加 `_post`**

```ts
private async _post<T>(
  endpoint: string,
  body: Record<string, unknown>,
  opts?: { timeoutMs?: number; signal?: AbortSignal },
): Promise<T> {
  const url = this.baseUrl + endpoint
  const timeoutMs = opts?.timeoutMs ?? DEFAULT_API_TIMEOUT_MS
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    AuthorizationType: 'ilink_bot_token',
    'X-WECHAT-UIN': randomUin(),
    'iLink-App-Id': 'bot',
    'iLink-App-ClientVersion': CLIENT_VERSION,
  }
  if (this.token) headers.Authorization = `Bearer ${this.token}`

  // 注入 base_info.channel_version
  const wrappedBody = {
    ...body,
    base_info: { channel_version: CHANNEL_VERSION, ...((body.base_info as object) ?? {}) },
  }

  // 组合 timeout signal 与外部传入的 abort signal
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), timeoutMs)
  if (opts?.signal) {
    if (opts.signal.aborted) ctl.abort()
    else opts.signal.addEventListener('abort', () => ctl.abort(), { once: true })
  }

  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(wrappedBody),
      signal: ctl.signal,
    })
    if (!resp.ok) throw new Error(`HTTP ${resp.status} ${endpoint}`)
    return (await resp.json()) as T
  } finally {
    clearTimeout(timer)
  }
}
```

文件末尾加 helper：

```ts
function randomUin(): string {
  const val = Math.floor(Math.random() * 0xffffffff)
  return Buffer.from(String(val), 'utf8').toString('base64')
}
```

- [ ] **Step 2.3.2: 类型检查**

Run: `pnpm tsc -b`
Expected: 零错（_post 是 private，本 task 不写测试，等 Task 2.4 通过 getUpdates 公共方法间接覆盖）

注：跳过此处独立测试是有意为之——`_post` 是私有方法，对外行为只能通过公共方法（getUpdates / sendText / getConfig）观察。把测试推到 Task 2.4 一起开，避免占位无意义测试。

---

### Task 2.4: 实现 `getUpdates` 与 `sendText` + 测试

**Files:**
- Modify: `src/im/wechat/WechatApi.ts`
- Modify: `src/im/wechat/WechatApi.test.ts`

按 spec §6.2 与 CowAgent `weixin_api.py:89-107`。

- [ ] **Step 2.4.1: `getUpdates` 实现（替换骨架）**

```ts
async getUpdates(buf: string, signal?: AbortSignal): Promise<GetUpdatesResp> {
  try {
    return await this._post<GetUpdatesResp>(
      'ilink/bot/getupdates',
      { get_updates_buf: buf },
      {
        timeoutMs: DEFAULT_LONG_POLL_TIMEOUT_MS + LONG_POLL_BUFFER_MS,
        ...(signal ? { signal } : {}),
      },
    )
  } catch (err) {
    // long-poll 超时是常态：返回空响应让上层继续下一轮
    if (err instanceof Error && err.name === 'AbortError') {
      return { ret: 0, msgs: [] }
    }
    throw err
  }
}
```

注：CowAgent 把所有 timeout 都视为空响应；这里我们仅在外层 abort（含我们自己的 timeoutMs）触发时返回空。`signal.aborted` 由调用方触发的也走这里——为了简单不区分。如果调用方 abort（adapter stop），上层 long-poll loop 会检查 `stop.signal.aborted` 退出循环，不会被这次空响应误导。

- [ ] **Step 2.4.2: `sendText` 实现**

```ts
async sendText(to: string, text: string, contextToken: string): Promise<void> {
  await this._post('ilink/bot/sendmessage', {
    msg: {
      from_user_id: '',
      to_user_id: to,
      client_id: randomUUID().replace(/-/g, '').slice(0, 16),
      message_type: WeixinMessageType.BOT,
      message_state: WeixinMessageState.FINISH,
      item_list: [{ type: WeixinItemType.TEXT, text_item: { text } }],
      context_token: contextToken,
    },
  })
}
```

- [ ] **Step 2.4.3: `getConfig` 实现**

```ts
async getConfig(userId: string, contextToken: string = ''): Promise<unknown> {
  return await this._post<unknown>(
    'ilink/bot/getconfig',
    { ilink_user_id: userId, context_token: contextToken },
    { timeoutMs: 10_000 },
  )
}
```

- [ ] **Step 2.4.4: 创建 `src/im/wechat/WechatApi.test.ts`**

```ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { WechatApi } from './WechatApi.ts'
import { ERRCODE_SESSION_EXPIRED } from './protocol.ts'

describe('WechatApi.getUpdates', () => {
  let fetchMock: ReturnType<typeof vi.fn>
  let api: WechatApi

  beforeEach(() => {
    fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    api = new WechatApi({
      baseUrl: 'https://ilink.example/',
      cdnBaseUrl: 'https://cdn.example',
      token: 'tok-abc',
    })
  })
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

  it('POST /ilink/bot/getupdates；body 含 get_updates_buf 与 base_info', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ ret: 0, msgs: [], get_updates_buf: 'buf2' }),
    })
    const resp = await api.getUpdates('buf1')

    expect(fetchMock).toHaveBeenCalledOnce()
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('https://ilink.example/ilink/bot/getupdates')
    expect(init.method).toBe('POST')
    const body = JSON.parse(init.body)
    expect(body.get_updates_buf).toBe('buf1')
    expect(body.base_info).toEqual({ channel_version: '2.0.0' })
    expect(init.headers['Authorization']).toBe('Bearer tok-abc')
    expect(init.headers['AuthorizationType']).toBe('ilink_bot_token')
    expect(init.headers['iLink-App-Id']).toBe('bot')
    expect(init.headers['iLink-App-ClientVersion']).toBe('131072')
    expect(init.headers['X-WECHAT-UIN']).toMatch(/^[A-Za-z0-9+/=]+$/)
    expect(resp.get_updates_buf).toBe('buf2')
  })

  it('long-poll abort（timeout 触发）返回空响应 { ret:0, msgs:[] }', async () => {
    fetchMock.mockImplementation((_url, init: RequestInit) => {
      return new Promise((_resolve, reject) => {
        ;(init.signal as AbortSignal).addEventListener('abort', () => {
          const err = new Error('aborted')
          err.name = 'AbortError'
          reject(err)
        })
      })
    })
    // 用真实定时器太慢，注入超短 timeout 不可行（_post 内部用了固定 const）
    // 解决：测试时直接 abort 一个外部 signal
    const ctl = new AbortController()
    setTimeout(() => ctl.abort(), 0)
    const resp = await api.getUpdates('', ctl.signal)
    expect(resp).toEqual({ ret: 0, msgs: [] })
  })

  it('errcode -14 透传给调用方', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ ret: 0, errcode: -14, errmsg: 'session expired' }),
    })
    const resp = await api.getUpdates('')
    expect(resp.errcode).toBe(ERRCODE_SESSION_EXPIRED)
    expect(resp.errmsg).toBe('session expired')
  })

  it('randomUin round-trip 是数字字符串的 base64', async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ ret: 0 }) })
    await api.getUpdates('')
    const init = fetchMock.mock.calls[0][1]
    const uinB64 = init.headers['X-WECHAT-UIN']
    const decoded = Buffer.from(uinB64, 'base64').toString('utf8')
    expect(decoded).toMatch(/^\d+$/)  // 解码出来必须是纯十进制数字串（CowAgent 设计）
  })

  it('HTTP 非 2xx 抛错', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 500 })
    await expect(api.getUpdates('')).rejects.toThrow(/HTTP 500/)
  })
})

describe('WechatApi.sendText', () => {
  let fetchMock: ReturnType<typeof vi.fn>
  let api: WechatApi

  beforeEach(() => {
    fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) })
    vi.stubGlobal('fetch', fetchMock)
    api = new WechatApi({ baseUrl: 'https://ilink.example/', cdnBaseUrl: 'https://cdn.example', token: 'tok' })
  })
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

  it('POST /ilink/bot/sendmessage；body 结构对齐 CowAgent', async () => {
    await api.sendText('uABC', 'hello', 'ctx-123')
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('https://ilink.example/ilink/bot/sendmessage')
    const body = JSON.parse(init.body)
    expect(body.msg.from_user_id).toBe('')
    expect(body.msg.to_user_id).toBe('uABC')
    expect(body.msg.message_type).toBe(2)   // BOT
    expect(body.msg.message_state).toBe(2)  // FINISH
    expect(body.msg.context_token).toBe('ctx-123')
    expect(body.msg.client_id).toMatch(/^[a-f0-9]{16}$/)
    expect(body.msg.item_list).toEqual([{ type: 1, text_item: { text: 'hello' } }])
  })
})
```

- [ ] **Step 2.4.5: 跑测试**

Run: `pnpm vitest run src/im/wechat/WechatApi.test.ts`
Expected: 全绿

注：long-poll 的 abort 行为同样适用——caller 通过 AbortSignal 主动 abort（如 adapter `stop()`）后会拿到 `{ret:0,msgs:[]}`；上层 long-poll loop 必须靠 stop flag 而非空响应判断退出（已在 spec §6.2 / §7.2 明确）。

---

### Task 2.5: 实现 `fetchQrCode` 与 `pollQrStatus` + 测试

**Files:**
- Modify: `src/im/wechat/WechatApi.ts`
- Modify: `src/im/wechat/WechatApi.test.ts`

扫码登录的两个 GET endpoint。CowAgent `weixin_api.py:213-231` 对照。

- [ ] **Step 2.5.1: 加私有 `_get` helper（与 _post 平级）**

```ts
private async _get<T>(
  fullUrl: string,
  opts?: { timeoutMs?: number; withHeaders?: boolean },
): Promise<T> {
  const timeoutMs = opts?.timeoutMs ?? DEFAULT_API_TIMEOUT_MS
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), timeoutMs)
  const headers: Record<string, string> = opts?.withHeaders
    ? { 'iLink-App-Id': 'bot', 'iLink-App-ClientVersion': CLIENT_VERSION }
    : {}
  try {
    const resp = await fetch(fullUrl, { method: 'GET', headers, signal: ctl.signal })
    if (!resp.ok) throw new Error(`HTTP ${resp.status} ${fullUrl}`)
    return (await resp.json()) as T
  } finally {
    clearTimeout(timer)
  }
}
```

- [ ] **Step 2.5.2: `fetchQrCode` 实现**

```ts
async fetchQrCode(): Promise<FetchQrCodeResp> {
  const url = `${this.baseUrl}ilink/bot/get_bot_qrcode?bot_type=${BOT_TYPE}`
  return await this._get<FetchQrCodeResp>(url, { timeoutMs: 15_000 })
}
```

- [ ] **Step 2.5.3: `pollQrStatus` 实现**

```ts
async pollQrStatus(qrcode: string): Promise<QrStatusResp> {
  const url = `${this.baseUrl}ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcode)}`
  try {
    return await this._get<QrStatusResp>(url, { timeoutMs: 35_000, withHeaders: true })
  } catch (err) {
    // 与 CowAgent 一致：超时返回 wait 让上层继续轮询
    if (err instanceof Error && err.name === 'AbortError') {
      return { status: 'wait' }
    }
    throw err
  }
}
```

- [ ] **Step 2.5.4: 测试 — fetchQrCode / pollQrStatus**

加在 `WechatApi.test.ts` 末尾：

```ts
describe('WechatApi.fetchQrCode / pollQrStatus', () => {
  let fetchMock: ReturnType<typeof vi.fn>
  let api: WechatApi

  beforeEach(() => {
    fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    api = new WechatApi({ baseUrl: 'https://ilink.example/', cdnBaseUrl: 'https://cdn.example' })
  })
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

  it('fetchQrCode：GET /ilink/bot/get_bot_qrcode?bot_type=3', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ qrcode: 'qr-abc', qrcode_img_content: 'https://qr.example/...' }),
    })
    const resp = await api.fetchQrCode()
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('https://ilink.example/ilink/bot/get_bot_qrcode?bot_type=3')
    expect(init.method).toBe('GET')
    expect(resp.qrcode).toBe('qr-abc')
  })

  it('pollQrStatus：GET /ilink/bot/get_qrcode_status?qrcode=...，URL 编码', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ status: 'wait' }),
    })
    await api.pollQrStatus('qr/abc?special')
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toContain(encodeURIComponent('qr/abc?special'))
    expect(init.headers['iLink-App-Id']).toBe('bot')
  })

  it('pollQrStatus AbortError 返回 { status: wait }（CowAgent 同设计）', async () => {
    // 直接 mock fetch reject 一个 AbortError，避开 fakeTimer 相关脆弱性
    const abortErr = new Error('aborted')
    abortErr.name = 'AbortError'
    fetchMock.mockRejectedValueOnce(abortErr)
    const resp = await api.pollQrStatus('qr')
    expect(resp).toEqual({ status: 'wait' })
  })
})
```

注：CowAgent (`weixin_api.py:226-231`) 把所有 `requests.exceptions.Timeout` 视为 `{status: 'wait'}` 让上层继续轮询。我们用 `AbortError` 走同一路径（_get 内部 timer 触发 abort 后 fetch reject 时 err.name === 'AbortError'）。直接 mock reject 比 fake timer 稳定。

- [ ] **Step 2.5.5: 跑测试**

Run: `pnpm vitest run src/im/wechat/WechatApi.test.ts`
Expected: 全绿（如果超时 case 不稳，临时 skip）

- [ ] **Step 2.5.6: 提交 Task 2.2 + 2.3 + 2.4 + 2.5**

```bash
git add src/im/wechat/protocol.ts src/im/wechat/WechatApi.ts src/im/wechat/WechatApi.test.ts
git commit -m "$(cat <<'EOF'
feat(wechat): WechatApi HTTP 客户端 + ilink 协议类型

- protocol.ts: ilink bot 协议类型（item types / message types /
  GetUpdatesResp / QrStatusResp / FetchQrCodeResp / errcode 常量）
- WechatApi.ts: 直连 https://ilinkai.weixin.qq.com/ilink/bot/*
  - getUpdates (long-poll 40s timeout，超时返回空让上层继续)
  - sendText (item_list type=1 text_item)
  - getConfig
  - fetchQrCode / pollQrStatus (GET 路径)
  - 通用 headers (Authorization Bearer / X-WECHAT-UIN 随机 / iLink-App-Id)
  - body 自动注入 base_info.channel_version=2.0.0
- WechatApi.test.ts mock fetch 验证 endpoint / headers / body 结构

不依赖 orchestrator / config，纯 HTTP 客户端。CowAgent
channel/weixin/weixin_api.py 反向工程对照。

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2.6: `CredentialsStore` 实现 + 测试

**Files:**
- Create: `src/im/wechat/CredentialsStore.ts`
- Create: `src/im/wechat/CredentialsStore.test.ts`

按 spec §6.3：load / save / clear；save 后 chmod 0600，Windows 静默失败。

- [ ] **Step 2.6.1: 创建 `src/im/wechat/CredentialsStore.ts`**

```ts
import { readFile, writeFile, mkdir, unlink, chmod } from 'node:fs/promises'
import path from 'node:path'
import type { WechatCredentials } from './WechatApi.ts'

export interface CredentialsStore {
  load(filePath: string): Promise<WechatCredentials | undefined>
  save(filePath: string, creds: WechatCredentials): Promise<void>
  clear(filePath: string): Promise<void>
}

export function createCredentialsStore(): CredentialsStore {
  return {
    async load(filePath) {
      try {
        const raw = await readFile(filePath, 'utf8')
        const parsed = JSON.parse(raw) as Partial<WechatCredentials>
        if (!parsed.token || !parsed.baseUrl) return undefined
        return {
          token: parsed.token,
          baseUrl: parsed.baseUrl,
          botId: parsed.botId ?? '',
          userId: parsed.userId ?? '',
        }
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined
        throw err
      }
    },

    async save(filePath, creds) {
      await mkdir(path.dirname(filePath), { recursive: true })
      await writeFile(filePath, JSON.stringify(creds, null, 2), 'utf8')
      // Windows / 非 POSIX FS 上 chmod 0600 会静默忽略或报错；按 CowAgent 设计兜底
      try {
        await chmod(filePath, 0o600)
      } catch {
        // 忽略
      }
    },

    async clear(filePath) {
      try {
        await unlink(filePath)
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
      }
    },
  }
}
```

- [ ] **Step 2.6.2: 创建 `src/im/wechat/CredentialsStore.test.ts`**

```ts
import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtempSync, statSync } from 'node:fs'
import { tmpdir, platform } from 'node:os'
import path from 'node:path'
import { createCredentialsStore } from './CredentialsStore.ts'

describe('CredentialsStore', () => {
  let dir: string
  let filePath: string
  const store = createCredentialsStore()

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'wechat-cred-'))
    filePath = path.join(dir, 'subdir', 'credentials.json')
  })

  it('save 然后 load 返回相同凭证；目录会自动创建', async () => {
    await store.save(filePath, {
      token: 'tok-1', baseUrl: 'https://ilink.example/', botId: 'b', userId: 'u',
    })
    const loaded = await store.load(filePath)
    expect(loaded).toEqual({
      token: 'tok-1', baseUrl: 'https://ilink.example/', botId: 'b', userId: 'u',
    })
  })

  it('load 不存在的文件返回 undefined', async () => {
    const loaded = await store.load(path.join(dir, 'nope.json'))
    expect(loaded).toBeUndefined()
  })

  it('load 损坏的 JSON 抛错', async () => {
    const bad = path.join(dir, 'bad.json')
    const fs = await import('node:fs/promises')
    await fs.writeFile(bad, '{ not json }', 'utf8')
    await expect(store.load(bad)).rejects.toThrow()
  })

  it('load 缺关键字段（token/baseUrl）返回 undefined', async () => {
    const bad = path.join(dir, 'partial.json')
    const fs = await import('node:fs/promises')
    await fs.writeFile(bad, JSON.stringify({ botId: 'b' }), 'utf8')
    expect(await store.load(bad)).toBeUndefined()
  })

  it('save 后文件权限是 0600（非 Windows）', async () => {
    if (platform() === 'win32') return  // skip on Windows
    await store.save(filePath, { token: 't', baseUrl: 'b', botId: '', userId: '' })
    const mode = statSync(filePath).mode & 0o777
    expect(mode).toBe(0o600)
  })

  it('clear 删除文件；不存在时不抛错', async () => {
    await store.save(filePath, { token: 't', baseUrl: 'b', botId: '', userId: '' })
    await store.clear(filePath)
    expect(await store.load(filePath)).toBeUndefined()
    // 再 clear 一次不抛
    await expect(store.clear(filePath)).resolves.toBeUndefined()
  })
})
```

- [ ] **Step 2.6.3: 跑测试**

Run: `pnpm vitest run src/im/wechat/CredentialsStore.test.ts`
Expected: 全绿

- [ ] **Step 2.6.4: 提交**

```bash
git add src/im/wechat/CredentialsStore.ts src/im/wechat/CredentialsStore.test.ts
git commit -m "$(cat <<'EOF'
feat(wechat): CredentialsStore 实现 + 测试

- load: 读 .agent-slack/wechat/credentials.json，缺字段返 undefined
- save: 自动创建目录；写完 chmod 0600（Windows 静默失败）
- clear: 删除文件；不存在时不抛错（relogin 流程容错）

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2.7: Chunk 2 终验

- [ ] **Step 2.7.1: 全套测试**

Run: `pnpm vitest run`
Expected: 全绿

- [ ] **Step 2.7.2: 类型检查**

Run: `pnpm tsc -b`
Expected: 零错

- [ ] **Step 2.7.3: 验证 wechat/ 目录结构**

```
src/im/wechat/
├── protocol.ts
├── WechatApi.ts
├── WechatApi.test.ts
├── CredentialsStore.ts
└── CredentialsStore.test.ts
```

Adapter / Renderer / EventSink 仍未引入（在 Chunk 3）。

---

## Chunk 3: WechatAdapter / Renderer / EventSink + 端到端装配（S3）

**Chunk 目标：** 实现 `WechatRenderer` / `WechatEventSink` / `WechatAdapter` 三件套并装配进 `createApplication`。本 chunk 完成后**仅启用 wechat 的工作区可完整工作**：扫码登录 → long-poll 收消息 → orchestrator 处理 → 文本回复送达。Slack 路径仍无回归；双开模式可同进程运行。

**Chunk 验证终点（运行 `pnpm vitest run` 全绿 + 手动验证清单通过）：**
- 新增 `WechatRenderer.test.ts` 全绿（事件 → 文本段；分段策略；工具调用摘要；failed 错误文案）
- 新增 `WechatEventSink.test.ts` 全绿（finalize 顺序；段间 sleep；起始消息；段内失败处理）
- 新增 `WechatAdapter.test.ts` 全绿（凭证存在/不存在路径；processMessage；errcode -14 relogin；stop abort）
- 改造 `createApplication.test.ts` 全绿（仅 wechat 时 adapter 真实装配；双开两个 adapter）
- 现有所有测试无回归
- `pnpm tsc -b` 类型零错
- 手动验证清单（spec §12.4）至少 #1（仅 wechat 文本 round-trip）和 #2（重启复用凭证）通过

**前置依赖（来自 Chunk 1 / Chunk 2）：**
- `src/im/types.ts` 的 `InboundMessage.imProvider` 已是 `ImProvider` union（含 `'wechat'`）
- `src/store/SessionStore.ts` 的 `imProvider` 字段已升级为 union 且 `getOrCreate` / `appendEvent` 按 imProvider 分桶
- `ctx.paths.wechatCredentialsFile: string` 已在 `WorkspacePaths` 定义并被 `resolveWorkspacePaths` 返回
- `src/agent/tools/index.ts` 的 `buildBuiltinTools` 已按 `ctx.confirm` 条件注入
- `WechatApi.sendText(toUserId: string, text: string, contextToken: string): Promise<void>` 签名（Chunk 2 定义）
- `WechatApi.setToken(token: string): void` 方法（Chunk 2 定义）
- `WechatApi.fetchQrCode()` / `pollQrStatus(qrcode)` / `getUpdates(buf, signal?)` 签名（Chunk 2 定义）
- `CredentialsStore` 的 `load / save / clear` 接口（Chunk 2 定义）

**参考文件**：
- [external-references/CowAgent/channel/weixin/weixin_channel.py](../../../external-references/CowAgent/channel/weixin/weixin_channel.py)
- spec §7（WechatAdapter）/ §8（Renderer / EventSink）/ §10（createApplication 装配）

---

### Task 3.1: `WechatRenderer` 实现 + 测试

**Files:**
- Create: `src/im/wechat/WechatRenderer.ts`
- Create: `src/im/wechat/WechatRenderer.test.ts`

按 spec §8.1：累积事件，最终产出 `string[]` 文本段列表。

- [ ] **Step 3.1.1: 创建 `src/im/wechat/WechatRenderer.ts`**

```ts
import type { AgentExecutionEvent } from '@/core/events.ts'
import type { Logger } from '@/logger/logger.ts'

export interface WechatRendererDeps {
  logger: Logger
}

export interface WechatRenderer {
  /** 累积一个事件到 renderer 内部状态 */
  onEvent(event: AgentExecutionEvent): void
  /** finalize 时取出所有待发送的文本段 */
  flush(): string[]
  /** 起始消息文本（首段） */
  readonly STARTING_MESSAGE: string
}

const TEXT_CHUNK_LIMIT = 4000
const STARTING_MESSAGE = '开始处理...'

export function createWechatRenderer(deps: WechatRendererDeps): WechatRenderer {
  const log = deps.logger.withTag('wechat:renderer')
  // 累积态
  const assistantTexts: string[] = []
  const toolNamesUsed = new Set<string>()
  let terminalPhase: 'completed' | 'stopped' | 'failed' | undefined
  let failedError: string | undefined

  return {
    STARTING_MESSAGE,

    onEvent(event) {
      switch (event.type) {
        case 'assistant-message':
          if (event.text.trim()) assistantTexts.push(event.text)
          break
        case 'activity-state':
          // 注意：clear / newToolCalls 在 event.state 上（src/core/events.ts ActivityState union），不在 event 顶层
          if (event.state.clear !== true && event.state.newToolCalls?.length) {
            for (const name of event.state.newToolCalls) toolNamesUsed.add(name)
          }
          break
        case 'lifecycle':
          if (event.phase === 'completed' || event.phase === 'stopped' || event.phase === 'failed') {
            terminalPhase = event.phase
            if (event.phase === 'failed') failedError = event.error.message
          }
          break
        case 'usage-info':
          // wechat 不展示 usage
          break
      }
    },

    flush() {
      const segments: string[] = []

      // 工具调用摘要
      if (toolNamesUsed.size > 0) {
        const sorted = [...toolNamesUsed].sort()
        segments.push(`🔧 使用了工具: ${sorted.join(', ')}`)
      }

      // assistant 文本拼接 + 分段
      const fullText = assistantTexts.join('\n\n').trim()
      if (fullText) {
        segments.push(...splitText(fullText, TEXT_CHUNK_LIMIT))
      }

      // 失败态追加错误提示
      if (terminalPhase === 'failed' && failedError) {
        const safeError = failedError.split('\n')[0]?.slice(0, 200) ?? '未知错误'
        segments.push(`⚠️ 处理失败：${safeError}`)
      }

      // 没任何输出时，至少回复一条占位文本，避免静默
      if (segments.length === 0) {
        log.warn('flush 时无任何 segment（assistant text 与 tool 调用都为空）')
        segments.push('（本轮无输出）')
      }

      return segments
    },
  }
}

/** 按 \n\n / \n / 硬切 三级策略把超长文本分段 */
export function splitText(text: string, limit: number): string[] {
  if (text.length <= limit) return [text]
  const chunks: string[] = []
  let rest = text
  while (rest.length > 0) {
    if (rest.length <= limit) {
      chunks.push(rest)
      break
    }
    // 优先在 limit 以内的 \n\n 切
    let cut = rest.lastIndexOf('\n\n', limit)
    if (cut <= 0) cut = rest.lastIndexOf('\n', limit)
    if (cut <= 0) cut = limit
    chunks.push(rest.slice(0, cut))
    rest = rest.slice(cut).replace(/^\n+/, '')
  }
  return chunks
}
```

- [ ] **Step 3.1.2: 创建 `src/im/wechat/WechatRenderer.test.ts`**

```ts
import { describe, it, expect } from 'vitest'
import { createWechatRenderer, splitText } from './WechatRenderer.ts'
import type { AgentExecutionEvent } from '@/core/events.ts'

const stubLogger = () => {
  const make = (): { debug: () => void; info: () => void; warn: () => void; error: () => void; withTag: () => unknown } => ({
    debug: () => {}, info: () => {}, warn: () => {}, error: () => {},
    withTag: () => make(),
  })
  return make() as never
}

describe('WechatRenderer', () => {
  it('仅有 final assistant text → 单段', () => {
    const r = createWechatRenderer({ logger: stubLogger() })
    r.onEvent({ type: 'assistant-message', text: '你好' } as AgentExecutionEvent)
    r.onEvent({ type: 'lifecycle', phase: 'completed', finalMessages: [] } as AgentExecutionEvent)
    expect(r.flush()).toEqual(['你好'])
  })

  it('多段 assistant 文本拼接，间用 \\n\\n', () => {
    const r = createWechatRenderer({ logger: stubLogger() })
    r.onEvent({ type: 'assistant-message', text: '第一段' } as AgentExecutionEvent)
    r.onEvent({ type: 'assistant-message', text: '第二段' } as AgentExecutionEvent)
    r.onEvent({ type: 'lifecycle', phase: 'completed', finalMessages: [] } as AgentExecutionEvent)
    expect(r.flush()).toEqual(['第一段\n\n第二段'])
  })

  it('含工具调用 → 摘要前缀放在最前面', () => {
    const r = createWechatRenderer({ logger: stubLogger() })
    r.onEvent({
      type: 'activity-state',
      state: { status: 's', activities: [], newToolCalls: ['bash', 'read_file'] },
    } as AgentExecutionEvent)
    r.onEvent({
      type: 'activity-state',
      state: { status: 's', activities: [], newToolCalls: ['bash'] },  // 重复 bash 应去重
    } as AgentExecutionEvent)
    r.onEvent({ type: 'assistant-message', text: '完成了' } as AgentExecutionEvent)
    r.onEvent({ type: 'lifecycle', phase: 'completed', finalMessages: [] } as AgentExecutionEvent)
    const segments = r.flush()
    expect(segments[0]).toBe('🔧 使用了工具: bash, read_file')
    expect(segments[1]).toBe('完成了')
  })

  it('失败态 → 末段追加错误提示', () => {
    const r = createWechatRenderer({ logger: stubLogger() })
    r.onEvent({ type: 'assistant-message', text: '试图处理...' } as AgentExecutionEvent)
    r.onEvent({
      type: 'lifecycle', phase: 'failed', error: { message: 'rate limit exceeded\n  at line 42' },
    } as AgentExecutionEvent)
    const segments = r.flush()
    expect(segments[segments.length - 1]).toBe('⚠️ 处理失败：rate limit exceeded')
  })

  it('无任何输出 → 占位文本"（本轮无输出）"', () => {
    const r = createWechatRenderer({ logger: stubLogger() })
    r.onEvent({ type: 'lifecycle', phase: 'completed', finalMessages: [] } as AgentExecutionEvent)
    expect(r.flush()).toEqual(['（本轮无输出）'])
  })

  it('STARTING_MESSAGE 是 "开始处理..."', () => {
    const r = createWechatRenderer({ logger: stubLogger() })
    expect(r.STARTING_MESSAGE).toBe('开始处理...')
  })
})

describe('splitText', () => {
  it('短文本不切', () => {
    expect(splitText('hello', 100)).toEqual(['hello'])
  })

  it('优先按 \\n\\n 切', () => {
    const text = 'a'.repeat(50) + '\n\n' + 'b'.repeat(50) + '\n\n' + 'c'.repeat(50)
    const chunks = splitText(text, 60)
    expect(chunks.length).toBeGreaterThan(1)
    expect(chunks[0]).toBe('a'.repeat(50))
  })

  it('无 \\n\\n 时回退到 \\n 切', () => {
    const text = 'aaaa\nbbbb\ncccc\ndddd'
    const chunks = splitText(text, 6)
    // 期望按行切：'aaaa', 'bbbb', 'cccc', 'dddd' 或类似
    expect(chunks.every((c) => c.length <= 6)).toBe(true)
    expect(chunks.join('').replace(/\n/g, '')).toBe('aaaabbbbccccdddd')
  })

  it('硬切兜底（超长无换行字符串）', () => {
    const text = 'a'.repeat(100)
    const chunks = splitText(text, 30)
    expect(chunks.every((c) => c.length <= 30)).toBe(true)
    expect(chunks.join('')).toBe(text)
  })
})
```

- [ ] **Step 3.1.3: 跑测试**

Run: `pnpm vitest run src/im/wechat/WechatRenderer.test.ts`
Expected: 全绿

---

### Task 3.2: `WechatEventSink` 实现 + 测试

**Files:**
- Create: `src/im/wechat/WechatEventSink.ts`
- Create: `src/im/wechat/WechatEventSink.test.ts`

按 spec §8.2：构造时由 adapter 注入 `{ toUserId, contextToken, api, renderer, logger }` 快照；onEvent 累积；首个事件时立即发"开始处理..."；finalize 串行发所有 segments，段间 sleep 500ms。

- [ ] **Step 3.2.1: 创建 `src/im/wechat/WechatEventSink.ts`**

```ts
import type { AgentExecutionEvent } from '@/core/events.ts'
import type { EventSink } from '@/im/types.ts'
import type { Logger } from '@/logger/logger.ts'
import type { WechatApi } from './WechatApi.ts'
import type { WechatRenderer } from './WechatRenderer.ts'

export interface WechatEventSinkDeps {
  api: WechatApi
  renderer: WechatRenderer
  toUserId: string
  contextToken: string
  logger: Logger
}

const SEGMENT_INTER_DELAY_MS = 500

export function createWechatEventSink(deps: WechatEventSinkDeps): EventSink {
  const log = deps.logger.withTag('wechat:sink')
  let startingMessageSent = false
  let terminalPhase: 'completed' | 'stopped' | 'failed' | undefined

  return {
    get terminalPhase() { return terminalPhase },

    async onEvent(event: AgentExecutionEvent) {
      try {
        // 首个事件触发"开始处理..."一次
        if (!startingMessageSent) {
          startingMessageSent = true
          // 不 await：起始消息失败不应阻塞 orchestrator
          deps.api
            .sendText(deps.toUserId, deps.renderer.STARTING_MESSAGE, deps.contextToken)
            .catch((err) => log.warn('起始消息发送失败', { err }))
        }

        if (event.type === 'lifecycle') {
          if (event.phase === 'completed' || event.phase === 'stopped' || event.phase === 'failed') {
            terminalPhase = event.phase
          }
        }

        deps.renderer.onEvent(event)
      } catch (err) {
        log.error('onEvent 内部异常（不冒泡）', err)
      }
    },

    async finalize() {
      const segments = deps.renderer.flush()
      for (const [i, seg] of segments.entries()) {
        try {
          await deps.api.sendText(deps.toUserId, seg, deps.contextToken)
        } catch (err) {
          log.error('段发送失败', { i, err })
          // 不重试，避免 spam 触发风控
          // 尝试发一条简短的失败提示（也可能失败，再 catch）
          try {
            await deps.api.sendText(deps.toUserId, '[消息发送失败]', deps.contextToken)
          } catch { /* 二次失败放弃 */ }
        }
        if (i < segments.length - 1) await sleep(SEGMENT_INTER_DELAY_MS)
      }
    },
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms))
}
```

- [ ] **Step 3.2.2: 创建 `src/im/wechat/WechatEventSink.test.ts`**

```ts
import { describe, it, expect, vi } from 'vitest'
import { createWechatEventSink } from './WechatEventSink.ts'
import { createWechatRenderer } from './WechatRenderer.ts'
import type { AgentExecutionEvent } from '@/core/events.ts'

const stubLogger = () => {
  const make = (): { debug: () => void; info: () => void; warn: () => void; error: () => void; withTag: () => unknown } => ({
    debug: () => {}, info: () => {}, warn: () => {}, error: () => {},
    withTag: () => make(),
  })
  return make() as never
}

const stubApi = () => {
  const sendText = vi.fn().mockResolvedValue(undefined)
  return { sendText, baseUrl: '', cdnBaseUrl: '' } as never
}

describe('WechatEventSink', () => {
  it('首个事件触发"开始处理..."消息（不阻塞 onEvent 返回）', async () => {
    const api = stubApi()
    const renderer = createWechatRenderer({ logger: stubLogger() })
    const sink = createWechatEventSink({
      api, renderer, toUserId: 'uA', contextToken: 'ctx', logger: stubLogger(),
    })
    await sink.onEvent({ type: 'assistant-message', text: 'hi' } as AgentExecutionEvent)
    // 等微任务清空
    await new Promise((r) => setTimeout(r, 10))
    expect(api.sendText).toHaveBeenCalledWith('uA', '开始处理...', 'ctx')
  })

  it('finalize 串行发所有 segment；段间 500ms sleep', async () => {
    const api = stubApi()
    const renderer = createWechatRenderer({ logger: stubLogger() })
    // 灌入：1 个工具 + 1 段 assistant text → flush() 返回 2 个 segment
    renderer.onEvent({
      type: 'activity-state',
      state: { status: 's', activities: [], newToolCalls: ['bash'] },
    } as AgentExecutionEvent)
    renderer.onEvent({ type: 'assistant-message', text: '完成' } as AgentExecutionEvent)
    renderer.onEvent({ type: 'lifecycle', phase: 'completed', finalMessages: [] } as AgentExecutionEvent)

    const sink = createWechatEventSink({
      api, renderer, toUserId: 'uA', contextToken: 'ctx', logger: stubLogger(),
    })
    const t0 = Date.now()
    await sink.finalize()
    const elapsed = Date.now() - t0

    // 起始消息消除：finalize 不发起始消息
    // sendText 被调用：2 个 segment（不含起始消息）
    expect(api.sendText.mock.calls.length).toBe(2)
    expect(api.sendText.mock.calls[0]).toEqual(['uA', '🔧 使用了工具: bash', 'ctx'])
    expect(api.sendText.mock.calls[1]).toEqual(['uA', '完成', 'ctx'])
    // 段间 sleep ~500ms（允许时序抖动）
    expect(elapsed).toBeGreaterThanOrEqual(450)
    expect(elapsed).toBeLessThan(2_000)
  })

  it('段内发送失败 → log + 尝试发"[消息发送失败]"（不抛、不停发后续段）', async () => {
    const api = {
      sendText: vi.fn()
        .mockRejectedValueOnce(new Error('limit'))            // 第 1 段失败
        .mockResolvedValueOnce(undefined)                      // [消息发送失败] 提示成功
        .mockResolvedValueOnce(undefined)                      // 第 2 段成功
    } as never
    const renderer = createWechatRenderer({ logger: stubLogger() })
    renderer.onEvent({ type: 'assistant-message', text: 'A'.repeat(5000) } as AgentExecutionEvent)
    renderer.onEvent({ type: 'lifecycle', phase: 'completed', finalMessages: [] } as AgentExecutionEvent)

    const sink = createWechatEventSink({
      api, renderer, toUserId: 'uA', contextToken: 'ctx', logger: stubLogger(),
    })
    await sink.finalize()
    // 至少 3 次调用：失败段 + 失败提示 + 后续段
    expect(api.sendText.mock.calls.length).toBeGreaterThanOrEqual(3)
  })

  it('terminalPhase 在 lifecycle 终态后可读', async () => {
    const renderer = createWechatRenderer({ logger: stubLogger() })
    const sink = createWechatEventSink({
      api: stubApi(), renderer, toUserId: 'uA', contextToken: 'ctx', logger: stubLogger(),
    })
    expect(sink.terminalPhase).toBeUndefined()
    await sink.onEvent({ type: 'lifecycle', phase: 'completed', finalMessages: [] } as AgentExecutionEvent)
    expect(sink.terminalPhase).toBe('completed')
  })
})
```

- [ ] **Step 3.2.3: 跑测试**

Run: `pnpm vitest run src/im/wechat/WechatEventSink.test.ts`
Expected: 全绿

- [ ] **Step 3.2.4: 提交 Task 3.1 + 3.2**

```bash
git add src/im/wechat/WechatRenderer.ts src/im/wechat/WechatRenderer.test.ts \
        src/im/wechat/WechatEventSink.ts src/im/wechat/WechatEventSink.test.ts
git commit -m "$(cat <<'EOF'
feat(wechat): WechatRenderer + WechatEventSink

- Renderer: 累积 AgentExecutionEvent → string[] 文本段
  - 工具调用按字典序去重，作为首段 "🔧 使用了工具: ..."
  - assistant text 拼接后按 \n\n / \n / 硬切 三级分段（4000 字符上限）
  - failed 终态追加 "⚠️ 处理失败：<错误>"
  - 无输出时占位文本避免静默
- EventSink: 首个 event 立即发"开始处理..."（不阻塞）；
  finalize 串行发所有 segment 段间 500ms sleep；
  段内失败仅记日志不重试（防风控），尝试发"[消息发送失败]"提示

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3.3: `WechatAdapter` QR 登录子流程 + 测试

**Files:**
- Create: `src/im/wechat/WechatAdapter.ts`（仅扫码登录部分）
- Create: `src/im/wechat/WechatAdapter.test.ts`（仅扫码登录用例）

按 spec §7.1。本 task 仅落地"扫码登录"子流程；long-poll loop 在 Task 3.4 加。先把 adapter 文件骨架 + login 流程能独立测了再说。

- [ ] **Step 3.3.1: 创建 `src/im/wechat/WechatAdapter.ts` 骨架**

```ts
import type { IMAdapter } from '@/im/IMAdapter.ts'
import type { Logger } from '@/logger/logger.ts'
import type { WechatApi, WechatCredentials } from './WechatApi.ts'
import type { CredentialsStore } from './CredentialsStore.ts'
import qrcodeTerminal from 'qrcode-terminal'

export interface WechatAdapterDeps {
  api: WechatApi
  credentialsStore: CredentialsStore
  credentialsFile: string
  logger: Logger
  // orchestrator / runQueue / sessionStore / abortRegistry / renderer 等
  // 在 Task 3.4 接入
}

const QR_LOGIN_TIMEOUT_MS = 480_000
const QR_POLL_INTERVAL_MS = 1_000
const QR_MAX_REFRESHES = 10

export function createWechatAdapter(deps: WechatAdapterDeps): IMAdapter {
  const log = deps.logger.withTag('wechat')
  let stopRequested = false
  // long-poll signal (Task 3.4 用)
  // const stopCtl = new AbortController()

  return {
    id: 'wechat',

    async start() {
      let creds = await deps.credentialsStore.load(deps.credentialsFile)
      if (!creds) {
        log.info('未找到凭证，开始扫码登录...')
        creds = await qrLogin(deps, () => stopRequested)
        if (!creds) {
          throw new Error('扫码登录被中止或失败')
        }
        await deps.credentialsStore.save(deps.credentialsFile, creds)
        log.info(`扫码登录成功，凭证已写入 ${deps.credentialsFile}`)
      }
      deps.api.setToken(creds.token)
      log.info(`Wechat adapter 已就绪 botId=${creds.botId}`)
      // long-poll loop 在 Task 3.4 接入
    },

    async stop() {
      stopRequested = true
      // stopCtl.abort()  Task 3.4
    },
  }
}

/**
 * 扫码登录主循环。返回拿到的 credentials 或 undefined（被 stop 中止 / 超时）。
 */
export async function qrLogin(
  deps: WechatAdapterDeps,
  isStopped: () => boolean,
): Promise<WechatCredentials | undefined> {
  const log = deps.logger.withTag('wechat:qr')
  const deadline = Date.now() + QR_LOGIN_TIMEOUT_MS
  let refreshCount = 0
  let qr = await deps.api.fetchQrCode()
  printQrToTerminal(qr.qrcode_img_content)
  log.info(`扫码 URL: ${qr.qrcode_img_content}`)

  while (!isStopped()) {
    if (Date.now() >= deadline) {
      log.warn(`扫码登录超时 ${QR_LOGIN_TIMEOUT_MS}ms`)
      return undefined
    }
    const status = await deps.api.pollQrStatus(qr.qrcode)
    if (status.status === 'wait') {
      // 继续轮询
    } else if (status.status === 'scaned') {
      log.info('已扫码，请在手机上确认...')
    } else if (status.status === 'expired') {
      refreshCount++
      if (refreshCount >= QR_MAX_REFRESHES) {
        log.warn(`二维码刷新 ${QR_MAX_REFRESHES} 次仍未扫码，放弃`)
        return undefined
      }
      log.info(`二维码已过期，刷新（${refreshCount}/${QR_MAX_REFRESHES}）`)
      qr = await deps.api.fetchQrCode()
      printQrToTerminal(qr.qrcode_img_content)
    } else if (status.status === 'confirmed') {
      if (!status.bot_token || !status.ilink_bot_id) {
        log.error('扫码 confirmed 但服务端未返回 token/bot_id')
        return undefined
      }
      log.info(`扫码登录成功 bot_id=${status.ilink_bot_id}`)
      return {
        token: status.bot_token,
        baseUrl: status.baseurl ?? deps.api.baseUrl,
        botId: status.ilink_bot_id,
        userId: status.ilink_user_id ?? '',
      }
    }

    await sleep(QR_POLL_INTERVAL_MS)
  }

  log.info('扫码登录被 stop 中止')
  return undefined
}

function printQrToTerminal(qrUrl: string): void {
  console.log('\n' + '='.repeat(60))
  console.log('  请使用微信扫描二维码登录（约 8 分钟内有效）')
  console.log('='.repeat(60))
  qrcodeTerminal.generate(qrUrl, { small: true }, (qr) => {
    try { console.log(qr) } catch { /* 终端不支持 unicode 时静默 */ }
  })
  console.log(`  二维码 URL: ${qrUrl}\n`)
}

function sleep(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms))
}
```

- [ ] **Step 3.3.2: 创建 `src/im/wechat/WechatAdapter.test.ts`**

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createCredentialsStore } from './CredentialsStore.ts'
import { qrLogin, createWechatAdapter } from './WechatAdapter.ts'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const stubLogger = () => {
  const make = (): { debug: () => void; info: () => void; warn: () => void; error: () => void; withTag: () => unknown } => ({
    debug: () => {}, info: () => {}, warn: () => {}, error: () => {},
    withTag: () => make(),
  })
  return make() as never
}

describe('qrLogin', () => {
  it('confirmed 状态返回完整凭证', async () => {
    const api = {
      baseUrl: 'https://ilink.example/',
      cdnBaseUrl: '',
      fetchQrCode: vi.fn().mockResolvedValue({ qrcode: 'qr1', qrcode_img_content: 'https://qr/1' }),
      pollQrStatus: vi.fn().mockResolvedValue({
        status: 'confirmed',
        bot_token: 'tok',
        ilink_bot_id: 'b1',
        ilink_user_id: 'u1',
        baseurl: 'https://ilink.cn/',
      }),
      setToken: vi.fn(),
    } as never
    const creds = await qrLogin(
      { api, credentialsStore: createCredentialsStore(), credentialsFile: '/tmp/x', logger: stubLogger() },
      () => false,
    )
    expect(creds).toEqual({
      token: 'tok',
      baseUrl: 'https://ilink.cn/',
      botId: 'b1',
      userId: 'u1',
    })
  })

  it('expired 自动刷新；超过 10 次放弃', async () => {
    const api = {
      baseUrl: '', cdnBaseUrl: '',
      fetchQrCode: vi.fn().mockResolvedValue({ qrcode: 'qr', qrcode_img_content: '' }),
      pollQrStatus: vi.fn().mockResolvedValue({ status: 'expired' }),
      setToken: vi.fn(),
    } as never
    const creds = await qrLogin(
      { api, credentialsStore: createCredentialsStore(), credentialsFile: '/tmp/x', logger: stubLogger() },
      () => false,
    )
    expect(creds).toBeUndefined()
    // 1 次初始 + 10 次刷新 = 11 次（最后一次刷新被拒后 return undefined）
    expect(api.fetchQrCode.mock.calls.length).toBe(11)
  })

  it('isStopped() 返回 true 时立即退出', async () => {
    let stopped = false
    const api = {
      baseUrl: '', cdnBaseUrl: '',
      fetchQrCode: vi.fn().mockResolvedValue({ qrcode: 'qr', qrcode_img_content: '' }),
      pollQrStatus: vi.fn().mockImplementation(async () => {
        stopped = true
        return { status: 'wait' }
      }),
      setToken: vi.fn(),
    } as never
    const creds = await qrLogin(
      { api, credentialsStore: createCredentialsStore(), credentialsFile: '/tmp/x', logger: stubLogger() },
      () => stopped,
    )
    expect(creds).toBeUndefined()
  })

  it('confirmed 但缺 token / bot_id → 返回 undefined', async () => {
    const api = {
      baseUrl: '', cdnBaseUrl: '',
      fetchQrCode: vi.fn().mockResolvedValue({ qrcode: 'qr', qrcode_img_content: '' }),
      pollQrStatus: vi.fn().mockResolvedValue({ status: 'confirmed' }),  // 缺 token / bot_id
      setToken: vi.fn(),
    } as never
    const creds = await qrLogin(
      { api, credentialsStore: createCredentialsStore(), credentialsFile: '/tmp/x', logger: stubLogger() },
      () => false,
    )
    expect(creds).toBeUndefined()
  })
})

describe('createWechatAdapter.start', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'wechat-adapter-'))
  })

  it('凭证存在 → 跳过扫码，直接 setToken', async () => {
    const credsFile = path.join(dir, 'credentials.json')
    const store = createCredentialsStore()
    await store.save(credsFile, { token: 'tok-saved', baseUrl: '', botId: '', userId: '' })

    const api = {
      baseUrl: '',
      cdnBaseUrl: '',
      setToken: vi.fn(),
      fetchQrCode: vi.fn(),  // 不应被调
    } as never
    const adapter = createWechatAdapter({
      api, credentialsStore: store, credentialsFile: credsFile, logger: stubLogger(),
    })
    await adapter.start()
    expect(api.setToken).toHaveBeenCalledWith('tok-saved')
    expect(api.fetchQrCode).not.toHaveBeenCalled()
  })

  it('凭证不存在 → 走扫码登录；登录失败抛错', async () => {
    const credsFile = path.join(dir, 'credentials.json')
    const api = {
      baseUrl: '',
      cdnBaseUrl: '',
      fetchQrCode: vi.fn().mockResolvedValue({ qrcode: 'qr', qrcode_img_content: '' }),
      pollQrStatus: vi.fn().mockResolvedValue({ status: 'expired' }),  // 立即 expired，触发刷新循环
      setToken: vi.fn(),
    } as never
    const adapter = createWechatAdapter({
      api,
      credentialsStore: createCredentialsStore(),
      credentialsFile: credsFile,
      logger: stubLogger(),
    })
    // expired 模式刷新 10 次后放弃
    await expect(adapter.start()).rejects.toThrow(/扫码登录/)
  })

  it('start() 期间调 stop() → qrLogin 提前退出，start reject', async () => {
    const credsFile = path.join(dir, 'nope.json')
    const api = {
      baseUrl: '',
      cdnBaseUrl: '',
      fetchQrCode: vi.fn().mockResolvedValue({ qrcode: 'qr', qrcode_img_content: '' }),
      pollQrStatus: vi.fn().mockResolvedValue({ status: 'wait' }),  // 一直 wait
      setToken: vi.fn(),
    } as never
    const adapter = createWechatAdapter({
      api,
      credentialsStore: createCredentialsStore(),
      credentialsFile: credsFile,
      logger: stubLogger(),
    })
    const startPromise = adapter.start()
    // 让一次 pollQrStatus 进行后再 stop
    await new Promise((r) => setTimeout(r, 1100))  // 等一个 poll 周期
    await adapter.stop()
    await expect(startPromise).rejects.toThrow(/扫码登录/)
  })
})
```

- [ ] **Step 3.3.3: 跑测试**

Run: `pnpm vitest run src/im/wechat/WechatAdapter.test.ts`
Expected: 全绿（最后一个 stop case 会等 1.1s，OK）

---

### Task 3.4: WechatAdapter long-poll loop + processMessage + 测试

**Files:**
- Modify: `src/im/wechat/WechatAdapter.ts`
- Modify: `src/im/wechat/WechatAdapter.test.ts`

按 spec §7.2 / §7.3。本 task 给 adapter 加 long-poll loop 与 processMessage。需要拿到 orchestrator / sessionStore / runQueue / abortRegistry / renderer 才能完整接入。

- [ ] **Step 3.4.1: 扩展 `WechatAdapterDeps`**

```ts
import type {
  ConversationOrchestrator,
} from '@/orchestrator/ConversationOrchestrator.ts'
import type { SessionStore } from '@/store/SessionStore.ts'
import type { SessionRunQueue } from '@/orchestrator/SessionRunQueue.ts'
import type { AbortRegistry } from '@/orchestrator/AbortRegistry.ts'
import type { WechatRenderer } from './WechatRenderer.ts'
import type { InboundMessage } from '@/im/types.ts'
import { createWechatEventSink } from './WechatEventSink.ts'
import {
  ERRCODE_SESSION_EXPIRED,
  WeixinItemType,
  WeixinMessageType,
  type InboundWeixinMessage,
} from './protocol.ts'

export interface WechatAdapterDeps {
  api: WechatApi
  credentialsStore: CredentialsStore
  credentialsFile: string
  orchestrator: ConversationOrchestrator
  sessionStore: SessionStore
  runQueue: SessionRunQueue
  abortRegistry: AbortRegistry<string>
  renderer: WechatRenderer
  logger: Logger
}
```

- [ ] **Step 3.4.2: long-poll loop 实现**

把 `start()` 改成（在原有扫码 + setToken 之后）启动 long-poll 异步循环：

```ts
async start() {
  // ...原有扫码 + setToken 逻辑...
  const stopCtl = new AbortController()
  // 把 stopCtl 存到闭包外层（用 closure 引用）
  ;(deps as unknown as { _stopCtl?: AbortController })._stopCtl = stopCtl

  // 启动 long-poll loop（不 await，让 start() 返回）
  void runLongPollLoop(deps, stopCtl.signal)
},

async stop() {
  stopRequested = true
  const stopCtl = (deps as unknown as { _stopCtl?: AbortController })._stopCtl
  if (stopCtl) stopCtl.abort()
},
```

注：闭包变量比 deps 黑魔法清晰。把 `let stopCtl: AbortController | undefined` 提到 `createWechatAdapter` 函数顶层。

更干净的写法：

```ts
export function createWechatAdapter(deps: WechatAdapterDeps): IMAdapter {
  const log = deps.logger.withTag('wechat')
  let stopRequested = false
  let stopCtl: AbortController | undefined

  return {
    id: 'wechat',
    async start() {
      // ...扫码 + setToken...
      stopCtl = new AbortController()
      void runLongPollLoop(deps, stopCtl.signal, () => stopRequested)
    },
    async stop() {
      stopRequested = true
      stopCtl?.abort()
    },
  }
}
```

- [ ] **Step 3.4.3: 实现 `runLongPollLoop`**

文件末尾加：

```ts
const RETRY_DELAY_MS = 2_000
const BACKOFF_DELAY_MS = 30_000
const MAX_CONSECUTIVE_FAILURES = 3
const DEDUP_TTL_MS = 7 * 60 * 60 * 1_000  // 7 小时

/** 可被 abort signal 提前唤醒的 sleep；abort 时 resolve（不 throw） */
function interruptibleSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve()
    const t = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    function onAbort() {
      clearTimeout(t)
      resolve()
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

async function runLongPollLoop(
  deps: WechatAdapterDeps,
  signal: AbortSignal,
  isStopped: () => boolean,
): Promise<void> {
  const log = deps.logger.withTag('wechat:poll')
  let buf = ''
  let consecutiveFailures = 0
  // 入站消息去重：msgId → expireAt
  const dedup = new Map<string, number>()
  // context_token 缓存：userId → contextToken
  const contextTokens = new Map<string, string>()

  while (!signal.aborted && !isStopped()) {
    try {
      const resp = await deps.api.getUpdates(buf, signal)
      if (signal.aborted || isStopped()) break

      if (resp.errcode === ERRCODE_SESSION_EXPIRED) {
        log.warn('session 过期 (errcode -14)，触发 relogin...')
        await deps.credentialsStore.clear(deps.credentialsFile)
        const newCreds = await qrLogin(deps, isStopped)
        if (!newCreds) {
          log.error('relogin 失败，5 分钟后重试（可被 stop signal 提前唤醒）')
          await interruptibleSleep(300_000, signal)
          continue
        }
        await deps.credentialsStore.save(deps.credentialsFile, newCreds)
        deps.api.setToken(newCreds.token)
        buf = ''
        consecutiveFailures = 0
        continue
      }

      const isError = (resp.ret ?? 0) !== 0 || (resp.errcode ?? 0) !== 0
      if (isError) {
        consecutiveFailures++
        log.error('getUpdates 错误', {
          ret: resp.ret, errcode: resp.errcode, errmsg: resp.errmsg,
          consecutiveFailures, max: MAX_CONSECUTIVE_FAILURES,
        })
        await interruptibleSleep(
          consecutiveFailures >= MAX_CONSECUTIVE_FAILURES ? BACKOFF_DELAY_MS : RETRY_DELAY_MS,
          signal,
        )
        continue
      }

      consecutiveFailures = 0
      if (resp.get_updates_buf) buf = resp.get_updates_buf

      // 清理过期 dedup
      const now = Date.now()
      for (const [mid, expireAt] of dedup) {
        if (expireAt < now) dedup.delete(mid)
      }

      for (const raw of resp.msgs ?? []) {
        try {
          await processMessage(deps, raw, dedup, contextTokens)
        } catch (err) {
          log.error('processMessage 异常', { err })
        }
      }
    } catch (err) {
      if (signal.aborted || isStopped()) break
      consecutiveFailures++
      log.error('getUpdates 异常', { err, consecutiveFailures })
      await interruptibleSleep(
        consecutiveFailures >= MAX_CONSECUTIVE_FAILURES ? BACKOFF_DELAY_MS : RETRY_DELAY_MS,
        signal,
      )
    }
  }
  log.info('long-poll loop 退出')
}

async function processMessage(
  deps: WechatAdapterDeps,
  raw: InboundWeixinMessage,
  dedup: Map<string, number>,
  contextTokens: Map<string, string>,
): Promise<void> {
  const log = deps.logger.withTag('wechat:msg')
  if (raw.message_type !== WeixinMessageType.USER) return  // 仅处理用户消息

  const msgId = String(raw.message_id ?? raw.seq ?? '')
  if (!msgId) return
  if (dedup.has(msgId)) return
  dedup.set(msgId, Date.now() + DEDUP_TTL_MS)

  const fromUserId = raw.from_user_id
  // 1. 先更新 contextToken 缓存（spec §7.3 顺序保证：媒体提示也能拿到 token）
  if (raw.context_token) contextTokens.set(fromUserId, raw.context_token)
  const contextToken = contextTokens.get(fromUserId) ?? ''

  // 2. 解析 item_list
  let textBody = ''
  let hasMedia = false
  for (const item of raw.item_list ?? []) {
    if (item.type === WeixinItemType.TEXT) {
      const ti = (item as { text_item?: { text?: string } }).text_item
      if (ti?.text) textBody += (textBody ? '\n' : '') + ti.text
    } else {
      hasMedia = true
    }
  }

  // 3. 媒体消息提示（MVP 不支持）
  if (hasMedia) {
    log.info('收到媒体消息（MVP 阶段不支持，已忽略）', { fromUserId })
    try {
      await deps.api.sendText(
        fromUserId,
        '目前暂不支持图片/语音/文件/视频，请发送文字消息',
        contextToken,
      )
    } catch (err) {
      log.warn('媒体不支持提示发送失败', { err })
    }
    if (!textBody) return  // 纯媒体消息丢弃
    // 文本+媒体混合：文本继续走 orchestrator
  }

  if (!textBody) return  // 没文本不进 orchestrator

  // 4. 构造 InboundMessage 并送入 orchestrator
  const inbound: InboundMessage = {
    imProvider: 'wechat',
    channelId: fromUserId,
    channelName: fromUserId,
    threadTs: fromUserId,
    messageTs: msgId,
    userId: fromUserId,
    userName: fromUserId,
    text: textBody,
    confirmSender: undefined,  // wechat 不注入 confirm tool
  }

  const sink = createWechatEventSink({
    api: deps.api,
    renderer: deps.renderer,
    toUserId: fromUserId,
    contextToken,
    logger: deps.logger,
  })

  // fire-and-forget：单条消息处理失败不阻塞下一条入站
  void deps.orchestrator
    .handle(inbound, sink)
    .catch((err) => log.error('orchestrator.handle 失败', { err }))
}

function sleep(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms))
}
```

- [ ] **Step 3.4.4: 加测试用例（processMessage 行为）**

**先动 `WechatAdapter.ts`**：在文件末尾加 `export { processMessage }`（同文件内 `function processMessage(...)` 声明被 export，TS 合法）。

**再改 `WechatAdapter.test.ts`**：在文件**顶部已有的 import 块**追加（不是末尾，ES import 必须在文件顶部）：

```ts
import { processMessage as _processMessage } from './WechatAdapter.ts'

describe('processMessage', () => {
  const stubOrchestrator = () => ({ handle: vi.fn().mockResolvedValue(undefined) })
  const stubApi = () => ({
    baseUrl: '', cdnBaseUrl: '', setToken: vi.fn(),
    sendText: vi.fn().mockResolvedValue(undefined),
    fetchQrCode: vi.fn(), pollQrStatus: vi.fn(), getUpdates: vi.fn(), getConfig: vi.fn(),
  })

  const baseDeps = (api = stubApi(), orch = stubOrchestrator()): WechatAdapterDeps => ({
    api: api as never,
    credentialsStore: createCredentialsStore(),
    credentialsFile: '/tmp/x',
    orchestrator: orch as never,
    sessionStore: {} as never,
    runQueue: {} as never,
    abortRegistry: {} as never,
    renderer: { onEvent: () => {}, flush: () => [], STARTING_MESSAGE: '...' },
    logger: stubLogger(),
  })

  it('文本消息 → 调 orchestrator.handle，sendText 不被调（除非 sink finalize）', async () => {
    const api = stubApi()
    const orch = stubOrchestrator()
    const deps = baseDeps(api, orch)
    await _processMessage(
      deps,
      {
        message_type: 1, message_id: 'm1', from_user_id: 'uA', to_user_id: 'bot',
        context_token: 'ctx', item_list: [{ type: 1, text_item: { text: 'hi' } }],
      } as never,
      new Map(), new Map(),
    )
    // orchestrator.handle 是 fire-and-forget，至少调一次
    await new Promise((r) => setTimeout(r, 10))
    expect(orch.handle).toHaveBeenCalledOnce()
    const inbound = orch.handle.mock.calls[0][0]
    expect(inbound.imProvider).toBe('wechat')
    expect(inbound.text).toBe('hi')
    expect(inbound.confirmSender).toBeUndefined()
  })

  it('media 消息 → 不调 orchestrator，立即 sendText 提示', async () => {
    const api = stubApi()
    const orch = stubOrchestrator()
    const deps = baseDeps(api, orch)
    await _processMessage(
      deps,
      {
        message_type: 1, message_id: 'm2', from_user_id: 'uA', to_user_id: 'bot',
        context_token: 'ctx',
        item_list: [{ type: 2, image_item: { /* MVP 不解析 */ } }],
      } as never,
      new Map(), new Map(),
    )
    expect(api.sendText).toHaveBeenCalledOnce()
    expect(api.sendText.mock.calls[0][1]).toMatch(/暂不支持/)
    expect(orch.handle).not.toHaveBeenCalled()
  })

  it('文本+媒体混合 → 提示 + 文本进 orchestrator', async () => {
    const api = stubApi()
    const orch = stubOrchestrator()
    const deps = baseDeps(api, orch)
    await _processMessage(
      deps,
      {
        message_type: 1, message_id: 'm3', from_user_id: 'uA', to_user_id: 'bot',
        context_token: 'ctx',
        item_list: [
          { type: 1, text_item: { text: 'check this' } },
          { type: 2, image_item: {} },
        ],
      } as never,
      new Map(), new Map(),
    )
    await new Promise((r) => setTimeout(r, 10))
    expect(api.sendText).toHaveBeenCalledOnce()
    expect(orch.handle).toHaveBeenCalledOnce()
  })

  it('重复 msgId 被去重', async () => {
    const api = stubApi()
    const orch = stubOrchestrator()
    const deps = baseDeps(api, orch)
    const dedup = new Map<string, number>()
    const ctxs = new Map<string, string>()
    await _processMessage(deps, {
      message_type: 1, message_id: 'm4', from_user_id: 'uA', to_user_id: 'b',
      context_token: 'ctx', item_list: [{ type: 1, text_item: { text: 'hi' } }],
    } as never, dedup, ctxs)
    await _processMessage(deps, {
      message_type: 1, message_id: 'm4', from_user_id: 'uA', to_user_id: 'b',
      context_token: 'ctx', item_list: [{ type: 1, text_item: { text: 'hi' } }],
    } as never, dedup, ctxs)
    await new Promise((r) => setTimeout(r, 10))
    expect(orch.handle.mock.calls.length).toBe(1)
  })

  it('contextToken 在解析前更新（媒体消息也能拿到 token 发提示）', async () => {
    const api = stubApi()
    const deps = baseDeps(api)
    const ctxs = new Map<string, string>()
    await _processMessage(deps, {
      message_type: 1, message_id: 'm5', from_user_id: 'uB', to_user_id: 'b',
      context_token: 'fresh-token',
      item_list: [{ type: 2 }],  // 纯媒体
    } as never, new Map(), ctxs)
    expect(ctxs.get('uB')).toBe('fresh-token')
    expect(api.sendText.mock.calls[0][2]).toBe('fresh-token')  // 第三参数 contextToken
  })

  it('message_type !== 1（非用户消息）跳过', async () => {
    const api = stubApi()
    const orch = stubOrchestrator()
    const deps = baseDeps(api, orch)
    await _processMessage(deps, {
      message_type: 2, message_id: 'mX', from_user_id: 'b', to_user_id: 'uA',
      context_token: '', item_list: [],
    } as never, new Map(), new Map())
    expect(orch.handle).not.toHaveBeenCalled()
    expect(api.sendText).not.toHaveBeenCalled()
  })
})
```

记得在 `WechatAdapter.ts` 末尾加 `export { processMessage }`，否则测试 import 会失败。

- [ ] **Step 3.4.5: 跑测试**

Run: `pnpm vitest run src/im/wechat/WechatAdapter.test.ts`
Expected: 全绿

- [ ] **Step 3.4.6: 提交 Task 3.3 + 3.4**

```bash
git add src/im/wechat/WechatAdapter.ts src/im/wechat/WechatAdapter.test.ts
git commit -m "$(cat <<'EOF'
feat(wechat): WechatAdapter 完整实现（扫码登录 + long-poll + processMessage）

- 扫码登录子流程 qrLogin：480s 超时，10 次 expired 刷新
- long-poll loop runLongPollLoop：errcode -14 自动 relogin；
  连续失败 3 次后退避 30s；stop signal 触发立即退出
- processMessage：去重 (msgId, TTL 7h) + contextToken 缓存；
  解析顺序保证媒体消息也能拿到 token 发提示；
  文本进 orchestrator (fire-and-forget)；构造 InboundMessage
  时 confirmSender=undefined (wechat 不注入 confirm tool)
- terminal QR 用 qrcode-terminal 输出 ASCII + URL

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3.5: `createApplication` 实装 wechat adapter 装配

**Files:**
- Modify: `src/application/createApplication.ts`
- Modify: `src/application/createApplication.test.ts`

把 Chunk 1 留的 TODO 占位替换为真实 `createWechatAdapter` 调用。

- [ ] **Step 3.5.1: 改 `src/application/createApplication.ts`**

import 区追加：

```ts
import { WechatApi } from '@/im/wechat/WechatApi.ts'
import { createCredentialsStore } from '@/im/wechat/CredentialsStore.ts'
import { createWechatRenderer } from '@/im/wechat/WechatRenderer.ts'
import { createWechatAdapter } from '@/im/wechat/WechatAdapter.ts'
```

把 Chunk 1 的 TODO block：

```ts
if (enabled.includes('wechat')) {
  // TODO(Chunk 3): 装配 WechatAdapter
  logger.warn('im.enabled 含 wechat，但 WechatAdapter 尚未实现（计划在 Chunk 3 落地）')
}
```

替换为：

```ts
if (enabled.includes('wechat')) {
  const wechatApi = new WechatApi({
    baseUrl: ctx.config.im.wechat.baseUrl,
    cdnBaseUrl: ctx.config.im.wechat.cdnBaseUrl,
  })
  const wechatRenderer = createWechatRenderer({ logger })
  const wechat = createWechatAdapter({
    api: wechatApi,
    credentialsStore: createCredentialsStore(),
    credentialsFile: ctx.paths.wechatCredentialsFile,
    orchestrator,
    sessionStore,
    runQueue,
    abortRegistry,
    renderer: wechatRenderer,
    logger,
  })
  adapters.push(wechat)
}
```

- [ ] **Step 3.5.2: 改 `src/application/createApplication.test.ts`**

把 Chunk 1 加的 wechat 用例改成真实装配：

```ts
it('仅 wechat：adapter 真实装配，id="wechat"，但 start() 未被自动调用', async () => {
  // 工作区 yaml 写 im.enabled: ['wechat']
  // env 不设 SLACK_*
  const app = await createApplicationWithWorkspace({ enabled: ['wechat'] })  // helper 按现有模式
  expect(app.adapters.length).toBe(1)
  expect(app.adapters[0].id).toBe('wechat')
  // 注：测试不调 start()，避免触发扫码登录（无法在 CI 中完成）
})

it('双开 [slack, wechat]：两个 adapter 都装配', async () => {
  // 工作区 im.enabled: ['slack', 'wechat']，完整 SLACK env
  const app = await createApplicationWithWorkspace({ enabled: ['slack', 'wechat'] })
  expect(app.adapters.length).toBe(2)
  expect(app.adapters.map((a) => a.id).sort()).toEqual(['slack', 'wechat'])
})
```

helper `createApplicationWithWorkspace` 按现有 createApplication.test.ts 模式（mock 工作区 + env）写。

- [ ] **Step 3.5.3: 跑测试**

Run: `pnpm vitest run src/application/createApplication.test.ts`
Expected: 全绿

- [ ] **Step 3.5.4: 跑全套**

Run: `pnpm vitest run`
Expected: 全绿

- [ ] **Step 3.5.5: 类型检查**

Run: `pnpm tsc -b`
Expected: 零错

- [ ] **Step 3.5.6: 提交**

```bash
git add src/application/createApplication.ts src/application/createApplication.test.ts
git commit -m "$(cat <<'EOF'
feat(app): createApplication 装配 WechatAdapter

- enabled 含 wechat 时构造 WechatApi / CredentialsStore /
  WechatRenderer / WechatAdapter 并 push 进 adapters 数组
- 删除 Chunk 1 留的 TODO warn
- 测试覆盖：仅 wechat / 双开 两个装配 case（不触发 start，避免
  扫码阻塞测试）

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3.6: Chunk 3 终验 + 手动验证

- [ ] **Step 3.6.1: 全套测试**

Run: `pnpm vitest run`
Expected: 全绿

- [ ] **Step 3.6.2: 类型检查**

Run: `pnpm tsc -b`
Expected: 零错

- [ ] **Step 3.6.3: lint（如有）**

Run: `pnpm eslint . || echo 'no eslint configured'`
Expected: 零错

- [ ] **Step 3.6.4: 手动验证 #1（仅 wechat 文本 round-trip）**

操作步骤（**遇到扫码环节 stop，等用户扫完再继续**）：
1. 新建空工作区 `mkdir /tmp/wechat-mvp-ws && cd /tmp/wechat-mvp-ws`
2. 写最小 `.agent-slack/config.yaml`：
   ```yaml
   agent:
     provider: anthropic   # 或你环境的 provider
     model: claude-sonnet-4-5
   im:
     enabled: [wechat]
   ```
3. 配 LLM env（按 provider）
4. 启动 `pnpm dev`（或 daemon）
5. 终端打印二维码 + URL → **暂停，让用户扫码确认**
6. 凭证写入 `.agent-slack/wechat/credentials.json`，long-poll 启动
7. 在微信里给 bot 发 "hi"
8. 观察：bot 先回 "开始处理..."，再回 agent 实际回复
9. 检查 `.agent-slack/sessions/wechat/` 下生成的 session 目录
10. 期望：bot 回复送达，无 panic / unhandled rejection

- [ ] **Step 3.6.5: 手动验证 #2（重启复用凭证）**

1. SIGTERM 上一步的进程
2. 再次启动
3. 期望：终端**不再打印二维码**，直接进入 long-poll
4. 给 bot 发文本验证仍能回复

- [ ] **Step 3.6.6: 手动验证 #5（媒体消息忽略）**

给 bot 发图片 / 语音 / 文件 / 视频
期望：bot 回 "目前暂不支持图片/语音/文件/视频，请发送文字消息"，agent 未被触发（看日志确认）

- [ ] **Step 3.6.7: 手动验证 #6（超长文本分段，可选）**

给 bot 发"请讲一个很长的故事，至少 5000 字"，观察微信里收到的回复是否被分段（每段 4000 字符以内，段间 ~500ms）

- [ ] **Step 3.6.8: 手动验证 #4（双开，可选但推荐）**

修改工作区 yaml 为 `enabled: [slack, wechat]`，配齐 SLACK env，重启。Slack @bot 能回复；微信发文本也能回复；两个会话目录互不干扰。

- [ ] **Step 3.6.9: 提交终验记录（可选）**

如果手动验证有需要登记的偏差，记录到 spec §13 后续待办。

---

## 总结

完成 3 个 chunk 后，仓库新增能力：

1. **多 IM 同进程**：`im.enabled` 配置数组、`createApplication` 按需装配 adapters
2. **个人微信通道**：扫码登录、文本 round-trip、单聊（MVP，媒体延后）
3. **抽象层正交化**：confirm tool 按 `ctx.confirm` 条件注入；SessionStore 按 imProvider 路径分桶
4. **配置迁移**：旧 `im.provider` 自动迁移为 `im.enabled` 数组

**MVP 范围已完成**。下次切片由 spec §13 后续待办挑选启动（媒体收发、多账号、IM-aware prompt 等）。
