# Memory 模块：按用户单文件存储

**Status:** Draft（待 review）
**Range:** 补丁 M1；对 `MemoryStore` / `save_memory` / `Orchestrator` / `buildBuiltinTools` / `createApplication` 小幅改动

## 背景
M1 的 `MemoryStore` 只 `save` 不 `read`，且 `<category>-<slug>.md` 命名需要 agent 猜测；既没索引也无法让 agent 按需读。`@mention` 时 Slack 事件天然带 `userName` + `userId`（稳定唯一），可直接作为 memory 文件主键。

## 目标
- `memory/<userName>-<userId>.md`：一人一文件
- agent 凭路径按需 `bash cat` 读
- `save_memory(content)` 由 Orchestrator 注入 currentUser 绑定，agent 只传 content

## 非目标
- 不做多 category / 多 slug / 索引聚合
- 不做 SummaryAgent（合并由主 agent 自行负责：先 `bash cat` 读 → 合并 → 整体 `save_memory` 覆盖写）
- 不做向量检索、过期清理

## 文件格式
```md
---
updatedAt: 2026-04-18T07:30:00.000Z
---
[主 agent 写入的任意 markdown]
```
- filename = `<sanitize(userName)>-<userId>.md`
- sanitize 规则：`[\/\\:*?"<>|\s]` → `_`（只替 OS/路径不合法字符与空白；中文保留）

## 改动
### `MemoryStore` (`src/store/MemoryStore.ts`)
```ts
interface MemoryStore {
  pathFor(userName: string, userId: string): string            // 新
  exists(userName: string, userId: string): Promise<boolean>   // 新
  save(args: { userName; userId; content }): Promise<string>   // 签名变
}
```
- `save`：overwrite 语义，覆盖写；frontmatter 仅 `updatedAt`
- 去掉 category / slug

### `save_memory` tool (`src/agent/tools/saveMemory.ts`)
```ts
parameters: z.object({
  content: z.string().min(1),  // 仅 content
})
execute({ content }) {
  // 从 ctx.currentUser 拿 userName/userId，无则抛
}
```

### `ToolContext` (`src/agent/tools/bash.ts`)
```ts
interface ToolContext {
  cwd: string
  logger: Logger
  currentUser?: { userName: string; userId: string }  // 新；per-message 注入
}
```

### `Orchestrator` (`src/orchestrator/ConversationOrchestrator.ts`)
架构变动：**tools 改为 per-handle 动态构建**，闭包持有当前 user。

```ts
// 构造函数注入 toolsBuilder 而非成品 tools
interface ConversationOrchestratorDeps {
  toolsBuilder: (ctx: ToolContext) => ToolSet
  executor: AgentExecutor | ExecutorFactory  // 需改：每次 handle 新建 executor
  sessionStore
  systemPrompt
  logger
}
```

`handle` 入口：
```ts
const userCtx = { userName: resolveUserName(input), userId: input.userId }
const memoryPath = memoryStore.pathFor(userCtx.userName, userCtx.userId)
const hasMemory = await memoryStore.exists(...)
const promptWithMemory = hasMemory
  ? `${systemPrompt}\n\n[你关于该用户的长期记忆在 \`${relPath}\`，需要时用 bash 读]`
  : systemPrompt

const tools = toolsBuilder({ cwd, logger, currentUser: userCtx })
const executor = createExecutor(tools)  // per-handle
```

`resolveUserName` 策略：
- Slack `users.info(userId)` 取 `real_name ?? name`；缓存 per-channelNameCache 同等机制
- SlackAdapter 里已有 channelNameCache 的模式；同样加 userNameCache
- fallback: userId 本身

### `SlackAdapter` (`src/im/slack/SlackAdapter.ts`)
`InboundMessage` 加 `userName: string`；`users.info` 解析：
```ts
interface InboundMessage {
  ...
  userId: string
  userName: string    // 新
}
```

### `createApplication` (`src/application/createApplication.ts`)
- 不再在启动时 `buildBuiltinTools`；改为把 `toolsBuilder = (ctx) => buildBuiltinTools(ctx, { memoryStore })` 传给 orchestrator
- Executor 构造改为 factory：`createExecutorFactory({ model, modelName, maxSteps, logger })` 返回 `(tools) => AgentExecutor`

## 决策
- **合并语义**：agent 负责合并（读 → merge → 覆盖写），不引入 SummaryAgent
- **新用户**：文件不存在则不注入 memory 提示；agent 首次 `save_memory` 自动创建
- **sanitize**：`[\/\\:*?"<>|\s]` → `_`（保留中文与可读字符）
- **userName 来源**：优先 Slack `users.info.real_name`，回退 `name`，再回退 `userId`

## 风险
- `users.info` 额外 API 调用：加 `userNameCache: Map<userId, userName>` 与 `channelNameCache` 同级管理
- userName 变更：filename 会漂移（旧文件留在原位）。缓解：以 userId 为 filename 后缀，userName 仅做前缀可读性；若 userName 变了，保留旧文件不迁移（后续通过 agent "先读旧 → 新写入" 自然替换）
- 覆盖写丢旧信息：依赖 agent 执行 "读 → 合并 → 写" 三步。systemPrompt 的提示行需明确指示此流程

## 测试
- `MemoryStore.test.ts` 重写：pathFor / exists / save overwrite / sanitize
- `saveMemory tool test`：currentUser 注入 / 缺 currentUser 抛错
- `Orchestrator.test.ts` 扩展：
  - 有 memory 文件：systemPrompt 含路径提示
  - 无 memory 文件：systemPrompt 不含
  - tools 每次 handle 重建（验证 currentUser 正确绑定）
- 集成测试：mock `users.info` + 跑完链路 → 文件落盘 + 下轮 prompt 含路径

## 不改动
- `ai` v4 / tool schema 改小
- 依赖 / package.json
- `MEMORY_MODEL` / `SummaryAgent`：全部放弃
