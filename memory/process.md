# Self-Improve Tool - 执行进度

对应设计：`docs/superpowers/specs/2026-04-22-self-improve-design.md`

衍生设计：`docs/superpowers/specs/2026-04-23-ask-confirm-design.md`（ask_confirm 阻塞按钮确认 tool）

## 实施计划

- [x] P0 通用 SlackConfirm 模块 ✅ 2026-04-23
- [x] P1 SlackAdapter 接入 `app.action(/^confirm:/)` 通用处理器 ✅ 2026-04-23
- [x] P2 规则编写常量 (`selfImprove.constants.ts`) ✅ 2026-04-23
- [x] P3 数据收集器 (`selfImprove.collector.ts`) ✅ 2026-04-23（未写测试文件，用户约束）
- [x] P4 规则后处理器 (`selfImprove.generator.ts`) ✅ 2026-04-23（纯代码，无 LLM 调用；同步更新 design doc）
- [x] P5 双 tool 定义 + 注册 + ConfirmSender 透传 + system.md 追加 ✅ 2026-04-23（待用户端到端联调）

## ask_confirm 衍生任务（2026-04-23 开始）

- [x] design doc 落地（ask-confirm-design.md）✅ 2026-04-23
- [ ] Q0 ConfirmBridge 类
- [ ] Q1 askConfirm tool
- [ ] Q2 接入 createApplication / SlackAdapter / tools/index.ts
- [ ] Q3 端到端联调

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

### P4 完成（2026-04-23）

**设计文档更新**（架构级决策同步）：
- `docs/superpowers/specs/2026-04-22-self-improve-design.md`
  - §5.1 改为**双 tool 模式**（`self_improve_collect` + `self_improve_confirm`），替代原单一 `self_improve` tool
  - §5.4 规则生成器 → **规则后处理器**：职责改为纯代码去重/排序/过滤，**不调 LLM**
  - §6.1 `buildBuiltinTools` 注册两个 tool
  - §6.2 依赖表移除 `model: LanguageModel`；新增 `selfImproveCollector` / `selfImproveGenerator`
  - §7 文件清单：拆出 `selfImproveCollect.ts` / `selfImproveConfirm.ts`；generator 标注为"纯代码"
  - §8 交互流程改为"主 Agent 生成 JSON → confirm tool 后处理 + 发送"
  - §9.1 明确最终结论：采用双 tool 方案，tool 不调 LLM
  - §10 勾掉 #3 #4 两个未解决问题（已决）
  - §11 实施计划更新 P4/P5 描述

**产出文件**：
- `src/agent/tools/selfImprove.generator.ts`
  - 导出 `CandidateRule` / `SelfImproveGenerator`
  - 工厂 `createSelfImproveGenerator()` → `{ process(rules, existingRules) }`
  - 校验：`isValidRule` 剔除字段缺失 / content 空串的条目（使用 type guard 形态）
  - 去重：`tokenize` 归一化（lowercase、去 Markdown 标点、按非字母数字切分、过滤长度 <2 的 token）；`jaccard` 相似度阈值 `JACCARD_THRESHOLD = 0.6`
  - `splitExistingRules` 对 `.agent-slack/system.md` 原文按 Markdown 标题 / 列表项切片，得到对比用的"规则单元"集合
  - 保留顺序做组内两两查重，优先保留首条
  - 排序：confidence（high 在前）→ category 字典序，稳定
  - 完全纯函数：相同输入 → 相同输出

**边界**：
- 不调 LLM、不读写任何文件
- JACCARD_THRESHOLD / tokenize 规则为保守的一期实现；后续可替换为 embedding

**未实施**：
- 未写 `selfImprove.generator.test.ts`（用户约束"不要生成测试脚本"）。测试方案另文口头说明。
- 未接入 `tools/index.ts` / `createApplication.ts`（P5 再集成）。

**未验证**：未运行 `pnpm vitest` / `pnpm lint` / `tsc`（用户要求）。

