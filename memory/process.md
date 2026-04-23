# Self-Improve Tool - 执行进度

对应设计：`docs/superpowers/specs/2026-04-22-self-improve-design.md`

## 实施计划

- [x] P0 通用 SlackConfirm 模块 ✅ 2026-04-23
- [x] P1 SlackAdapter 接入 `app.action(/^confirm:/)` 通用处理器 ✅ 2026-04-23
- [x] P2 规则编写常量 (`selfImprove.constants.ts`) ✅ 2026-04-23
- [x] P3 数据收集器 (`selfImprove.collector.ts`) ✅ 2026-04-23（未写测试文件，用户约束）
- [ ] P4 规则生成器 (`selfImprove.generator.ts`) + 测试
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

### P2 完成（2026-04-23）

**产出文件**：
- `src/agent/tools/selfImprove.constants.ts`：导出单一常量 `AGENTS_RULE_WRITING_GUIDE: string`
  - 中文 Markdown 原文，将在 P4 generator 调用 LLM 时作为 system prompt 的一部分注入
  - 内容覆盖设计文档 §5.2 要求的全部要素：
    - §1 好规则的标准（命中 agent 回答安装/构建/测试/目录/约定/护栏/完成前检查等问题）
    - §2 核心设计规则（最小完整操作文档 + 反例 / 正例对照）
    - §3 编写原则 P0-P6（Token 成本 / 邻近性 / 具体性 / 护栏优先 / 密度 / 训练对齐 / 可验证性）
    - §4 决策规则（具体事实 > 通用指导 / 短命令 > 解释 / 约束 > 愿望 / ≥2 证据）
    - §5 自检清单（6 条，未通过则不输出）
    - §6 输出格式约束（每条 1-3 行，Markdown 片段示例）
  - 用 `as const` 收紧类型（字面量字符串）

**设计边界**：
- 文件**只含纯文本常量**，不含任何 IO / 逻辑 / 读写 AGENTS.md。
- 不涉及调用处（generator 是 P4 范围），此 chunk 不改 `tools/index.ts`。

**未验证**：未运行 `pnpm vitest` / `pnpm lint` / `tsc`（用户要求）。

### P3 完成（2026-04-23）

**产出文件**：
- `src/agent/tools/selfImprove.collector.ts`
  - 导出接口：`CollectedData` / `SessionSummary` / `MemoryEntry` / `CollectorScope` / `SelfImproveCollector` / `SelfImproveCollectorDeps`
  - 工厂：`createSelfImproveCollector(deps: { paths, logger })` → `{ collect(scope) }`
  - session 扫描：遍历 `paths.sessionsDir/slack/<dir>/`，读 `meta.json` + `messages.jsonl`
    - scope='recent' 按 `meta.updatedAt` 过滤（7 天窗口，常量 `RECENT_WINDOW_MS`）
    - 按 updatedAt 降序返回
    - 单 session 解析失败 log.warn 跳过，不中断批量
  - `analyzeMessages`：
    - messageCount：非空行数
    - hasErrors：jsonl 原文包含 `[error:` 或 `"isError":true` 任一
    - toolUsage：遍历 role='assistant' 的 parts 里 `type: 'tool-call'` 的 toolName；role='tool' 的 parts 里 `toolName` 字段，做计数累加
    - highlights：最多 6 条/session；先放 tool 结果里的 `[error:` 错误行（截断 300 字符），再补最后 3 条 assistant 文本摘要（截断 300 字符）
  - memory 扫描：读 `paths.memoryDir/*.md`，产出 `MemoryEntry[]`
  - existingRules：读 `paths.systemFile`（`.agent-slack/system.md`），不存在则 ''
  - 所有 IO 通过 `readFileSafe` 吞错回 ''，避免单文件异常整体崩

**设计决策**：
- scope='recent' 取 `updatedAt`（最后活跃），非 createdAt
- highlights 提取策略 C：错误行（优先）+ 最后 3 条 assistant 文本摘要
- 所有 ANSI / 文本裁剪遵循 300 字符上限 + `…` 省略号（`truncate` 工具函数）
- 纯函数式工厂，无全局状态，与现有 store 风格一致
- **未**引入 `user` 消息内容提取（避免泄露用户输入到 LLM prompt；一期只让 agent 看 assistant 的回应和 tool 的错误）

**未实施**：
- 未写 `selfImprove.collector.test.ts`（用户约束"不要生成测试脚本"）。测试方案另文口头说明。
- 未改 `tools/index.ts`（collector 还没有调用处，P5 再接入）。

**补丁**：`analyzeMessages` 改为 `export function`（零行为变更），便于 P4 复用与未来单测。

**未验证**：未运行 `pnpm vitest` / `pnpm lint` / `tsc`（用户要求）。
