# Coding Agent SDK 选型对比（新项目）

> **日期**：2026-05-24
> **作者**：winches
> **状态**：✅ 全部完成 — Chunk 1（clone + 定位）/ Chunk 2（短名单决策）/ Chunk 3（27 × 8 矩阵 + ★ 维度对比）/ Chunk 4（推荐 + html 可视化）四阶段已 ship。**主推 = pi**，**备选 = opencode**。如试跑出现反证会及时调整本文档
> **关联**：本 spec 与同日 [`2026-05-24-agent-sdk-selection-comparison.md`](2026-05-24-agent-sdk-selection-comparison.md) **是独立的两份**：
> - **本文档**：新开一个 coding agent 项目（end product，非 SDK），评估**用什么基座 SDK** + **从哪些 end-product 学实现**
> - **同日 agent-sdk-selection-comparison.md**：基于 agent-slack 当前基座的横向研究
>
> **配套文件**：本仓库 `external-references/` 下已 clone 14 个候选（剔除 goose Rust 项目）；html 可视化版本同名 `.html`（gitignored，本地预览）
>
> **Chunk 5/6 增补（2026-05-24 末）**：用户 review 触发两轮迭代——(1) `@ai-sdk/workflow` 调研 → **不升候选**（是 ai 主包胶水层，多 hook GAP，详见 §4.5 ai 行）；(2) **DeepAgents (langchain-ai/deepagentsjs) 升候选**（基座从 8→9）—filesystem/subagent/skill/plan/permission/HITL/sandbox/ACP server 全 first-class，但 MCP 零原生 + LangGraph 透出 + 4 hook 偏少，备选层面挑战 opencode 但不替主推

---

## 0. 背景与边界

### 0.1 项目背景

- **重新开一个新项目**，不基于 agent-slack 或任何现有代码库改
- 目标产品形态 = **像 Claude Code 一样基于工作区的 end product**（CLI / TUI / 桌面，最终决定看后续）
- **底层不对外暴露**：不发布 SDK、不允许业务方 import 内部 API；所有扩展必须走插件机制

### 0.2 评估视角（两个目标场景）

1. **自研像 Claude Code 一样基于工作区的现成产品**
   - 长会话 / 工作区感知 / 文件操作 / 命令执行 / 子 agent / Compact / 长期记忆
2. **底层不对外暴露，扩展走插件机制**
   - 插件机制形状（Hook 粒度：PreToolUse / PostToolUse / Stop / Compact / Notification 等）
   - 插件分发与加载（本地路径 / npm / 注册中心）
   - 隔离性（进程隔离 / 错误隔离 / 资源边界）
   - 业务方仅接触「插件接口」，看不到 loop / provider / message 协议

### 0.3 约束

- **TS 栈优先**：Node 22+；CLI / TUI / 桌面均可
- **不需要 SDK 形式对外** → 第 15 维度「SDK 可嵌入性」失去意义，**改写**为「开发者体验（自研团队使用基座 SDK 时的 API 稳定度 / 文档 / 类型 / 报错友好度）」
- **Python / Rust 项目不作为基座** → 仅作为「产品参考组」学习实现细节
- 本对比不动 agent-slack `src/` 代码，仅读 `external-references/`

### 0.4 候选分两层（重要 — 与之前 spec 的关键差异）

新项目的诉求不是「选一个 SDK 嵌入业务」，而是「选一个基座 + 学习现有产品」。所以候选分两层：

- **基座 SDK 候选**（用作新项目底层）：**9 个**（Chunk 6 加 DeepAgents） — 这层做 27 维度深填
- **产品参考组**（不作基座，但要从它们学实现）：5 个 — 这层做「关键启示」段落，不进矩阵

---

## 1. 候选清单（共 14；去 goose Rust 项目；Chunk 6 加 DeepAgents）

### 1.1 基座 SDK 候选（9 个，做 27 维度深填）

| # | 候选 | 一句话 | 类型 | 语言 |
|---|---|---|---|---|
| 1 | **ai** (Vercel AI SDK) | 多 provider TS LLM SDK + agent loop 原语 + Generative UI | SDK 库 | TS |
| 2 | **claude-agent-sdk-typescript** | Anthropic 官方：把 Claude Code 能力 SDK 化（同款 loop / compact / hooks / MCP） | SDK 库 | TS |
| 3 | **openai-agents-js** | OpenAI 官方 multi-agent SDK；Sandbox Agent + Handoff + Tracing | SDK 库 | TS |
| 4 | **mastra** | YC W25；TS 一站式框架：agent + workflow + memory + eval + MCP | 框架 | TS |
| 5 | **langgraphjs** | LangChain 出品低层 graph orchestration；生产规模验证 | SDK 库 | TS |
| 6 | **eko** (FellouAI) | JS Agent 框架：browser + node + 多 agent + 依赖图并行 + Native MCP | SDK 库 | TS |
| 7 | **pi** | earendil-works monorepo：`pi-ai`（多 provider）/ `pi-agent-core`（loop + state）/ `pi-tui`（差分渲染）；可单独 import core 作基座 | SDK + CLI | TS |
| 8 | **opencode** | 完整 CLI 产品 + plugin 系统；内置 build / plan / general 三 agent；引擎可作基座参考 | CLI + 引擎 | TS |
| 9 | **DeepAgents** (Chunk 6 加) | langchain-ai/deepagentsjs；建在 LangGraph 之上的 batteries-included harness：filesystem/subagent (含 async)/skills/plan/permission/HITL/sandbox (5 实现)/ACP server 全 first-class；MCP 零原生；hook 仅 4 个 LangChain MW | SDK 库 + ACP server | TS |

### 1.2 产品参考组（5 个，不进矩阵但写「关键启示」）

| # | 候选 | 形态 | 语言 | 学什么 |
|---|---|---|---|---|
| 9 | **cline** | VSCode + JetBrains 插件 + CLI + Kanban + `@cline/sdk` | TS | Prompt 工程模块化（component + variant + template）/ proto 协议 / 多 IDE 集成 / 插件 |
| 10 | **wanman** | Agent Matrix supervisor；spawn Claude Code/Codex 子进程 | TS | Supervisor 多 agent + per-agent worktree + 隔离 $HOME |
| 11 | **free-code** | Claude Code 反编译 fork（去 telemetry + 解锁实验 flag） | TS (Bun) | 研究 Claude Code 内部实现最直接入口；`FEATURES.md` 列出全部 88 个 flag |
| 12 | **deer-flow** | ByteDance super agent harness；sub-agent + sandbox + skills | Python+Node | sandbox 模式 / Claude Code 集成 / 多 IM 渠道 |
| 13 | **CowAgent** | 中文多通道 IM agent；Skill Hub + 长期记忆 + 梦境记忆 | Python | Skill Hub 分发设计 / 长期记忆分层（核心 / 日级 / 梦境） |

### 1.3 短名单决策

- **基座 SDK 候选 = 全部 9 个进 27 维度深填**（每个都有评估必要性）
- **产品参考组 = 不进矩阵，但 §2 给每个写关键启示段落**

> 与上一版的关键差异：
> - `@cline/sdk` 不进基座候选 — `cline` 本体仅作产品参考（学 prompt 工程 / 多 IDE 集成）
> - **`pi` 升基座** — `pi-agent-core` / `pi-ai` 包边界清晰、可单独使用，符合基座 SDK 定位
> - **`opencode` 升基座** — plugin 系统 + 内置多 agent 是基座层能力，引擎适合作为参考实现
> - **`DeepAgents` 升基座**（Chunk 6） — 用户主动挖出 langgraphjs README 提到的 Deep Agents；调研发现是"LangGraph 生态内 batteries-included harness"，filesystem/subagent/skill/plan/permission/HITL/sandbox/ACP 全 first-class，覆盖度全场最高；但 MCP 零 + LangGraph 透出 + hook 仅 4 个，"底层不对外暴露"目标存在张力，故进基座但不替 pi 主推

---

## 2. 候选定位卡片

### 2.1 基座 SDK 候选（详细）

#### ai (Vercel AI SDK)

- **定位**：多 provider 统一接口（OpenAI/Anthropic/Google/Bedrock/...）+ `streamText` / `generateObject` / `tool()` / `experimental_telemetry` / Generative UI
- **形态**：库（npm `ai`）；无 CLI；可在任何 Node/Edge/Browser 项目里组合
- **与本场景契合**：
  - 基于工作区：⚠️ 需自己拼装 agent loop / compact / 子 agent / 工作区抽象
  - 插件机制：⚠️ 没有内置 Hook 粒度（PreToolUse / Compact 等），需自己包一层
- **关键文件**：`external-references/ai/packages/ai/` / `packages/provider/` / `architecture/`
- **活跃度**：近 1 周有 commit

#### claude-agent-sdk-typescript

- **定位**：Anthropic 官方把 Claude Code 的能力（loop / compact / MCP / hooks / subagent / tools / skills）封装为 SDK
- **形态**：库（npm `@anthropic-ai/claude-agent-sdk`）；仅 Anthropic provider
- **与本场景契合**：
  - 基于工作区：✅ 直接复用 Claude Code 全部工作区能力
  - 插件机制：✅ Hook 粒度齐全（PreToolUse / PostToolUse / Stop / Notification / SubagentStop / UserPromptSubmit / SessionStart 等）