### P5 完成（2026-04-23）

**设计文档补丁**：
- §5.5.5 / §6.2 补充 ConfirmSender 透传链：`SlackAdapter → InboundMessage.confirmSender → Orchestrator → ToolsBuilder(currentUser, imContext) → ToolContext.confirm`
- tool 层不感知 WebClient；Slack 具体实现封装在 SlackAdapter.app_mention 闭包内

**新增文件**：
- `src/agent/tools/selfImproveCollect.ts`
  - `self_improve_collect` tool：调 `collector.collect(scope)`；附带 `AGENTS_RULE_WRITING_GUIDE` + `focus` 字段返回
  - `scope: 'all' | 'recent'` 默认 recent
- `src/agent/tools/selfImproveConfirm.ts`
  - `self_improve_confirm` tool：接收 `rules: CandidateRule[]`
  - 读 `paths.systemFile` → `generator.process(rules, existingRules)` → 经 `ctx.confirm.send()` 发送
  - `onDecision` accept → `appendAcceptedRuleToSystemMd`：在 `## 由 self_improve 产生的规则` 标题下追加；不存在则创建；完全匹配文本去重
  - 规则 entry 格式：HTML 注释元数据行（id / category / confidence / ISO timestamp）+ content
  - 返回 `{ sent, skipped, reason? }`（reason ∈ `'no_confirm_channel' | 'all_filtered'`）

**架构级变更（沿 ConfirmSender 透传链）**：
- `src/im/types.ts`：新增 `ConfirmSender` / `ConfirmItem` / `ConfirmLabels` / `ConfirmCallback` / `ConfirmDecision` 共享类型；`InboundMessage` 新增 optional `confirmSender`
- `src/im/slack/SlackConfirm.ts`：上述 5 个类型改为从 `@/im/types.ts` 导入 + re-export，保持向后兼容
- `src/agent/tools/bash.ts`：`ToolContext` 新增 optional `confirm?: ConfirmSender`
- `src/orchestrator/ConversationOrchestrator.ts`：新增 `IMContext` 接口；`ToolsBuilder` 签名改为 `(currentUser, imContext) => ToolSet`；handle 里构造 `imContext` 并透传
- `src/im/slack/SlackAdapter.ts`：`app_mention` 构造 Slack 版 `ConfirmSender`（绑定 web/channelId/threadTs，内部委托 `deps.slackConfirm.send`），填入 InboundMessage.confirmSender
- `src/application/createApplication.ts`：
  - 新增 `createSelfImproveCollector` / `createSelfImproveGenerator` 装配
  - `toolsBuilder` 签名扩展，透传 `ctx.confirm`
  - `buildBuiltinTools` deps 扩展（memoryStore / selfImproveCollector / selfImproveGenerator / paths / logger）
- `src/agent/tools/index.ts`：注册 `self_improve_collect` + `self_improve_confirm`；`BuiltinToolDeps` 接口化
- `scripts/smoke.ts`：同步补齐新依赖

**未实施**：
- 未写 `selfImproveCollect.test.ts` / `selfImproveConfirm.test.ts`（用户约束"不要生成测试脚本"）
- 端到端联调（真实 Slack 发送 @mention → 按钮 → system.md 写入）由用户自己验证

**已知兼容点**：
- `ToolsBuilder` 由 1 参改 2 参：`(currentUser) => {}` 形式仍兼容（TS 允许参数少于签名）；`ConversationOrchestrator.test.ts` / 集成测试的 `toolsBuilder: () => ({})` 无需改动
- `buildBuiltinTools` 必填 deps 增多：`createApplication.test.ts` mock 返回值不受影响；`scripts/smoke.ts` 已同步

**未验证**：未运行 `pnpm vitest` / `pnpm lint` / `tsc`（用户要求）。

