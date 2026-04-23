# Self-Improve Tool - 执行进度

对应设计：`docs/superpowers/specs/2026-04-22-self-improve-design.md`

## 实施计划

- [x] P0 通用 SlackConfirm 模块 ✅ 2026-04-23
- [x] P1 SlackAdapter 接入 `app.action(/^confirm:/)` 通用处理器 ✅ 2026-04-23
- [ ] P2 规则编写常量 (`selfImprove.constants.ts`)
- [ ] P3 数据收集器 (`selfImprove.collector.ts`) + 测试
- [ ] P4 规则生成器 (`selfImprove.generator.ts`) + 测试
- [ ] P5 Tool 定义 + 注册 + 端到端联调

## 进度记录

### P0 完成（2026-04-23）

**产出文件**：
- `src/im/slack/SlackConfirm.ts`：通用 Block Kit 确认交互模块
  - `ConfirmItem` / `ConfirmLabels` / `ConfirmDecision` / `ConfirmCallback` 类型定义
  - `createSlackConfirm()` 工厂函数：send 批量发送确认消息 + getCallback namespace 路由
  - `buildConfirmBlocks()` 纯函数：生成 section + context(可选) + actions blocks
  - `buildConfirmActionId()` / `parseConfirmActionId()`：action_id 生成与解析
  - `buildConfirmResultBlocks()`：用户点击后替换 blocks（移除按钮，显示结果）
  - 命名空间隔离：`confirm:<namespace>:<decision>:<itemId>` 格式，避免多业务场景 action_id 冲突
- `src/im/slack/SlackConfirm.test.ts`：16 个测试用例
  - `buildConfirmBlocks`：基础结构、context 可选、自定义 labels、默认 labels
  - `buildConfirmActionId` / `parseConfirmActionId`：生成格式、解析正确性、含冒号 itemId、非法格式
  - `buildConfirmResultBlocks`：accept/reject 两种决策的结果 blocks
  - `createSlackConfirm`：send 发送 + callback 注册、未注册 namespace、postMessage 失败容错

**验证**：`pnpm vitest run` 195 pass / `pnpm lint` 通过

### P0 补丁（2026-04-23）：修复 SlackConfirm TypeError

- `src/im/slack/SlackConfirm.ts`
  - `web.chat.postMessage` 调用：`blocks` 为 `SlackBlock[]`（`Record<string, unknown>[]`）不兼容 WebClient 签名，按 SlackRenderer 现有约定 cast 为 `Parameters<WebClient['chat']['postMessage']>[0]`
  - `parseConfirmActionId` 中 `match[1]` / `match[3]`：在 `noUncheckedIndexedAccess` 下为 `string | undefined`，但正则匹配成功即保证存在，加非空断言 `!`
- `src/im/slack/SlackConfirm.test.ts`：所有 `blocks[N].xxx` / `result[N].xxx` / `actions.elements[N].xxx` 加 `!` 断言，消除 `TS2532 Object is possibly 'undefined'`

**验证**：`pnpm vitest run src/im/slack/SlackConfirm.test.ts` 16/16 pass / `pnpm lint` 通过 / `tsc --noEmit` SlackConfirm 相关错误清零（`createApplication.test.ts` 的 3 个历史错误与本任务无关，保持原状）

### P1 完成（2026-04-23）

**产出/修改文件**：
- `src/im/slack/SlackConfirm.ts`：将内部 `SlackBlock` 类型导出，供 adapter 复用
- `src/im/slack/SlackAdapter.ts`
  - `SlackAdapterDeps` 新增必选字段 `slackConfirm: SlackConfirm`
  - 导出纯函数 `handleConfirmAction(ctx: ConfirmActionContext)`：解析 action_id → 调 `slackConfirm.getCallback` → 执行业务回调 → `client.chat.update` 替换为 `buildConfirmResultBlocks`；各环节独立 try/catch，失败只 log.warn 不抛
  - 注册 `app.action(/^confirm:/)`：`ack()` 后从 `body.channel.id` / `body.message.ts` / `body.message.blocks` 取上下文，调用 `handleConfirmAction`
- `src/application/createApplication.ts`
  - 引入 `createSlackConfirm`，在 renderer 之后创建 `slackConfirm` 实例
  - 注入给 `createSlackAdapter`；同时成为后续 self_improve tool 共享的实例（复用闭包里的 callback registry）
- `src/im/slack/SlackAdapter.test.ts`
  - `createDeps()` 补 `slackConfirm` stub（`send` / `getCallback` 均为 vi.fn）
  - `boltMock` 补 `app.action` mock 及 `actionHandlers` 列表，`beforeEach` 清空
  - 原 `@ts-expect-error renderer 必填` 用例：现在同时缺 `renderer` 与 `slackConfirm`，ts-expect-error 仍然命中，不影响

**设计要点**：
- handleConfirmAction 从 adapter 闭包拆出为独立可导出函数，接收最小上下文（actionId/channelId/messageTs/messageBlocks/client/slackConfirm/logger），便于单测无需启 bolt。
- 未在本 chunk 补 handleConfirmAction 的专用单测；按用户"不要生成测试脚本"约束跳过。

**未验证**：未运行 `pnpm vitest` / `pnpm lint` / `tsc`（用户要求不编译/不运行，改由用户 review 后自行验证）。