- **关键文件**：`external-references/claude-agent-sdk-typescript/README.md`；详细 API 见 [官方文档](https://docs.claude.com/en/api/agent-sdk/overview)
- **活跃度**：近 1 周有 commit
- **限制**：单 provider（仅 Anthropic）；商业条款见 LICENSE

#### openai-agents-js

- **定位**：OpenAI 官方 multi-agent 编排 SDK；核心概念：Agent / SandboxAgent / Handoff / Tool / Guardrail / Session / Tracing
- **形态**：库（npm `@openai/agents`）；provider-agnostic（OpenAI + 其他）
- **与本场景契合**：
  - 基于工作区：✅ **Sandbox Agent 是一等公民**（含 `gitRepo` mount / `UnixLocalSandboxClient`）
  - 插件机制：⚠️ Guardrail + Handoff 是 first-class；未看到等价于 PreToolUse 的 Hook 粒度
- **关键文件**：[external-references/openai-agents-js/README.md:14-22](external-references/openai-agents-js/README.md)
- **活跃度**：近 1 周有 commit；Sandbox Agent 是新 beta
- **限制**：Sandbox Agent beta；voice 等高级功能依赖 OpenAI 平台

#### mastra

- **定位**：TS 一站式框架（YC W25）；agent + workflow（`.then().branch().parallel()`）+ memory（working / semantic）+ eval + observability + MCP
- **形态**：框架（npm `@mastra/core` + 多包）；CLI（`npm create mastra@latest`）
- **与本场景契合**：
  - 基于工作区：⚠️ 工作区不是 first-class；但 storage / suspend-resume 强
  - 插件机制：⚠️ 模块化好，Hook 粒度待深入验证
- **关键文件**：`external-references/mastra/packages/core/src/`（架构见 [README.md:69-77](external-references/mastra/AGENTS.md)）
- **活跃度**：近 1 周有 commit
- **限制**：双 License（核心 Apache 2.0；`ee/` 目录 Mastra Enterprise License）

#### langgraphjs

- **定位**：低层 graph orchestration；StateGraph + Pregel + Channels + Checkpointer 四层架构
- **形态**：库（npm `@langchain/langgraph`）；上层有 `Deep Agents` / `LangGraph Platform`
- **与本场景契合**：
  - 基于工作区：⚠️ 通用 orchestrator；工作区抽象需自己加
  - 插件机制：✅ 底层灵活；Checkpointer + human-in-the-loop first-class；自由编排
- **关键文件**：[external-references/langgraphjs/CLAUDE.md](external-references/langgraphjs/CLAUDE.md) 已点明架构层次
- **活跃度**：近 1 周有 commit
- **限制**：抽象层多，上手曲线陡

#### eko (FellouAI)

- **定位**：JS Agent 框架，跨 browser + node；多 agent + 依赖图并行 + Native MCP + pause/resume
- **形态**：库（npm `@eko-ai/eko` + `eko-nodejs` / `eko-web` / `eko-extension`）
- **与本场景契合**：
  - 基于工作区：⚠️ FileAgent 有，但工作区抽象偏弱；browser 端强
  - 插件机制：✅ "Customize new Agents and Tools in just one line"；多 LLM 路由灵活
- **关键文件**：[external-references/eko/README.md](external-references/eko/README.md)
- **活跃度**：2025-11 release 4.0；近 1 月有更新
- **限制**：browser 强、Node 工程化偏弱；中文/亚洲社区为主

#### pi

- **定位**：earendil-works 出品的 coding agent monorepo；**核心是 `pi-agent-core`（agent runtime with tool calling & state management）+ `pi-ai`（多 provider 统一）+ `pi-tui`（差分渲染 TUI）+ `pi-coding-agent`（参考 CLI 实现）**；可单独 import core 作基座
- **形态**：monorepo；包名 `@earendil-works/pi-agent-core` / `@earendil-works/pi-ai` / `@earendil-works/pi-coding-agent` / `@earendil-works/pi-tui`
- **与本场景契合**：
  - 基于工作区：✅ pi-coding-agent 本身就是工作区 agent；包结构清晰可学
  - 插件机制：⚠️ 是否有正式 Hook / Plugin 接口待 Chunk 3 源码验证
- **关键文件**：
  - `external-references/pi/packages/agent/`（loop + state）
  - `external-references/pi/packages/ai/`（provider 统一）
  - `external-references/pi/packages/coding-agent/`（参考 CLI）
  - `external-references/pi/packages/tui/`（差分渲染）
- **活跃度**：近 1 周有 commit
- **特色**：**供应链硬化**（依赖精确锁版本 + `min-release-age=2` + `npm-shrinkwrap.json` + lifecycle 脚本 allowlist），新项目可直接抄
- **限制**：社区规模小（相比 vercel/ai 等）；公共 API 稳定度需要看 changelog 验证

#### opencode

- **定位**：完整开源 coding agent 产品（npm `opencode-ai` + 桌面 app）；内置 **build**（全权）/ **plan**（只读）/ **general** 三 agent，Tab 切换；有 plugin 系统
- **形态**：CLI + desktop app；npm `opencode-ai`；底层引擎可拆出作基座研究
- **与本场景契合**：
  - 基于工作区：✅ 工作区是一等公民；plan 模式 / build 模式切换 UX 成熟
  - 插件机制：✅ 有 plugin 系统（详细 API 待 Chunk 3 验证）
- **关键文件**：
  - `external-references/opencode/packages/`（monorepo 结构）
  - `external-references/opencode/README.md`（Agents 段说明三个内置 agent）
  - 官方文档 https://opencode.ai/docs/agents
- **活跃度**：近 1 周有 commit；社区活跃
- **特色**：i18n 文档体系（20+ 语言）；多发行渠道（brew / scoop / pacman / nix / mise）
- **限制**：作为 end-product 起家，公共 SDK API 暴露程度需源码验证；plugin 系统的隔离性 / 分发机制待评估

#### DeepAgents (Chunk 6 增补)

- **定位**：LangChain 出品 `langchain-ai/deepagentsjs`；建在 `langchain` + `@langchain/langgraph` 之上的 **batteries-included agent harness**；公共入口 `createDeepAgent()` 返回 compiled LangGraph graph
- **形态**：SDK library（npm `deepagents` 1.10.2 stable）+ 可选 `deepagents-acp` CLI/Server（被 Zed/JetBrains/Neovim/Emacs 直接调用）
- **与本场景契合**：
  - 基于工作区：✅ **filesystem first-class + 4 backend**（State/Store/Filesystem/Composite/ContextHub）+ ripgrep + symlink 防护 + virtualMode 沙箱；ls/read/write/edit/glob/grep 内置 middleware tool
  - 插件机制：🟡 **LangChain AgentMiddleware 4 hook**（beforeAgent / afterAgent / wrapModelCall / wrapToolCall）；**无 PreToolUse/Compact/Notification 命名**；无 plugin manifest 分发；插件 = LangGraph 学习曲线
- **开箱即用清单**（覆盖度全场最高）：subagent（含 **async subagent** 走远端 LangGraph）/ Skills（Anthropic Skills 规范）/ todos plan / path glob permission / HITL `interruptOn` / Compact summarization + offload `/conversation_history/{thread_id}.md` / Sandbox 5 实现（daytona/deno/modal/node-vfs/quickjs）/ LangSmith Tracing first-class / ACP server first-class
- **关键文件**：
  - `external-references/deepagentsjs/libs/deepagents/src/agent.ts`（`createDeepAgent` 入口）
  - `external-references/deepagentsjs/libs/deepagents/src/middleware/`（fs/subagents/skills/summarization/memory/...）
  - `external-references/deepagentsjs/libs/deepagents/src/backends/`（5 个 workspace backend）
  - `external-references/deepagentsjs/libs/acp/src/server.ts`（ACP server 实现）
  - `external-references/deepagentsjs/libs/providers/{daytona,deno,modal,node-vfs,quickjs}/`（sandbox 5 实现）
  - `external-references/deepagentsjs/examples/`（12+ 典型用法）
- **活跃度**：1.10.2 stable / MIT；CHANGELOG 显示 6 个月内从 1.9→1.10，7+ contributor 活跃；最新 commit 2 天前
- **限制**：
  - ❌ **MCP 零原生**（grep 无匹配；ACP server 显式声明 `mcpCapabilities: {http:false, sse:false}`）
  - ⚠️ **LangGraph 完全透出**（`createMiddleware` / `Command` / `messages` 都从 langchain import）；用户可绕过 `createDeepAgent` 直接拼 → 跟"业务方仅接触插件接口"目标张力
  - 🟡 主循环 = langchain `createAgent`，**不可换**；二次开发上手 = LangGraph + middleware
  - 🟡 错误/限流靠底层 langchain + LangGraph 平台（仅自定义 `ConfigurationError`）

### 2.2 产品参考组（关键启示）

> 不参与 27 维度评分，但新项目实现时**直接参考**。每个候选写：值得偷的实现 + 关键文件入口

| 候选 | 关键启示 | 入口 |
|---|---|---|
| **cline** | **Prompt 工程模块化**：`components/`（reusable 段落）+ `variants/`（模型差异化：gpt-5 / gemini-3 / xs 等）+ `template.ts`（带 `{{PLACEHOLDER}}` 解析）；snapshot 测试守护跨模型一致性 | `src/core/prompts/system-prompt/README.md`、`tools/README.md`、`__tests__/README.md`、`variants/` |
| **cline** | **Tool 注册全链路**：proto 定义 → ClineDefaultTool enum → tool 定义 + variant fallback → 各 variant config → handler → ToolExecutor → 解析 → UI；改一个 tool 要同步 8 处 | `.clinerules/general.md` "Adding Tools to System Prompt" |
| **cline** | **跨 IDE 抽象**：grpc-protobuf 内部协议解耦 webview 与 backend；同一引擎跑 VSCode / JetBrains / CLI | `proto/cline/` + `src/generated/` |
| **wanman** | **Supervisor 多 agent**：spawn Claude Code / Codex 子进程；JSON-RPC 2.0；per-agent worktree + 隔离 `$HOME`；CLI-first 可脚本化 | `external-references/wanman/docs/architecture.md` |
| **free-code** | **Claude Code 内部实现最直接入口**：去 telemetry + 解锁全部 88 flag；`FEATURES.md` 是 flag 字典；`ULTRATHINK` / `BASH_CLASSIFIER` / `EXTRACT_MEMORIES` 等是 Claude Code 工程细节 | `external-references/free-code/FEATURES.md` |
| **deer-flow** | Sub-agent + Sandbox 模式；Claude Code 集成方式；可选 IM 渠道 | `external-references/deer-flow/README.md` Core Features 段 |
| **CowAgent** | **长期记忆分层**：核心记忆 / 日级记忆 / 梦境蒸馏 + 关键词及向量检索；Skill Hub 分发设计 | `external-references/CowAgent/agent/`、`channel/`、`docs/` |

---

## 3. 27 维度评估框架

> 改动：维度 15 「B. SDK 可嵌入性」**改写**为「开发者体验」；其余 26 个维度不变

### 第一章 核心能力（16）

| # | 维度 | 关注点 |
|---|---|---|
| 1 | **agent loop** | 自定义 loop / 每轮 step 介入点 |
| 2 | **多 provider 适配** | 本地模型 / Bedrock / Vertex / 自定义 endpoint |
| 3 | **thinking mode** | thinking stream 可获取性 |
| 4 | **plugin 系统** | 插件加载机制 / 分发形态 |
| 5 | **插件扩展能力** | 业务（加工具/prompt）vs 底层（改 loop/provider/compact） |
| 6 | **skills** | Skill 概念 & 触发机制 |
| 7 | **MCP** | 原生支持 / stdio·sse·http transport / client·server |
| 8 | **subAgent** | 并行/串行 / 上下文隔离 / 跨语言跨模型 |
| 9 | **Compact** | 自动/手动 / 阈值可配 / 策略可换 / 保留关键 message |
| 10 | **tool 权限管理** | 黑白名单 / 运行时确认 / 工具粒度 / path 粒度 |
| 11 | **Memory** | 短期/长期 / 跨会话·会话内 / 可插拔后端 |
| 12 | **streamText** | 文本流 / tool call 流（partial args）/ structured output 流 / generative UI |
| 13 | **底层灵活性** | 自定义 agent 主循环 / 替换 model client / 替换 message 协议 |
| 14 | **A. 插件机制形状** ★ | Hook 粒度（PreToolUse / PostToolUse / Stop / Compact / Notification）/ 扩展方式 / 分发形态 / 隔离性 |
| 15 | **B. 开发者体验**（改写）| 公共 API 稳定度 / 文档完备度 / 类型完备度 / 报错友好度 / 上手曲线 |
| 16 | **C. 工作区抽象** ★ | Workspace / Session / Project / 文件系统感知 / cwd binding / UI 层 hooks |

> ★ = 与本项目目标场景**强相关**的两个维度，是最终决策的关键票

### 第二章 生产就绪（9）

| # | 维度 | 优先级 |
|---|---|---|
| 17 | **可观测性 & Tracing** OTel / LangSmith / Langfuse / Helicone | P0 |
| 18 | **错误处理 & 限流** rate limit / cost tracking / 自动重试 / 断点续跑 | P0 |
| 19 | **结构化输出 & Schema** Zod / JSON Schema / TypeBox / 流式 structured output | P0 |
| 20 | **持久化 & 会话恢复** 对话历史落库 / 中间状态可恢复 / 跨进程恢复 | P0 |
| 21 | **多模态输入** image / audio / video / file 输入 / 多模态输出 | P1 |
| 22 | **测试 / Eval 框架** Agent 质量评估 / mock&replay / 回归测试 | P1 |
| 23 | **部署模式** self-host / serverless / edge / 容器 | P1 |
| 24 | **License & 商业条款** 商用限制 / 双 License / 自部署门槛 | P1 |
| 25 | **社区 & 维护节奏** 主仓 commit 频率 / issue 响应 / 文档完整度 | P1 |

### 第三章 场景适配（2）

| # | 维度 |
|---|---|
| 26 | **Agent 通用协议**（ACP / A2A） — 与其他 agent 系统互通 |
| 27 | **安全沙箱** — tool 执行隔离 / prompt injection 防护 / 脱敏 / secret 管理 |

### 单元格填写规范

每个 cell 必须含：

1. **结论符号**：✅ 原生支持 / 🟡 部分支持 / ⚠️ 需自己拼 / ❌ 不支持 / ➖ 不适用
2. **实操体验标注**：`[用过]` / `[读过文档]` / `[看过 demo]` / `[读过源码]` / `[未亲测]`
3. **关键引用**：相关代码或文档路径 + 一句话佐证

示例：
> | 1. agent loop | claude-agent-sdk | ✅ `[读过文档]` 内部即 Claude Code loop；通过 `hooks.Stop` / `maxTurns` 控制；`canUseTool` 可拦截每轮 |

### 推荐输出

- **1 主推**：综合得分最高 + 与本项目场景最匹配
- **1 备选**：在主推有限制时（如商业、license、绑定 provider）的兜底
- **决策附注**：是否需要自己包一层（基座 + glue code 模式）

---

## 4. 27 × 9 矩阵（Chunk 6 增补 DeepAgents 列）

### 4.1 第一章：核心能力（16 × 9）

> 实操标注：[读源码] / [读文档] / [看 demo] / [未亲测]；符号：✅ 原生 / 🟡 部分 / ⚠️ 需自拼 / ❌ 不支持 / ➖ 不适用

| 维度 \ 候选 | ai (Vercel) | claude-agent-sdk | openai-agents-js | mastra | langgraphjs | eko | pi | opencode | **DeepAgents** |
|---|---|---|---|---|---|---|---|---|---|
| 1. agent loop | ✅ [读源码] `ToolLoopAgent` + `prepareStep` / `stopWhen` / `onStepStart` hooks（agent/tool-loop-agent.ts:38） | 🟡 [读文档] SDK 是 CLI subprocess; `query()` 单入口; loop 在二进制内（CHANGELOG.md:166） | 🟡 [读源码] `runner/runLoop.ts` 模块化; 仅 `AgentHooks` / `RunHooks` 订阅 lifecycle | 🟡 [读源码] `workflowLoopStream` 封装; Processor.processInput/LLM* 多入口介入（loop/loop.ts:131） | ✅ [读源码] StateGraph 显式图; prebuilt `createReactAgent`（react_agent_executor.ts:669） | 🟡 [读源码] `Agent.runWithContext` 固定 ReAct; 子类 override（agent/base.ts:98） | ✅ [读源码] 极简 outer/inner loop + steering/follow-up/before+after ToolCall hooks（agent-loop.ts:155） | ⚠️ [读源码] 主循环深嵌 session/prompt.ts (68KB); 仅 11 hook 介入（plugin/src/index.ts:222） | 🟡 [读源码] LangGraph React loop via langchain `createAgent` + `recursionLimit:10000`; DeepAgents 只组织 middleware（agent.ts:449） |
| 2. 多 provider | ✅ [读文档] 35+ provider 包（openai/anthropic/google/bedrock/azure/vertex/...） | ❌ [读文档] 仅 Anthropic + Azure AI Foundry（CHANGELOG:787） | 🟡 [读源码] `ModelProvider` 可换; 默认 OpenAI; agents-extensions/ai-sdk 间接接其他 | ✅ [读源码] 40+ provider via AI SDK gateway + 自定义 provider | ✅ [读源码] 依赖 @langchain/core LanguageModelLike（ChatOpenAI/ChatAnthropic 自由切） | ✅ [读源码] `RetryLanguageModel`: openai/anthropic/google/bedrock/azure/openrouter + 自定义 ProviderV2（llm/rlm.ts:269） | ✅ [读源码] 9 provider 内置 + `registerProvider()` 接私有 endpoint（providers/, types.ts:23） | ✅ [读源码] 走 Vercel AI SDK 适配; `baseURL` 字段可自定义（provider/provider.ts:100） | 🟡 [读源码] `initChatModel` 支 OpenAI/Anthropic/Google 字符串; Bedrock/Vertex 需另装; 传 BaseLanguageModel 自定义 |
| 3. thinking mode | ✅ [读源码] `ReasoningOutput` + `reasoning` call option (low/medium/high/xhigh) | 🟡 [读文档] `ModelInfo.supportsAdaptiveThinking`; thinking stream API 未单独文档 | ✅ [读源码] `ModelSettingsReasoning` + `RunReasoningItem` 流事件原生承载 | ✅ [读源码] `ReasoningChunk` / reasoning output tokens（stream/types.ts:1003） | 🟡 [读源码] messages-v2 支持 reasoning block / reasoning-delta; 需 provider 透传 | ✅ [读源码] react.ts 流处理 reasoning-start/delta/end → `{type:thinking}`（react.ts:257） | ✅ [读源码] thinking 一等内容块; thinking_start/delta/end 流事件; level off→xhigh | ✅ [读源码] `ReasoningPart` schema; 单独 reasoning 事件; Anthropic 自适应 + 签名块 | 🟡 [读源码] subagents 保留 thinking/redacted_thinking 块; v3 stream `.reasoning` AsyncIterable |
| 4. plugin 系统 | ⚠️ [读源码] 无统一 plugin; `wrapLanguageModel` middleware + `registerTelemetry`; 分发靠 npm | ✅ [读文档] `Options.plugins` 字段; `reloadPlugins()` 返回 commands/agents/MCP status | ❌ [读源码] 无 plugin/extension 注册机制; 用户代码组合 | ⚠️ [读源码] 无统一加载器; 靠子包 + Processor 数组手动注入 | ⚠️ [读源码] 无标准 plugin; 靠 Runnable/Channel/子图/callbacks 组合 | ❌ [读源码] grep 无 plugin/hook 框架; 仅 `EkoConfig.callback` + 自定义 Agent/Tool/Mcp | ✅ [读源码] 完整 Extension/Package 系统; TS 模块默认导出函数; `~/.pi/agent/extensions/` 自动加载 + `/reload` | ✅ [读源码] `@opencode-ai/plugin` 独立包 + workspace + `.opencode/plugin/*.ts` 自动发现; server+TUI 双入口 | 🟡 [读源码] 无"插件"概念; 统一靠 AgentMiddleware (来自 langchain) 数组拼装; 无 manifest/分发 |
| 5. 插件扩展能力 | 🟡 [读源码] middleware 改 model 调用 + `prepareStep` 回调; 不能换 loop runtime | 🟡 [读文档] 业务层扩展 commands/agents/MCP; 底层不可改 | 🟡 [读源码] 业务可加 tool/MCP/Guardrail/Handoff/Session/ModelProvider; runner loop 无注入点 | ✅ [读源码] Processor 接口覆盖业务(加 sys msg/tools) + 底层(processLLMRequest/Response) | ✅ [读源码] 自定义 Channel/Pregel node/Reducer/Checkpointer; 自由替换 ReactAgent | 🟡 [读源码] 业务层可加 Agent/Tool/MCP/A2A + 全局 prompt 覆盖; 底层主循环需 fork | ✅ [读源码] 业务+底层并存: `registerTool/Command/Shortcut/Flag` + `registerProvider/streamSimple/compaction/editor` | ✅ [读源码] 工具+provider+auth flow + hook compact/sys prompt/messages transform/shell env | ✅ [读源码] middleware 业务（注 tools/sys prompt）+ 底层（wrapModelCall 改 request + wrapToolCall 改 tool execute + beforeAgent 改 state） |
| 6. skills | ⚠️ [读源码] `uploadSkill` 上传到 provider 服务端 (Anthropic Skills API), 非本地 SKILL.md 触发 | ✅ [读文档] `skills` 选项 `string[]/'all'`; `agents.skills`; 自动触发 + `user-invocable` 控制 | ✅ [读源码] Sandbox 一等 `SkillsCapability` + `load_skill` 工具 + SKILL.md frontmatter 扫描 | ✅ [读源码] 一等公民: agentskills.io 规范 + `workspace.skills` + `SkillsProcessor` + skill tool 按需加载 | ❌ [未亲测] 无 Skill 概念; prebuilt 仅 createReactAgent/Supervisor/Swarm | ❌ [读源码+文档] 无 Skill 概念; 最接近 `Agent.planDescription` | ✅ [读源码] 实现 agentskills.io + SKILL.md frontmatter + progressive disclosure + 多目录加载 | ✅ [读源码] 内置 Skill 服务; SKILL.md 自动发现; 兼容 `.claude/skills` / `.agents/skills` 等多路径 | ✅ [读源码] Anthropic Agent Skills 规范 + progressive disclosure + SKILL.md frontmatter + 多 source 后写覆盖 |
| 7. MCP | ✅ [读源码] `@ai-sdk/mcp` 独立包; http/sse/stdio 全支持; 仅 client | ✅ [读源码] examples 全 `query({mcpServers})`; stdio/sse/http 全; `createSdkMcpServer` 让 SDK 作 server | ✅ [读源码] 原生 MCPServerStdio/SSE/StreamableHttp; hostedMcpTool; 仅 client | ✅ [读源码] **双向**: MCPClient (stdio+SSE+HTTP) + MCPServer 暴露 agents/tools/resources/prompts | ❌ [读源码] grep MCP 在 libs 下零匹配; 需走外部 `@langchain/mcp-adapters` | ✅ [读源码] `IMcpClient` 接口; core: SSE+HTTP; nodejs 加 stdio; 仅 client | ❌ [读源码] 明确 **No MCP** 设计哲学; 主张用 Skill 替代; 要 MCP 需第三方 extension | ✅ [读源码] 原生 MCP client; stdio/SSE/HTTP; OAuth 回调 + 工具变更订阅; 仅 client | ❌ [读源码] **零 MCP 集成**; ACP server 显式 `mcpCapabilities:{http:false, sse:false}`; package.json 无 @modelcontextprotocol 依赖 |
| 8. subAgent | ⚠️ [读源码] 无原语; 常用 agent-as-tool 模式; context 隔离/并行需自拼 | ✅ [读文档] `agents` 选项编程式 + Task tools + `listSubagents` + `forwardSubagentText` 流式 | ✅ [读源码] Handoff + Agent-as-tool (`asTool` 支持 `onStream`); examples 含 parallelization | ✅ [读源码] `SubAgent` 接口 + `isAgentCompatible` + DelegationStart/Complete hooks + NetworkOptions/Supervisor | ✅ [读源码] StateGraph 嵌套 subgraph + `Send` API map/fanout 并行 + supervisor/swarm | ✅ [读源码] Planner 输出依赖图; normal/parallel 节点; `agentParallel`; AgentContext 独立 + llms 数组 | ⚠️ [读源码] 核心 **No sub-agents**; 仅 `examples/extensions/subagent` (spawn pi 进程,完全隔离), 非内置 | ✅ [读源码] `mode:subagent` (general/explore) 通过 task 工具; `background=true` 异步; task_status; 跨会话 resume | ✅ [读源码] 三类: SubAgent + CompiledSubAgent + **AsyncSubAgent (远端 LangGraph 平台)**; 独立 context; parallel via task 工具 |
| 9. Compact | ❌ [读源码] 仅 `prune-messages.ts` 静态裁剪; 无 token 阈值自动 compact; 需自拼 | 🟡 [读文档] 阈值/策略 API 未暴露; `getContextUsage()` + memory_recall 事件; 由 Claude Code 内置 | ✅ [读源码] Sandbox 内置 `CompactionPolicy` (Static/Dynamic 按窗口比例); `Session.runCompaction` 走服务端 | ⚠️ [读源码] 无显式 compact; `TokenLimiterProcessor` 截断 + semantic-recall 替代 | ⚠️ [读源码] 无内置自动 compact; 用户在 `preModelHook` 自实现 | 🟡 [读源码] `compressAgentMessages` 调 task_snapshot 工具; ChatAgent.manageCapacity 按 maxMessageNum/token 阈值 | ✅ [读源码] 自动按 token 阈值; `findCutPoint` + keepRecentTokens; 结构化 summary (Goal/Progress/Decisions/NextSteps); hook 可替换 | ✅ [读源码] 自动 compact; `PRUNE_MINIMUM=20K` / `PRUNE_PROTECT=40K`; 保护 skill 输出 + 最近 turns; `experimental.session.compacting` hook | ✅ [读源码] `createSummarizationMiddleware` 默认装载; fraction/messages/tokens 三阈值; 自动 summarize + 写 `/conversation_history/{thread_id}.md` |
| 10. tool 权限 | ✅ [读源码] `ToolApprovalConfiguration` per-tool approved/denied/user-approval + `activeTools` 白名单; path 需自实现 | ✅ [读文档] `allowedTools/disallowedTools/tools` + `canUseTool` 回调 + PreToolUse hook + `permission_policy` + path 粒度 `Bash(./scripts/gh.sh:*)` | 🟡 [读源码] 工具级 `needsApproval` + HITL; sandbox `WorkspacePathPolicy` path 粒度; 无 SDK 级声明式黑白名单 | ✅ [读源码] `requireApproval` (顶层+per-tool 覆盖); `requireReadBeforeWrite`; `readOnly` 模式 | 🟡 [读源码] `interrupt()` + `Command resume` 实现 HITL; 黑白名单/path 粒度需写在节点内 | ⚠️ [读源码] 仅 `HumanCallback.onHumanConfirm` 单点确认; 无黑白名单/path 粒度 | 🟡 [读源码] 核心无 permission popup (设计哲学拒绝); 仅 `beforeToolCall {block,reason}`; 权限策略由 extension 自实现 | ✅ [读源码] 三层 ruleset (default+agent+user); wildcard match + allow/ask/deny; plan agent 硬编码 `edit:deny` | ✅ [读源码] FilesystemPermission: operations × glob paths × mode allow/deny; first-match-wins; subagent 独立覆盖 |
| 11. Memory | ❌ [未亲测] grep 仅 runtime context/tool context; 无 short/long-term memory 抽象 | 🟡 [读文档] memory_recall 事件 + memory_paths + CLAUDE.md 自动加载 + sessionStore 可插拔; 无结构化 long-term API | 🟡 [读源码] `Session` 接口可插拔 (Memory + Prisma 示例); 跨会话靠 Session 管理; 无长期/语义记忆 | ✅ [读源码] working+semantic+observational+history processors + 可插拔 storage (libsql/pg/mongo/dynamo/clickhouse) | ✅ [读源码] 短期 Checkpointer (thread 级) + 长期 BaseStore (跨 thread); Memory/SQLite/Postgres/Mongo/Redis 后端 | 🟡 [读源码] `EkoMemory` + `TaskContext.variables`; 长期/跨会话靠业务实现 `ChatService.loadMessages` | 🟡 [读源码] 仅会话级 jsonl + SessionManager + fork/resume/tree; 无跨会话 long-term 抽象 | ⚠️ [读源码] 无独立长期 memory; session 持久化到 SQLite; "记忆"靠 `AGENTS.md` 文件约定 | ✅ [读源码] 短期 StateBackend / 长期 StoreBackend / ContextHubBackend (LangSmith); checkpointer + BaseStore + AGENTS.md 加载 |
| 12. streamText | ✅ [读源码] `streamText` 多路 tee (textStream/fullStream/partialOutput/uiMessageStream/elementStream); `@ai-sdk/react useChat` | ✅ [读源码] `query()` AsyncIterable; structured output 支持; 流式 partial messages | ✅ [读源码] `StreamedRunResult` + RunStream/Raw/Item events; text/tool/reasoning 流; structured output via `outputType` | ✅ [读源码] `MastraModelOutput`: text/tool call/reasoning/file/structuredOutput/data-* 自定义 chunks | ✅ [读源码] `streamMode` 七选: values/updates/messages/checkpoints/tasks/custom/tools/debug; messages-v2 token 级 | ✅ [读源码] `LLMStreamMessage` 覆盖 text/thinking/tool_*/file/finish/error; Stream Planning | ✅ [读源码] `AssistantMessageEvent`: text/thinking/toolcall 各 start/delta/end; TUI 差分渲染 | ✅ [读源码] 直接用 AI SDK `streamText`; native runtime + ai-sdk runtime; 流上 text/reasoning/tool-call/file part | ✅ [读源码] v3 stream API: run.messages.text/reasoning + run.toolCalls.input/output + run.subagents; AsyncIterable; 无 Generative UI |
| 13. 底层灵活性 | 🟡 [读源码] `LanguageModelV4` 可自实现; message 协议固化; 主循环 (52K+91K) 不可换 | ❌ [读文档] CLI subprocess wrapper; loop/model client/message 协议在二进制; 仅能换 `pathToClaudeCodeExecutable` | 🟡 [读源码] ModelProvider/Session 可换; runner/runLoop.ts + turnResolution.ts 不暴露替换点; 改 loop 只能 fork | 🟡 [读源码] 主 loop 写死 (workflowLoopStream); 可换 model client + processLLMRequest + Memory 后端 | ✅ [读源码] 显式 Pregel + Channels + 自定义 reducer + 自由换 ChatModel; **核心卖点** | 🟡 [读源码] 主循环 `runWithContext` 写死; 可 `callWithReAct` 自拼 ReAct + ProviderV2 换 model | ✅ [读源码] 自定义 `streamFn` 替主 loop; `convertToLlm` 控 message 协议; `registerProvider.streamSimple` 替整个 LLM client | ⚠️ [读源码] 主循环/消息 schema/Effect 服务全内置; 不能换 message 协议; plugin 可替 chat params/sys/messages, loop 本体不开放 | 🟡 [读源码] 主循环 langchain `createAgent` **不可换**; model 可换; backend 可换 (5+ 实现); message 协议绑 LangChain BaseMessage |
| 14. A. 插件形状 ★ | 🟡 [读源码] hook=`experimental_onStart/onStepStart/onToolExecutionStart/End/onStepFinish/onFinish` + middleware; 无 PreCompact/Notification/Stop; 进程内组合; 无分发/隔离 | ✅ [读文档] **Hook 极齐**: PreToolUse/PostToolUse/Stop/Notification/UserPromptSubmit/SessionStart/SubagentStop/ConfigChange/TeammateIdle/TaskCompleted; PostToolUse 可改 tool 返回 | 🟡 [读源码] lifecycle hook (agent_start/end + tool_start/end + handoff) + Guardrail/Input/Output 拦截; 无 PreToolUse/Compact/Notification; 无插件分发 | 🟡 [读源码] Processor 钩子细 (Input/InputStep/LLMRequest/Response/OutputStream/Step/Result/APIError); 但无 PreToolUse 命名; 无插件分发 | 🟡 [读源码] 无标准 PreToolUse 标签; ReactAgent `preModelHook/postModelHook` (限 react); 通用扩展靠 graph node + `interruptBefore/After` + callbacks | ❌ [读源码] 无 PreToolUse/PostToolUse/Stop/Compact/Notification; 仅 `AgentStreamCallback.onMessage` + `HumanCallback` 通知式; 扩展全靠 OOP 子类化 | ✅ [读源码] **24+ hook**: resources_discover/session_before_compact/fork/switch/tree/before_agent_start/context/before+after_provider_*/turn_start/end/message_*/tool_execution_*/tool_call/result/user_bash/input; `ExtensionContext` 隔离 | ✅ [读源码] TS 函数式 (`Plugin=(input,options)=>Hooks`); 11 hooks (tool.execute.before/after, chat.params/message/headers, experimental.* compacting/auto/transform/text, command.execute.before, shell.env, permission.ask) + tool/auth/provider/event 扩展 + `TuiPlugin` | 🟡 [读源码] **仅 4 hook**: beforeAgent/afterAgent/wrapModelCall/wrapToolCall; 无 Compact/Notification/PreToolUse 命名; 无 manifest 分发; 无沙箱隔离 |
| 15. B. 开发者体验 | ✅ [读源码] 全仓 TS 强类型 + `InferToolInput/Output`; 文档站 ai-sdk.dev; 37k+ tests; AISDKError marker pattern | 🟡 [读文档] 类型完备 (peerDeps); 文档官方覆盖全; 0.x 版本 breaking 多 (如 v0.3.142 移除 v2 session); 上手中等 | ✅ [读源码+文档] TS 类型完备 (zod-first); 文档站 Astro/Starlight + quickstart; 14 类错误细分; 0.11.x; Sandbox 仍 beta | ✅ [读源码] 严格 TS + Zod/Standard-Schema; tsup 多入口 (`@mastra/core` 50+ 子路径); AGENTS.md/CLAUDE.md/.mastracode/ 完整 | 🟡 [读源码] 类型完备 (Zod/Annotation 双轨); 文档全; StateGraph/Channels/Annotation 概念多, 上手陡; `BaseLangGraphError` 体系 | 🟡 [读文档+源码] TS 全类型 + d.ts; README 简洁但 API doc 站独立; 3.x→4.0 频繁 break; 错误以 `Log.error` 字符串为主 | ✅ [读文档] 类型完备 (无 any); tsgo+biome 强制 check; 26 docs/*.md; CHANGELOG 详尽; 0.75.5 快速迭代; 70+ examples | ✅ [读源码] `@opencode-ai/plugin` 独立包 + 完整 TS 类型 + 内置 `tool()` helper + 内置 skill 教学; 含 `@deprecated` 标记 | ✅ [读源码] 1.10.2 stable + MIT; 100% TS + JSDoc + d.ts; `ConfigurationError` 命名; README + langchain 官方 docs + 12+ examples |
| 16. C. 工作区抽象 ★ | ⚠️ [读源码] 仅 `experimental_sandbox` 透传 tool execute; 无 Workspace/Session/Project/fs/cwd 概念; 全靠用户自拼 | ✅ [读文档] `cwd` 选项 + `settingSources` [user/project/local] 三层 + `additionalDirectories` + Session API + projectKey/sessionId/subpath 三段 key | ✅ [读源码] **SandboxAgent 一等公民** (Manifest/Capability/runAs/defaultManifest); entries: gitRepo/localDir/mount; `WorkspacePathPolicy` + posix 校验; cwd binding + `UnixLocalSandboxClient` | ✅ [读源码] **Workspace 类原生** + LocalFilesystem + LocalSandbox (cwd binding) + skills + BM25/vector + readOnly + 安全控制 | 🟡 [读源码] `thread_id/checkpoint_ns/checkpoint_id` 三级命名空间 + assistants/runs/store namespace; 无 fs/cwd/Project 一等公民 | ❌ [读源码] core 无 Workspace/Project/cwd; BrowserAgent 自带浏览器上下文; FileAgent 仅 example; 路径靠业务字符串 | ✅ [读源码] `AgentSessionRuntime` 显式 cwd 绑定; `SessionManager.getCwd()`; 跨进程 jsonl 持久化保留 cwd; 启动 `assertSessionCwdExists`; fork/switchSession 支持 cwdOverride | ✅ [读源码] **四层**: Project (sandboxes[])/Workspace/Session/cwd; plugin input 直拿 directory/worktree; `experimental_workspace.register` 自定义 workspace 类型 (folder/git/remote) | ✅ [读源码] **Workspace = backend (5 实现: State/Store/Filesystem/Composite/ContextHub + LocalShell/Sandbox)**; cwd via rootDir; Session = LangGraph thread_id + checkpointer |

### 4.2 第二章：生产就绪（9 × 9）

| 维度 \ 候选 | ai | claude-agent-sdk | openai-agents-js | mastra | langgraphjs | eko | pi | opencode | **DeepAgents** |
|---|---|---|---|---|---|---|---|---|---|
| 17. Tracing | ✅ [读文档] `@ai-sdk/otel` 遵循 OTel GenAI Semantic Conventions; 12+ 集成 (langsmith/langfuse/helicone/weave/traceloop/...) | ✅ [读文档] 原生 OTel trace context propagation; active trace 透传给 CLI subprocess; 未提 LangSmith/Langfuse | ✅ [读源码+文档] 自带 Trace/Span + BatchProcessor + OpenAITracingExporter + `addTraceProcessor`; AgentOps/Respan/PromptLayer 集成; 非 OTel 原生 | ✅ [读源码] 一等 OTel + 官方适配 langfuse/langsmith/arize/arthur/braintrust/datadog/laminar/posthog/sentry/clickhouse | ✅ [读源码] LangSmith 一等公民; LangGraph Server 自动注入 trace; OTel/Langfuse 需走 callbacks 自接 | ❌ [读源码] 全仓无 OTel/LangSmith/Langfuse/Helicone; 仅内置 `Log`; 观测靠 `callback.onMessage` | ❌ [读源码] 无 OTel/LangSmith/Langfuse 集成; install telemetry on/off + jsonl session 文件可作离线 trace; 需 extension 自接 | 🟡 [读源码] 内置 OTel: `experimental_telemetry` 通过 AI SDK + `@effect/opentelemetry`; 无 LangSmith/Langfuse 一等支持 | ✅ [读源码] **LangSmith first-class** (agent metadata ls_integration:"deepagents" + ContextHubBackend 直接调 LangSmith Client); 无 OTel/Langfuse/Helicone 原生 |
| 18. 错误/限流 | 🟡 [读源码] `maxRetries` + 指数回退; 无内置 rate-limit/quota/cost; 需外部 (upstash 等示例) | ✅ [读文档] `api_retry` 系统消息 + `taskBudget` + `--max-budget-usd` + `error_max_budget_usd` + `resume` 断点续 | ✅ [读源码+文档] `ModelRetrySettings` + `retryPolicies` (networkError/httpStatus/retryAfter/...); `Usage` token 跟踪; `RunState.toString/fromString` 跨进程; 无内置 cost ceiling | ✅ [读源码] p-retry + `CostGuard` / `TokenLimiter` / `processAPIError` 自定义重试 + signals | 🟡 [读源码] 节点级 `RetryPolicy` + Checkpointer 断点续; 无原生 rate-limit/cost | 🟡 [读源码] `maxRetryNum=3` 指数退避 `200*(n+1)²ms`; `RetryLanguageModel` 跨多 LLM fallback; 无 cost; 中断恢复靠 task_snapshot | ✅ [读源码] `StreamOptions` 内置 maxRetries/maxRetryDelayMs (默认 60s)/timeoutMs/SDK retry + abort; `stopReason="error"/"aborted"` + errorMessage + diagnostics[] | ✅ [读源码] `session/retry.ts` 解析 retry-after-ms/retry-after/Anthropic rate_limit; 区分 free_tier_limit vs account_rate_limit; SQLite 中断恢复 | ⚠️ [读源码] 仅 `ConfigurationError`; rate limit/cost/自动重试/断点续 全部依赖底层 langchain + LangGraph 平台 |
| 19. Schema | ✅ [读源码] `zodSchema` (v3+v4) + jsonSchema + valibot + FlexibleSchema; `streamObject` 流式 partial parse | ✅ [读文档] Zod ^3.24.1/^4.0.0 双 peer; structured outputs 验证 JSON schema | ✅ [读源码] `tool({parameters:z.object()})` Zod 一等; JsonSchemaDefinition; outputType zod/JSON; 无 TypeBox | ✅ [读源码] Standard-Schema spec 一等 (Zod 3/4 + Ajv); structured output 流式 | ✅ [读源码] Annotation + Zod 双轨原生; `responseFormat` 支持 Zod/JSON Schema 流式 structured output | 🟡 [读源码] Tool.parameters 用 JSONSchema7; package 含 zod v4 依赖但代码未直接用 Zod 校验; 无 generateObject 流式 | ✅ [读源码] 一律 typebox (TSchema/Static) + StringEnum helper; 可在 eval-restricted runtime (CF Workers) 跑 | ✅ [读源码] 内部 Effect Schema; 外部 plugin 工具 args 用 Zod; structured output 走 AI SDK `generateObject/streamObject` | ✅ [读源码] Zod (v3+v4) 内建; `responseFormat` 支持 Zod/ToolStrategy/ProviderStrategy/TypedToolStrategy; structured output subagent+main 均可 |
| 20. 持久化/恢复 | ⚠️ [读源码] UI stream resume hint; `@ai-sdk/workflow WorkflowAgent` "durable" 是 workflow step 实现, 非 SDK checkpoint | ✅ [读源码] `sessionStore` (alpha) + InMemorySessionStore + importSessionToStore; S3/Redis/Postgres reference adapters; resume/forkSession/listSessions/renameSession/tagSession 全 API | ✅ [读源码] Session 接口 + Prisma 示例; `RunState` 序列化跨进程恢复 | ✅ [读源码] `DurableAgent` + workflows suspend/resume + 30+ storage 后端 + resumeStream/resumeGenerate/suspendPayload | ✅ [读源码] **Checkpointer 核心架构**; 每 superstep 写 checkpoint; resume/跨进程/time-travel; Memory/SQLite/Postgres/Mongo/Redis | 🟡 [读源码] `pauseTask` + resume-pause + task_snapshot; 跨进程要业务自己持久化 EkoMemory.import + ChatService | ✅ [读源码] jsonl 全量 entry 落盘 (每 turn append) + tree 结构 fork/branch; `pi -c` resume / `-r` browse / `--session/--fork`; 跨进程恢复无问题 | ✅ [读源码] SQLite (Drizzle) 落 session/permission/message; JSON migration; task tool 内置 task_id resume; server 常驻可重连 | ✅ [读源码] LangGraph BaseCheckpointSaver (MemorySaver/Postgres/Sqlite) + BaseStore; /conversation_history/{thread_id}.md 跨进程 |
| 21. 多模态 | ✅ [读源码/文档] FilePart/ImagePart + provider reference 跨 provider; generateImage/transcribe/generateSpeech/generateVideo 一等 | 🟡 [读文档] FileReadToolInput 支持 PDF `pages` + parts 输出; 未提及 audio/video 原生 | ✅ [读源码] InputText/Image/File; 独立 `@openai/agents-realtime` 包 WebRTC/WebSocket/SIP voice; examples/realtime-twilio | ✅ [读源码] image/file/audio chunks 内置; voice 子目录 9 家 provider (aws-nova/azure/deepgram/elevenlabs/openai-realtime/gemini-live) | ✅ [看 demo] examples/ui-multimodal/ 完整 demo: image gen + audio narration; message v2 转换器支持 image/audio/file 类型 | 🟡 [读源码] 输入支持 image/file (LanguageModelV2FilePart); tool result 可返回 image base64; audio/video 无原生输入抽象 | 🟡 [读源码] text + image (base64) 一等; input/output 都可带 image; 无 audio/video/通用 file 抽象 (file 走 read tool) | 🟡 [读源码] schema 定义 modalities text/audio/image/video/pdf; FilePart 支持 mime+url+source; 实际栈以 text+image+file 为主 | 🟡 [读源码] 文件自动转 `{type:image/audio, mimeType, data:base64}` ContentBlock; ACP `promptCapabilities:{image:true, audio:false}`; video 未见 |
| 22. 测试/Eval | 🟡 [读源码] `mock-language-model-v4/mock-provider-v4/mock-sandbox` 齐套 mock 便于 unit test; 无质量评估/replay/回归; 依赖外部 (evalite/promptfoo) | ⚠️ [读文档] 仅 examples sessionStore conformance harness; SDK 无 quality eval/mock&replay; 需自拼 | ⚠️ [读源码] 仅 helpers/tests (console-guard/setup) 为自身 vitest; 未导出 mock harness/eval; 需自拼 | ✅ [读源码] `@mastra/evals` scorers (code/llm/prebuilt) + scoreTraces + `ON_SCORER_RUN` hook + datasets/experiment | ✅ [读源码] time-travel debugging via `getStateHistory` + checkpoint resume; eval 走 LangSmith; FakeTracer 测试 | ❌ [读源码] 仅 jest 单测覆盖 core; 无 eval/mock&replay/回归框架 | 🟡 [读源码] `providers/faux.ts` faux provider for mock LLM; harness.ts + faux 跑回归; HF dataset 分享真实 session; 无内置 LLM-judge/score | ⚠️ [未亲测] 仓库有 `packages/opencode/test/` + fake/fixture mock 用 Bun test; 无内置 eval/benchmark/replay | ✅ [读源码] **完整 evals workspace**: basic/files/followup-quality/hitl/memory/oolong/skills/subagents/summarization/tau2-airline/todos 等 16 个 suite; langsmith/vitest |
| 23. 部署模式 | ✅ [读文档] Node/Edge/Browser (vitest.edge+node); examples 覆盖 next/hono/fastify/express/sveltekit/nuxt/nest | ✅ [读文档] Node 18+; CLI subprocess; Bun `--compile` 单二进制 + `/extract` export; self-host/容器友好; edge/serverless 受限 (native binary) | ✅ [读源码+文档] Node 22+/Deno/Bun; CF Workers 实验; 扩展含 Cloudflare/Blaxel/Daytona/E2B/Modal/Runloop/Vercel sandbox | ✅ [读源码] deployers/: cloud/cloudflare/netlify/vercel; server-adapters: express/fastify/hono/koa/nestjs; standalone server | ✅ [读文档] 三档: OSS self-host / LangGraph Platform / Studio; langgraph-cli + langgraph-api 自部署 server | ✅ [读文档+源码] core 纯 JS; 支持 Node.js + browser extension + Web + Edge 兼容 (依赖 @ai-sdk/provider) | ✅ [读源码] CLI (node+bun binary 双形态) + interactive TUI + `-p print` + `--mode json` + `--mode rpc` (LF-JSONL stdio RPC for 非 Node 集成) + SDK 嵌入 | ✅ [读源码] CLI (`npm i -g opencode-ai`) + Desktop (Electron) + 内嵌 Hono server (localhost:4096) + Dockerfile + Slack/Web/Console adapter | 🟡 [读源码] 主要 self-host (Node.js); ACP 服务 stdio CLI; LangGraph Platform 远端 (AsyncSubAgent); 无 edge/serverless 原生 |
| 24. License | ✅ [读源码] Apache 2.0; 各子包 `"license":"Apache-2.0"`; 无商用限制 | ⚠️ [读文档] **Anthropic 私有 + Commercial Terms of Service**; 非 MIT/Apache; 自部署需遵守 Anthropic 商用条款 | ✅ [读文档] MIT 单 license 无商用门槛; OpenAI 版权 | 🟡 [读文档] Apache-2.0 主体 + `ee/` 目录 Mastra Enterprise License; 生产用 EE 功能需许可 | ✅ [读源码] MIT; 商用无限制; 自部署门槛低; Platform 是 LangChain 商业产品另算 | ✅ [读文档] MIT 无商用限制/双 license | ✅ [读文档] MIT 所有包统一; 无 CLA; 商用零限制; 但 lgtm gate 严 | ✅ [读源码] MIT 无商用限制 | ✅ [读文档] MIT (LangChain, Inc.); 纯库无 SaaS 强绑定; 自部署零门槛 |
| 25. 社区/维护 | ✅ [读文档] Vercel 官方; 4.0.0-canary 高频迭代; 35+ provider 包持续更新; docs 站完整 | ✅ [读文档] 版本节奏极频繁 (0.1.0→0.3.150 数百版本); Discord 官方; 维护强度顶级 | 🟡 [读源码] OpenAI 官方维护; 包版本 0.11.5; 本 clone shallow 看不出频率; npm 上活跃发布 | ✅ [读文档] YC W25; npm 活跃 (`@mastra/core 1.37.0-alpha.4`); changesets workflow; 80+ 子包 | ✅ [读文档] LangChain 大社区; Klarna/Uber/Replit/LinkedIn/GitLab 生产案例; clone shallow 无法判频率 | ⚠️ [未亲测] 本地 1 commit (v4.1.3); README 显示 2025-11 4.0 更新; 无 CHANGELOG | ⚠️ [读文档] 维护极活跃 (lockstep 0.75.5/CHANGELOG 每周); **新 issue/PR 默认自动关闭**; lgtm gate 准入; 社区门槛极高 | ✅ [读文档] npm `opencode-ai` 持续发布 (plugin v1.15.10); 多语言 README 30+; 活跃 Discord + docs.opencode.ai | ✅ [读文档] LangChain 官方维护; CHANGELOG 7+ 贡献者活跃; 1.10.2 当下; 6 月内 1.9→1.10; docs.langchain.com 官方 |

### 4.3 第三章：场景适配（2 × 9）

| 维度 \ 候选 | ai | claude-agent-sdk | openai-agents-js | mastra | langgraphjs | eko | pi | opencode | **DeepAgents** |
|---|---|---|---|---|---|---|---|---|---|
| 26. ACP / A2A | ❌ [读源码] grep `ACP/A2A/handoff` 在 packages+content 无匹配; agent 间互通需 tool/HTTP 自拼 | ❌ [读文档] CHANGELOG 全文无 ACP/A2A; subagent 是私有内嵌 | ❌ [未亲测] grep 全仓无 ACP/A2A; 跨 SDK 互通仅通过 MCP/OpenAI Responses | ✅ [读源码] 原生 `@a2a-js/sdk` 集成 + a2a-agent.ts (1.5K 行); `packages/acp/` 子包存在 | ❌ [未亲测] grep ACP/A2A 零匹配; 多 agent 互通靠 supervisor/swarm/handoff; 无开放协议 | 🟡 [读源码] README 标 Native A2A "Coming soon"; 代码已有 `IA2aClient.listAgents` 骨架 (含 TODO); runtime `mergeAgents` 拼到任务 | ❌ [读源码] 无 ACP/A2A 协议; 仅自家 RPC mode (JSONL stdio) + subagent extension (spawn pi 进程) | ✅ [读源码] 内置 `@agentclientprotocol/sdk`; acp/agent.ts 完整 ACP 接口 (Initialize/NewSession/Prompt/Permission/Fork/ListSessions); 可被 Zed 调用 | ✅ [读源码] **`deepagents-acp` 包基于 @agentclientprotocol/sdk 实现 ACP server** (session/new/load/prompt + auth + plan + tool call kinds); 可对接 Zed/JetBrains/Neovim |
| 27. 安全沙箱 | ⚠️ [读源码] `experimental_sandbox` 把执行交给外部 (Vercel Sandbox); tool 隔离靠 user-approval; 无 prompt injection 检测/脱敏/secret | ✅ [读文档] `sandbox` 选项 + `failIfUnavailable` + `allowDangerouslySkipPermissions` + bypass-immune `.claude/skills/{name}/` 写保护 + PermissionRequest hook; prompt injection/secret 未单独 | ✅ [读源码] SandboxAgent + UnixLocal/Docker/CF/E2B/Modal 隔离 + POSIX Permissions + `Environment.ephemeral` secret + Guardrail 防 prompt injection + archive limits 防 zip bomb | ✅ [读源码] PromptInjectionDetector + Moderation + PII + SystemPromptScrubber + Unicode-normalizer + RegexFilter; LocalSandbox 工具隔离 + readOnly + requireApproval | ❌ [读源码] 无原生 tool 隔离/prompt injection 防御/secret; 仅 `sanitizeUntrackedValuesInSend` (序列化清理非安全沙箱) | ⚠️ [读文档+源码] 醒目警告 "DO NOT use API Keys in browser"; apiKey 函数式动态注入; 无 tool 隔离/脱敏/secret; nodejs BrowserAgent 默认带 `--no-sandbox` 弱安全 flags | 🟡 [读源码] 核心无内置沙箱 ("Run in a container" 哲学); examples/extensions/sandbox 用 `@anthropic-ai/sandbox-runtime` (sandbox-exec/bubblewrap); secret 走 env + AuthStorage; 供应链 pin+min-release-age+audit | ✅ [读源码] plan agent 硬编码 deny edit + `doom_loop` 权限防无限工具循环 + `read.*.env:ask` 保护 secret + `.gitleaksignore` + `external_directory` 限制; 工具跑本进程无 OS 级隔离 | ✅ [读源码] **5 sandbox provider 包**: daytona/deno/modal/node-vfs/quickjs; BaseSandbox 抽象类供自实现 |

---

## 4.4 ★ 维度横向对比（Chunk 3 B 段：校准两个关键维度）

> 决策权重最高的两个维度：**14（插件机制形状）** + **16（工作区抽象）**。
> 单元格只看一行不够，这里按"等级"重排，并给出"为什么打这一档"的横向标准。

### 4.4.1 维度 14：插件机制形状

| 等级 | 候选 | 标准化关键证据 |
|---|---|---|
| ✅ 最强 | **claude-agent-sdk** | **Hook 命名最标准**：PreToolUse / PostToolUse / Stop / Notification / UserPromptSubmit / SessionStart / SubagentStop / ConfigChange / TeammateIdle / TaskCompleted 10+；PostToolUse 还能改 tool 返回。生态对齐 Claude Code，开箱即用 |
| ✅ 最强 | **pi** | **种类最多**：24+ hook 覆盖 session/turn/message/tool_execution/provider_request 全生命周期；ExtensionContext 隔离；TypeScript 默认导出函数即可加载 |
| ✅ 最强 | **opencode** | **类型最完整**：Plugin 是 `(input,opts)=>Promise<Hooks>` 类型签名；11 hook + 4 扩展对象 (tool/auth/provider/event) + **独立 TuiPlugin**（slot/keymap/dialog/route）—— 唯一同时覆盖 UI 层的候选 |
| 🟡 中 | **mastra** | Processor 钩子细 (Input/InputStep/LLMRequest/Response/OutputStream/Step/Result/APIError)，但**无 PreToolUse 命名**；工具拦截要走 processInputStep 重写 tools 列表 |
| 🟡 中 | **langgraphjs** | 无标准 hook 标签；ReactAgent 有 `preModelHook/postModelHook` 但**仅限 react 节点**；通用扩展靠 graph node + `interruptBefore/After` + LangChain callbacks |
| 🟡 中 | **openai-agents-js** | lifecycle hook (agent_start/end, tool_start/end, handoff) + Guardrail/Input/Output 拦截；**无 PreToolUse/Compact/Notification**；无插件分发协议 |
| 🟡 中 | **ai (Vercel)** | `experimental_onStart/onStepStart/onToolExecutionStart/End/onStepFinish/onFinish` + middleware；**无 PreCompact/Notification/Stop**；进程内组合，无分发/隔离 |
| 🟡 中 | **DeepAgents** (Chunk 6) | **仅 4 个 LangChain middleware hook**：beforeAgent / afterAgent / wrapModelCall / wrapToolCall；无 PreToolUse/Compact/Notification 命名；无 manifest 分发；无进程沙箱隔离；plugin = LangGraph + middleware 学习曲线 |
| ❌ 弱 | **eko** | 无任何 PreToolUse 类 hook；仅 `AgentStreamCallback.onMessage` + `HumanCallback` 通知式；扩展全靠 OOP 子类化 |

**关键结论**：三个 ✅ 最强等级（claude-agent-sdk / pi / opencode）**都是为产品扩展而设计**的 hook 体系。差异点：
- **claude-agent-sdk** = Hook 命名最标准 + 文档最全，**但 loop 在二进制不可改**（绑死 Anthropic）
- **pi** = Hook 数量最多 + ExtensionContext 隔离 + 真实产品 dogfooding（pi-coding-agent 就是用 extension 扩出来的）
- **opencode** = 类型最完整 + 独有 TuiPlugin UI 扩展通道；但 plugin 跑主进程**无沙箱隔离**

### 4.4.2 维度 16：工作区抽象

| 等级 | 候选 | 标准化关键证据 |
|---|---|---|
| ✅ 最强 | **opencode** | **四层显式 abstraction**：Project (sandboxes[]) / Workspace / Session / cwd；plugin input 直拿 `directory/worktree`；`experimental_workspace.register` 允许插件自定义 workspace 类型 (folder/git/remote) |
| ✅ 强 | **openai-agents-js** | **Sandbox-first**：SandboxAgent 一等公民 (Manifest/Capability/runAs/defaultManifest)；entries 含 gitRepo/localDir/mount；`WorkspacePathPolicy` + posix 校验；cwd binding + `UnixLocalSandboxClient` |
| ✅ 强 | **pi** | **cwd-centric 最简洁**：`AgentSessionRuntime` 显式 cwd 绑定；`SessionManager.getCwd()`；跨进程 jsonl 持久化保留 cwd；启动 `assertSessionCwdExists`；fork/switchSession 支持 cwdOverride |
| ✅ 强 | **claude-agent-sdk** | `cwd` 选项 + `settingSources: ['user','project','local']` 三层 + `additionalDirectories` + Session API + `projectKey/sessionId/subpath` 三段 key |
| ✅ 强 | **mastra** | Workspace 类原生 + LocalFilesystem + LocalSandbox (cwd binding) + skills + BM25/vector + readOnly + 安全控制 |
| ✅ 强 | **DeepAgents** (Chunk 6) | **Workspace = backend (5 实现)**：State / Store / Filesystem (ripgrep + virtualMode + symlink 防护) / Composite / ContextHub (LangSmith Hub)；cwd via `rootDir`；Session = LangGraph thread_id + checkpointer；Project 通过 `findProjectRoot` |
| 🟡 中 | **langgraphjs** | `thread_id/checkpoint_ns/checkpoint_id` 三级命名空间 + assistants/runs/store namespace；**无 fs/cwd/Project 一等公民**，要走 BaseStore 自构造 |
| ⚠️ 弱 | **ai (Vercel)** | 仅 `experimental_sandbox` 透传 tool execute；**无 Workspace/Session/Project/fs/cwd 概念**；全靠用户自拼 |
| ❌ 弱 | **eko** | core 无 Workspace/Project/cwd；BrowserAgent 自带浏览器上下文；**FileAgent 仅 example**；路径靠业务字符串传入 |

**关键结论**：六个 ✅ 等级（含 DeepAgents）**侧重不同**：
- **opencode** = 四层显式 abstraction，**最适合做产品**（用户场景首选）
- **openai-agents-js** = Sandbox-first，**最适合做安全敏感场景**（Manifest/Capability 抽象）
- **pi** = cwd-centric 最简洁，**最适合 lightweight harness**
- **claude-agent-sdk** = settingSources 三层 + Session 全 API，**最适合多用户产品**
- **mastra** = Workspace + LocalSandbox + 搜索/RAG **一体化**
- **DeepAgents** (Chunk 6) = **backend 抽象最灵活**（5 实现 + ContextHub LangSmith 后端），适合接多种 fs 后端 / 远端 LangGraph 平台

ai 和 eko 都是"零工作区抽象"，做这种产品要自己重新发明轮子。

---

## 4.5 整体定位修正汇总（agent 实操反馈）

> 8 个 opus Explore agent 调研后的"定位偏差/重要发现"，与 §2.1 候选卡片合读

| 候选 | 关键定位修正 |
|---|---|
| **ai** (Vercel) | 已进化出 `ToolLoopAgent` + `@ai-sdk/workflow` 显式 agent 类，不再只是 streamText 原语；`uploadSkill` 是把 bundle 上传到 provider 端**让 provider 执行**（Anthropic Skills API），**非 Claude Code 式本地 Skill 触发**——非常容易误读 |
| **claude-agent-sdk** | **SDK = CLI subprocess 包装器**，主循环在 Claude Code 二进制内不可换；provider 仅 Anthropic+Foundry；Hook 粒度业内最全 + Skills/MCP/SessionStore 一等公民。是"用 Claude Code 能力做产品"而非"通用 agent framework" |
| **openai-agents-js** | Sandbox + Skills 一等公民 + Manifest/Capability 抽象成熟；**插件机制弱**（仅 lifecycle hook + Guardrail），主循环不开放注入 |
| **mastra** | 27 维度里**最"重"的 TS 框架**：Workspace + Skills + Sandbox + Durable + 双向 MCP + A2A + 50+ 子包，几乎对标 Claude Agent SDK 所有能力 + Workflow DSL；但**底层主 loop 不可换**、无统一 plugin 分发是短板 |
| **langgraphjs** | 是 **agent 编译器**而非 agent runtime；上层 ReactAgent/DeepAgents/Supervisor 全建在 Pregel/Channel/Checkpointer/Graph 四层之上；**MCP 零原生支持、无 skill 概念**——离工作区 coding agent 距离最远 |
| **eko** | "**自然语言 → 依赖图工作流**"框架（Planner+并行 Agent+原生 MCP+pause/resume），浏览器+Node 跨端；**生产可观测/扩展机制偏弱，无 hook/skill 体系**；不太像 Claude-Code-like 候选 |
| **pi** | 极简 core (~500 行 loop) + 24 hook 插件系统 + skill 标准化的 coding agent harness；**作者刻意拒绝 MCP/sub-agents/permission popup/tracing/memory**（全要 extension）；社区门槛极高（自动关 issue + lgtm gate）；**核心吸引力是 `pi-agent-core` 极简 loop + `pi-ai` 多 provider 统一**，但 MCP/tracing/sub-agent/sandbox 都要自己拼 |
| **opencode** | end-product **意外提供了高完成度 plugin TypeScript API**——这是它和 Continue/Aider 等纯产品的本质区别。**plugin 在主进程内执行无沙箱隔离**；Effect-TS 重耦合贯穿全栈，二次开发上手成本高；建议**定位为"产品 + plugin API"而非纯 SDK** |
| **DeepAgents** (Chunk 6) | "**LangGraph 生态内 batteries-included harness**"，覆盖度全场最高（filesystem/skills/subagent/sandbox/ACP/eval/tracing 全打满），**ACP server + 5 sandbox 是杀手锏**（可被 Zed/JetBrains/Neovim 调用）；但 **MCP 零原生**、hook 仍是 langchain 4 个粒度、**完全锁死 LangChain/LangGraph 栈**；适合 IDE/coding-agent 类，不适合 MCP-first 或想脱离 LangChain 的场景 |

---

## 5. 推荐 & 备选

> 基于 §4 矩阵 + §4.4 ★ 维度横向对比 + §4.5 定位修正汇总。本推荐**保持开放**——后续实际试跑如出现反证，会及时调整本节。

### 5.1 主推：pi（`pi-agent-core` + `pi-ai`）

**核心论点**：pi 的"**刻意拒绝**"恰好符合用户的"**底层不对外暴露 + 扩展走插件机制**"——core 保持极简（~500 行 loop）+ 缺的能力**自己实现为 extension** = 既保持长期控制权，又有标准化扩展面。

**与两个目标场景的对齐证据**：

| 目标场景 | pi 的契合证据 |
|---|---|
| 基于工作区的现成产品 | `pi-coding-agent` 本身就是参考实现；`AgentSessionRuntime` cwd 绑定 + jsonl 持久化 + fork/switch + cwdOverride 全套（§4.1 维度 16） |
| 底层不对外暴露 + 插件机制 | **24+ hook**（8 候选里最多）；`ExtensionContext` 隔离；`~/.pi/agent/extensions/` 自动加载 + `/reload` 热重载；业务方仅触达 hook 表面（§4.4.1） |
| TS 栈 | 全 TS（tsgo + biome 强制 check, 无 any）；70+ examples；CHANGELOG 详尽 |

**架构建议**：

- **基座 import** = `@earendil-works/pi-agent-core`（loop + state）+ `@earendil-works/pi-ai`（多 provider）
- **不直接用** `pi-coding-agent`——它是 end-product 参考；新项目应**自己实现产品层**，把 pi-agent-core 当核心引擎
- **不直接用** `pi-tui`——除非确定做 TUI；CLI / 桌面有更主流选择（commander / Ink / Electron）

**主推接受的短板**（用户应该提前知道）：

| 短板 | mitigation |
|---|---|
| **No MCP**（作者明确拒绝） | 写 extension 包装 `@modelcontextprotocol/sdk` 即可（约 200-400 行） |
| **No sub-agents**（核心拒绝） | 参考 `examples/extensions/subagent` 的 `child_process.spawn` 模式（max parallel=8, concurrency=4） |
| **No tracing**（无 OTel/LangSmith 集成） | 写 extension 接 OTel；或先用内置 jsonl session 文件作离线 trace |
| **No long-term memory** | 写 extension 集成 vector DB / embedding（参考 mastra 的 working/semantic memory 设计） |
| **社区门槛极高**（新 issue/PR 自动关闭 + lgtm gate） | 接受 self-supported；做好自己 fork 准备；好处：代码质量门槛高，依赖稳定 |
| **0.x 版本**（0.75.5） | lockstep 版本 + 每周 CHANGELOG；跟随成本可控但需纪律 |

---

### 5.2 备选：opencode（**或 DeepAgents — Chunk 6 加入的并列挑战者**）

> Chunk 6 加入 DeepAgents 后，备选位置出现"二选一"——按使用场景选不同备选

**两个备选的对决**（按场景选）：

| 你的场景偏好 | 选 | 关键理由 |
|---|---|---|
| 想 fork end-product 改造 / 看重 plugin **hook 完整度**（11 hook + TuiPlugin） / 容忍 Effect-TS | **opencode** | plugin 类型最完整 + TuiPlugin UI 扩展通道 + 主进程 server / Desktop / Slack adapter 多形态成熟 |
| 想 import library 自建产品 + **接 IDE (ACP server)** + 强 **sandbox** 需求 + 容忍 LangChain 生态绑定 | **DeepAgents** | ACP server first-class（被 Zed/JetBrains/Neovim 直接调用）+ 5 个 sandbox provider + filesystem/subagent/skill/plan/permission/HITL/sandbox/eval/tracing 覆盖度全场最高 |

---

**何时切换为 opencode**（决策触发条件，满足任一即考虑）：

- 你想要**现成的 plugin TypeScript API** 而非自己定义 hook 标准（pi 是函数式 hook，opencode 有完整类型签名）
- 你需要 **TuiPlugin**（独有的 UI 扩展通道：slot / keymap / dialog / route）
- 你需要 **ACP 原生支持**（可被 Zed 等 ACP client 调用，pi 无此能力）
- 你能接受 **Effect-TS 全栈耦合**（二次开发上手成本陡）

**对比 pi 的优势**：

| 维度 | pi | opencode |
|---|---|---|
| plugin 类型完整度 | 函数式 hook 24+ 种 | **TS 类型签名 + 11 hook + 4 扩展对象 (tool/auth/provider/event) + TuiPlugin** |
| 工作区抽象 | cwd-centric 简洁 | **四层显式 abstraction**（Project/Workspace/Session/cwd） |
| ACP / A2A | ❌ | **✅ 内置** @agentclientprotocol/sdk |
| Compact 策略 | 自动 + Goal/Progress/Decisions/NextSteps 结构化 summary | 自动 + PRUNE_MINIMUM=20K / skill 保护 |
| 部署形态 | CLI + JSON/RPC stdio + SDK | CLI + Desktop + Hono server + Slack/Web/Console adapter |

**为什么不主推**（opencode 的限制）：

- **Effect-TS 重耦合贯穿全栈** → 团队学习曲线陡（用户不熟 Effect 就是大坑）
- **plugin 在主进程内执行无沙箱隔离** → 安全敏感场景要自己加
- **主循环 `session/prompt.ts` (68KB) 深嵌不开放** → 不能像 pi 那样换 `streamFn`
- 体量大（end-product 60+ 包）→ fork 维护成本高

---

### 5.3 不推荐其他候选

| 候选 | 不推荐的核心理由 |
|---|---|
| **claude-agent-sdk** | CLI subprocess wrapper → 你的"底层"就是 Anthropic 二进制（绑死）+ **商业 license**（非开源）；与"底层不对外暴露 + 控制权"目标冲突 |
| **ai** (Vercel) | 太底层（无 workspace / skill / plugin 概念）；几乎所有 ★ 维度都要重新发明 → 工作量等于自己造半个 pi 还差 24 hook 体系 |
| **mastra** | YC 一站式框架（50+ 子包对标 Next.js+Prisma+Eval）；Processor 是为 workflow 链式编程而生不是为 plugin；`ee/` 目录 License 锁定风险（auth/agent-builder 等关键能力在内） |
| **langgraphjs** | 是 agent **编译器**而非 runtime；上层 ReactAgent/DeepAgents 才是 agent；**MCP 零原生支持**；离 Claude-Code-like 产品最远 |
| **openai-agents-js** | Sandbox-first 但 **plugin 弱**（仅 lifecycle hook + Guardrail，无 PreToolUse/Compact/Notification）；Sandbox Agent 仍 beta |
| **eko** | 无 hook 体系（仅 `onMessage` 通知式）+ 无 skill；扩展靠 OOP 子类化；定位是"自然语言 → 依赖图工作流"非 coding agent loop |
| **DeepAgents 为何不主推**（Chunk 6） | 覆盖度全场最高但 4 个硬张力：①**MCP 零原生**（主张你用 Skill 或自写 extension）；②**LangGraph 完全透出**——`createMiddleware`/`Command`/`messages` 都从 langchain import，用户可绕过 `createDeepAgent` 直接拼，跟"业务方仅接触插件接口"目标弱化；③**Hook 仅 4 个**（vs pi 24 / opencode 11），无 PreToolUse/Compact/Notification 命名；④**生态绑死** LangChain/LangGraph 全栈（学习曲线陡）。所以**只升备选不替主推** |

---

### 5.4 决策树（按"优先目标"分支）

```
新项目 coding agent 基座选型：

┌─ 优先 0→1 最快出 MVP（接受绑定 Anthropic + 商业 license）
│  └─ claude-agent-sdk
│     ├─ 优势：开箱即用全部 Claude Code 能力（Hook/Skill/MCP/SessionStore/Compact）
│     ├─ 代价：绑死 Anthropic 二进制；商业条款；主循环 / provider / message 协议都不可换
│     └─ 退路：将来想脱离时极困难（你已经在 Claude Code 生态深处）
│
├─ 优先长期控制权 + 扩展走插件机制 ← 用户场景默认选这个
│  └─ pi-agent-core + pi-ai（主推）
│     ├─ 自己实现：产品 UI 层 + 缺失能力（MCP/sub-agent/tracing/memory）以 extension 形式
│     ├─ 优势：极简核心 + 24 hook + cwd-centric + 干净 MIT + 完全可控
│     └─ 代价：前期工作量大（要自己拼 MCP/sub-agent/tracing 等）
│
├─ 优先现成 plugin 类型 API + UI 扩展通道
│  └─ opencode（备选 A）
│     ├─ 优势：plugin 类型最完整 + TuiPlugin + 四层 workspace
│     └─ 代价：Effect-TS 重耦合 + 主循环不可换 + 体量大
│
└─ 优先 IDE 集成 (ACP server) + 强 sandbox + 开箱即用
   └─ DeepAgents（备选 B — Chunk 6 加入）
      ├─ 优势：ACP server first-class (Zed/JetBrains/Neovim) + 5 sandbox provider + filesystem/subagent/skill/plan/permission/HITL/eval/tracing 全 first-class
      └─ 代价：MCP 零原生 + LangGraph 完全透出 (用户可绕过) + Hook 仅 4 个 + 绑死 LangChain 生态
```

### 5.5 未来需求 → pi 上的实现路径

| 未来需求 | 用 pi 的方案 | 参考来源 |
|---|---|---|
| 加 MCP 客户端 | 写 extension 包装 `@modelcontextprotocol/sdk` | opencode 的 `packages/opencode/src/mcp/` |
| 加 sub-agent | 用 `examples/extensions/subagent` spawn 模式 + 自加 supervisor | wanman 的 JSON-RPC 2.0 协调 |
| 加 Tracing (OTel/LangSmith) | 写 extension 接 OTel；先用 jsonl session 做离线 trace | mastra 的 observability 适配子包矩阵 |
| 加 long-term Memory | 写 extension 集成 vector DB；参考 working/semantic/observational 分层 | mastra 的 `@mastra/memory` 设计 |
| 加 ACP / A2A 协议 | 抄 opencode 的 `acp/agent.ts`（150 行内）或参考 DeepAgents 的 `libs/acp/src/server.ts` 完整 ACP server 实现 | opencode `packages/opencode/src/acp/` 或 DeepAgents `libs/acp/` |
| 加多 IDE / webview | 抄 cline 的 grpc-protobuf 模式 + 解耦 | cline `proto/cline/` + `src/generated/` |
| 加 Skill 体系 | pi 已内置（agentskills.io 规范）✓ | — |
| 加 Prompt 模板模块化 | 抄 cline 的 components/variants/template 模式 | cline `src/core/prompts/system-prompt/` |

---

### 5.6 评估完成后对 §0.2 / §0.3 目标的回顾

- 目标 1（基于工作区）：pi / opencode / claude-agent-sdk 都能满足，pi 最简洁
- 目标 2（底层不对外暴露 + 插件机制）：**pi 最纯粹**，opencode 第二，claude-agent-sdk 最受限（你的"底层"是别人家的二进制）
- TS 约束：8 候选全部满足 ✅

**结论**：在用户场景下，**pi 是唯一在"控制权 + 插件 + 工作区"三个维度都拿到最佳分**的候选；opencode 在 plugin 完整度上更强但代价是 Effect-TS 锁定；DeepAgents 在 IDE 集成 (ACP server) + sandbox + 开箱即用上是杀手锏但代价是 LangChain 锁定 + MCP 零；claude-agent-sdk 是"快但绑死"。

**Chunk 6 决策（DeepAgents 升候选后）**：保持 pi 主推不变；备选位置从"opencode 单选"变为"**opencode 或 DeepAgents 按场景二选**"（见 §5.2 决策表）。

---

## § 后续实现顺序

| Chunk | 内容 | 验收 |
|---|---|---|
| Chunk 1 ✅ | clone 候选；读 README 提取定位 | external-references 齐全（已去 goose）；本文档 §1 / §2 已写 |
| Chunk 2 ✅ | spec 骨架 + 短名单决策（含 pi/opencode 升基座） | 本文档落到 `docs/superpowers/specs/`；用户 review 短名单 |
| Chunk 3 ✅ | 27 × 8 矩阵深填（216 cells）+ ★ 维度横向对比 + 8 候选定位修正汇总 | 矩阵无 `_TODO_` 残留；§4.4 / §4.5 已落 |
| Chunk 4 ✅ | §5 推荐 (主推 pi / 备选 opencode / 不推理由 / 决策树 / 未来需求路径) + html 同款 GitHub 风格 + 矩阵 cell 颜色编码 | `.html` 已落盘（gitignored）；md §5 全部章节落盘 |
| Chunk 5 ✅ | `@ai-sdk/workflow` 调研 → 不升候选（是 ai 主包 + workflow 包胶水，hook 多 GAP，version canary） | 信息留底于本表 + §4.5 ai 行（保持 §5 不变） |
| Chunk 6 ✅ | DeepAgents 升候选：基座 8→9；矩阵 cells +27；§2.1/§4.4/§4.5/§5 全面同步；§5.2 备选改为"opencode 或 DeepAgents 按场景二选" | md / html 9 列矩阵全部填写；用户 review |

**Chunk 3 执行策略建议**（待决策）：

- **A. 按候选并行**（推荐起步） — 派 8 个 Explore agent，每个读自己仓库填一整列。优点：并行省时；缺点：跨候选口径需校准
- **B. 按维度推进** — 每次填一行（一个维度 × 8 候选）。优点：横向严格可比；缺点：每个候选反复读
- **C. 混合** — 先 A 拿草稿，再用 B 校准两个 ★ 维度（14 插件形状 / 16 工作区抽象）

---

## 共享协议（slug / cwd / spec 偏差）

- **slug**：`coding-agent-sdk-selection`
- **cwd**：`/Users/moego-winches/Desktop/Company/AI-Agent/agent-slack`（仅作文档容器；新项目本身**不在**此仓库）
- **html 输出**：`docs/superpowers/specs/2026-05-24-coding-agent-sdk-selection.html`（gitignored，仅本地预览）
- **与同日另一 spec 的关系**：
  - [`2026-05-24-agent-sdk-selection-comparison.md`](2026-05-24-agent-sdk-selection-comparison.md)：基于 agent-slack 现状的横向研究（3 场景视角）
  - **本文档**：新项目选型（2 场景视角，去 SDK 嵌入；去 Rust 候选）
  - 候选定位卡片在两份文档里重复出现 — 这是有意的，让本文档可独立阅读
- **spec 偏差处理**：实际执行过程中如发现"维度需拆分 / 候选需换"，直接改本文档原文 + git commit 留底

---

> 上次更新：2026-05-24（Chunk 2 ship）