测试建议（口头）：
1. `pnpm exec tsc --noEmit`
2. `pnpm lint`
3. `pnpm vitest run` 观察 SlackAdapter / Orchestrator 相关套件
4. 真实 Slack：@bot 总结最近经验 → 观察两次 tool 调用 → 点击按钮 → 检查 `.agent-slack/system.md` 出现 `## 由 self_improve 产生的规则` + 采纳条目

### P4 补记：generator 5 个子决策的权衡（2026-04-23 讨论同步）

**架构 #1（走向）**：选"A + 双 tool + generator 纯代码"。核心洞察：主 Agent 已经在一轮 LLM 里跑，让它顺手做"提炼"（SessionRound → CandidateRule），generator 只做"机械清洗"纯函数。双 tool 让主 Agent 在 collect 和 confirm 中间可决策（例如"本次没啥可提炼"直接不调 confirm）。

**架构 #2（generator 5 个子决策）**：

1. **去重算法：Jaccard token 重叠 + 0.6**
   - 拒 a. 精确哈希：改写即失效（"禁止使用 any，改用 unknown" ≠ "不要用 any，用 unknown"）
   - 拒 c. 编辑距离：O(n²) 慢，对语序不免疫
   - tokenize 每步的原因：
     - `toLowerCase`：避免 "Any" ≠ "any"
     - 去 Markdown 标点（\` \* _ > # [ ] ( ) ~）：避免 `**any**` ≠ `any`
     - `\p{L}\p{N}` Unicode 切分：`\w` 不含中文
     - `length ≥ 2`：剔除 "的" "a" 之类单字符噪音
   - 阈值 0.6：0.5 太松（"禁止 any" 和 "禁止 unknown" 误判重），0.7 太严（近义改写漏判）。兜底靠用户点按钮，Jaccard 只做粗筛。

2. **tool 返回 `{ sent, skipped, reason? }`**
   - 拒 a. number：主 Agent 无法解释"为什么 0 条"
   - 拒 c. 完整 CandidateRule[]：污染主 Agent context，浪费 token，可能幻觉出"再告诉用户规则内容"
   - `reason` 枚举仅 2 个：`'no_confirm_channel'`（非 Slack 环境无 ConfirmSender）/ `'all_filtered'`（全部候选被 generator 过滤）；reason optional，正常路径不携带

3. **排序：confidence + category.localeCompare（稳定）**
   - 拒 a. 仅 confidence：组内顺序依赖上游 LLM，不可预期
   - 拒 c. 保留原序：LLM 输出顺序依赖 few-shot + prompt
   - 稳定性让测试可断言、截图可复现；同 category 连排是附带体验收益

4. **tool 命名 snake_case**：`self_improve_collect` / `self_improve_confirm`。与 `bash` / `read_file` 一致，降低主 Agent 选 tool 的认知负担

5. **导出 tokenize + jaccard**：纯函数 + 算法基石；导出后可直接 `import { tokenize, jaccard }` 做白盒单测（空串、纯 Markdown、中英混合、阈值 0.59/0.60/0.61 边界），不导出需通过构造 CandidateRule[] 间接触发，测试数据冗余 10 倍。代价是暴露内部 API，但两者语义极稳不会乱改。

### P5.1 `self_improve_collect` scope 改为 `'--all' | number`（2026-04-23）

**起因**：用户 review 后指出 P3 收集器写死"最近 7 天"不合理，应允许模型按用户意图选择范围。

**改动**：
- `src/agent/tools/selfImprove.collector.ts`：`CollectorScope` 由 `'all' | 'recent'` 改为 `'--all' | number`（number=天数）；移除 `RECENT_WINDOW_MS`，动态计算
- `src/agent/tools/selfImproveCollect.ts`：参数 `z.union([z.literal('--all'), z.number().int().positive()])`，默认 `'--all'`，describe 引导模型
- `docs/.../self-improve-design.md` §5/§11 代码示例同步

### P5.2 Collector 重构：结构化 rounds（借鉴 Claude Code compact）（2026-04-23）

**起因**：用户指出原 `highlights: string[]` 只取末尾 3 条 assistant 截 300 字信息量不足，且完全丢弃 user 消息；参考 `/Users/moego-winches/Desktop/Company/AI-Agent/general-agent/free-code/src/services/compact/` 的 compact 策略重构。

**借鉴要点**：
- Claude Code compact prompt 明确要求"List ALL user messages"
- 按 API round 分组（user→assistant→tool_results 为一组）
- 不做机械裁剪抽样，保留全量让下游 LLM 自己总结

**改动**：
- `src/agent/tools/selfImprove.collector.ts`：
  - 新增 `SessionRound` 类型：`{ userMessage, assistantTexts[], toolCalls[] }`
  - `SessionSummary.highlights: string[]` → `rounds: SessionRound[]`
  - `analyzeMessages` 重写：以 user 消息为 round 边界，assistant/tool 归属当前 round
  - 新增 `extractUserText` 支持 user content 是字符串或数组形式
  - 新增 `trimRoundsBySessionBudget`：从尾部（最新）往前保留，超 `MAX_SESSION_CHARS` 丢最旧
  - 新增/替换常量：
    - `MAX_USER_MESSAGE_CHARS = 2000`
    - `MAX_ASSISTANT_TEXT_CHARS = 1000`
    - `MAX_ERROR_TEXT_CHARS = 500`
    - `MAX_SESSION_CHARS = 12000`
  - 移除：`MAX_HIGHLIGHTS_PER_SESSION / ASSISTANT_SUMMARY_MAX_CHARS / LAST_ASSISTANT_COUNT`
- `docs/superpowers/specs/2026-04-22-self-improve-design.md`：§5.3 / §10 同步更新 interface 与 token 控制策略

**未变更**：collector 对外签名 / selfImproveCollect.ts tool 返回形状（rounds 直接透传）。

**起因**：用户 review 后指出 P3 收集器写死"最近 7 天"不合理，应允许模型按用户意图选择范围。

**改动**：
- `src/agent/tools/selfImprove.collector.ts`：
  - `CollectorScope` 类型：`'all' | 'recent'` → `'--all' | number`（number = 天数）
  - 去掉 `RECENT_WINDOW_MS` 常量，改用 `MS_PER_DAY * scope` 动态计算 cutoff
- `src/agent/tools/selfImproveCollect.ts`：
  - 参数 schema：`z.union([z.literal('--all'), z.number().int().positive()]).optional()`
  - 默认 `scope ?? '--all'`
  - describe 引导：用户说"最近经验"→传 7；指定天数→传对应数字；"全部"或未指定→默认 `--all`
- `docs/superpowers/specs/2026-04-22-self-improve-design.md`：同步 §5 / §11 代码示例

---

## ask_confirm 衍生任务记录

### 背景（2026-04-23）

用户接了"开白名单"业务 skill，里面的用户确认当前用 LLM 大白话询问→用户文字回复，希望改为 Slack 按钮 + 阻塞等待。
借鉴 `kagura/src/slack/interaction/user-input-bridge.ts` 的 Promise 桥模型，合并到 agent-slack 现有 SlackConfirm 按钮方案。

与 `self_improve_confirm` 的区别：
- `self_improve_confirm`：发完即返，副作用在 onDecision（写 system.md）
- `ask_confirm`：阻塞 tool，用户点完才 return decisions，LLM 拿结果继续业务逻辑

### design doc 5 个关键决策（已与用户讨论）

1. 新增 `ask_confirm` tool，不扩展 `self_improve_confirm`（语义不同）
2. 同 thread 单 pending（kagura 风格）
3. 默认超时 10 分钟（可 timeoutMs 覆盖）
4. 点击后 thread 回帖反馈（"✅ 已采纳 xxx / ❌ 已忽略 xxx / ⏱ 超时未决 xxx"）
5. 超时后按钮 fallback：方案 C —— adapter 分支 + ephemeral 提示（代价最小，点击者有感知）

### 实施计划

| 阶段 | 内容 |
|---|---|
| Q0 | `src/im/slack/ConfirmBridge.ts`：Promise 桥 + 超时 + 单 pending + AbortSignal |
| Q1 | `src/agent/tools/askConfirm.ts`：tool 定义 + postDecisionFeedback |
| Q2 | 接入：createApplication 装配 / SlackAdapter action handler 加 `ask:*` 超时 fallback / tools/index.ts 注册 |
| Q3 | 端到端联调 |


### Q0 完成（2026-04-23）

**产出**：`src/im/slack/ConfirmBridge.ts`（~200 行）

chunk 1（骨架）：
- `ConfirmBridge` 接口：`hasPending` / `awaitAllDecisions` / `resolveOne`
- `pendingByThread: Map<threadTs, ConfirmPending>` 单 pending（同 thread 禁止并发）
- `resolveOne` 三重校验：无 pending / toolCallId 不匹配 / 重复点击 都忽略

chunk 2（完整）：
- `ConfirmTimeoutError` / `ConfirmAbortError`：携带 `partialDecisions`，交由 tool 决定回退
- `timeoutMs` setTimeout → 超时 reject TimeoutError
- `signal?: AbortSignal`：已 aborted 立即 reject / 监听 abort → reject AbortError
- `cancel(threadTs, reason?)` 方法
- 每个 pending 的 `cleanup`（clearTimeout + removeEventListener），resolve/reject/cancel 统一调用

### Q1 完成（2026-04-23）

**产出**：
- `src/agent/tools/askConfirm.ts`：tool 定义 + postDecisionFeedback
  - tool 名 `ask_confirm`
  - 参数 schema：`title` / `items[]`（id/title/description?） / `timeoutMs?`
  - `no_confirm_channel` / `concurrent_pending` 早期返回
  - `namespace = ask:<toolCallId>` 和 self_improve 隔离
  - 捕获 `ConfirmTimeoutError` / `ConfirmAbortError` → 使用 `partialDecisions`，输出 `timedOut` / `aborted` 标志
  - 每个条目决定 `accept` / `reject` / `timeout`
  - postFeedback 失败只记 error log，不影响返回
- `src/im/types.ts`：`ConfirmSender` 扩展
  - 新增 `sessionId: string`（IM-agnostic 不透明 id，Slack 下 = threadTs）
  - 新增 `postFeedback(text: string): Promise<void>`（IM-agnostic 回帖）

### Q2 完成（2026-04-23）

**改动**：
- `src/im/slack/SlackAdapter.ts`：
  - `SlackAdapterDeps` 加 `confirmBridge?: ConfirmBridge`（可选，保持测试兼容）
  - ConfirmSender 实现填充 `sessionId = threadTs` + `postFeedback` 调 chat.postMessage
  - `app.action(/^confirm:/)` 闭包加 `ask:*` 超时 fallback 分支：namespace 以 `ask:` 开头 + bridge 无 pending → `respond` ephemeral 提示"已超时"，不调 handleConfirmAction
- `src/application/createApplication.ts`：
  - 装配 `confirmBridge = createConfirmBridge({ logger })`
  - 注入 toolsBuilder（BuiltinToolDeps.confirmBridge）
  - 传给 SlackAdapter
- `src/agent/tools/index.ts`：
  - 注册 `ask_confirm: askConfirmTool(ctx, { bridge, logger })`
  - `BuiltinToolDeps` 加 `confirmBridge: ConfirmBridge`
- `scripts/smoke.ts`：同步 buildBuiltinTools 调用，加 confirmBridge 参数（否则 typecheck 失败）

**验证**：
- `pnpm typecheck`：除 baseline 3 条 anthropic 类型错误（pre-existing，与 ask_confirm 无关），无新增
- `pnpm lint`：通过（prettier 已 format）
- `pnpm test`：193 通过 + 5 失败（均为 baseline pre-existing，都在 createApplication.test.ts，与 ask_confirm 无关）
- ❌ **未做**：端到端 Slack 联调（Q3）

