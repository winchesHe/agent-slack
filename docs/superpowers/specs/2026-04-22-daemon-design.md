# agent-slack Daemon 设计

**日期**：2026-04-22
**状态**：草稿，待 review
**关联**：[`2026-04-17-agent-slack-architecture-design.md`](./2026-04-17-agent-slack-architecture-design.md)
**上下文**：dashboard（2026-04-22 落地）的 Daemon tab 目前是占位；本 spec 把
主进程 daemon 化 + 提供本地 IPC 给 dashboard / CLI 观察与控制。

## 1. 目标

- 让 agent-slack 能作为**后台常驻进程**运行，不占终端、终端关闭不挂
- 给 dashboard / CLI 提供**本地 IPC**，可读实时内存态（当前 session 跑到第几步、
  inflight tool call）+ 启停控制
- **Dashboard 与 Daemon 生命周期解耦**：
  - `daemon start` 自动检测是否已有独立 dashboard 运行：
    - **有独立 dashboard** → daemon 以 **headless 模式**启动（不起 HTTP，复用已有 dashboard）
    - **无独立 dashboard** → daemon 以 **embedded 模式**启动（同时起 agent + dashboard）
  - Dashboard 的 Daemon tab 提供**启动 / 停止按钮**，可从 UI 控制 daemon 生命周期
  - `daemon stop` 只停 agent 进程，**不影响独立 dashboard**
- 与一期"单进程绑定 cwd"架构**完全兼容**：一 workspace 一 daemon，不引入多 workspace
- 保留前台 `agent-slack start` 行为不变（dogfooding / 开发友好）

## 2. 非目标（一期不做）

- 多 workspace daemon / 调度器
- 集群 / 远程访问（daemon HTTP 只绑 127.0.0.1）
- 热重载 config（改 config 需要重启 daemon）
- 高可用 / 自动重启（失败直接退出，交给用户手动 restart；日志留痕）

## 3. 核心决策

| 决策项 | 方案 | 理由 |
|---|---|---|
| Daemon 边界 | 一 workspace 一 daemon | 对齐架构文档 §3.1 "一个进程服务一个 workspace" |
| 启停实现 | CLI 自 fork `spawn(..., {detached:true, stdio:'ignore'}).unref()` + pidfile | 跨平台；不依赖 launchd/systemd；无新依赖 |
| IPC 协议 | local HTTP 127.0.0.1 + 配置端口 | 零新依赖（复用 node:http）；Windows 对 unix socket 兼容差 |
| 元数据 | `.agent-slack/daemon/daemon.json` + `dashboard.json` | dashboard 读 daemon.json 判状态；daemon 读 dashboard.json 判是否需 headless |
| Dashboard 与 Daemon 分离 | 两种模式：**embedded**（daemon 内建 dashboard）/ **headless**（daemon 无 HTTP，复用独立 dashboard） | `daemon start` 自动探测端口：空闲 → embedded；已被本 workspace dashboard 占用 → headless |
| 日志 | 继续复用 file logger，daemon stdout/stderr 额外重定向到 `.agent-slack/logs/daemon-YYYY-MM-DD.log` | 复用已有 logger 基础设施 |
| 鉴权 | 无（只绑 127.0.0.1） | 和 dashboard 一致，本机开发场景 |

## 4. 目录结构

```
.agent-slack/
  daemon/
    daemon.json    # 元数据：{pid, port, url, startedAt, version, cwd, mode}
    dashboard.json # standalone dashboard 元数据：{pid, port, host, url, startedAt, cwd}
    daemon.pid     # 纯 pid，便于 shell 脚本用
    daemon.lock    # 启动时创建，防止重复启动（带 PID 的 stale detect）
  logs/
    daemon-YYYY-MM-DD.log   # daemon stdout/stderr
    agent-YYYY-MM-DD.log    # 已有，agent 执行日志
```

`daemon.json` schema：

```json
{
  "pid": 12345,
  "port": 51732,
  "url": "http://127.0.0.1:51732",
  "dashboardUrl": "http://127.0.0.1:51732",
  "startedAt": "2026-04-22T02:00:00.000Z",
  "version": "0.1.1",
  "cwd": "/abs/path/to/workspace",
  "mode": "embedded"
}
```

> `mode` 取值：
> - `embedded`：daemon 内建 dashboard，IPC 与 dashboard 共用一个 HTTP server（默认行为）
> - `headless`：daemon 无 HTTP server，`url` 为空，`dashboardUrl` 指向独立 dashboard 的 URL

## 5. CLI 命令

所有子命令都在 `agent-slack daemon` 下：

| 命令 | 行为 |
|---|---|
| `daemon start` | 检查 lockfile → spawn detached 子进程 → 子进程启动 agent + 单一 HTTP server（IPC + dashboard 合并）→ 写 daemon.json/pid → unref → 父退出并打印 dashboardUrl |
| `daemon stop` | 读 daemon.json 拿 pid → 发 SIGTERM → 等进程退 → 清理 daemon.json/pid/lock |
| `daemon restart` | stop + start |
| `daemon status` | 读 daemon.json + 试 fetch `/api/state` → 展示 running/offline/stale |
| `daemon logs [--tail N] [--follow]` | tail `daemon-YYYY-MM-DD.log` |
| `daemon attach` | fetch `/api/stream`（daemon 的 SSE）实时打印事件到终端，Ctrl+C 断开但 daemon 不停 |

错误处理：
- lockfile 存在但进程不在 → 认为 stale，清理后继续
- `daemon start` 发现已 running → 报错并打印 URL
- `daemon stop` SIGTERM 后 5s 未退 → SIGKILL + warn

## 6. Daemon 进程内部

复用现有 `createApplication()` DI 容器，**完全不改 agent 逻辑**；只在外面包一层
"IPC server + shutdown handler"：

```
daemon-entry.ts
├── createApplication({ cwd, mode: 'daemon' })
│   └── ...existing agent boot (Slack connection, store, etc.)
├── startDaemonServer(app)   # 单一 HTTP server，复用 dashboard/server.ts
│   └── HTTP 127.0.0.1:<port>
│         # dashboard 路由（沿用现有）
│         GET  /                    dashboard SPA
│         GET  /api/overview        （已有）
│         GET  /api/stream          （已有 SSE）
│         ...其它 dashboard 路由
│         # 新增 IPC / daemon 控制路由
│         GET  /api/daemon/state         活着的 session + cost + stepCount
│         GET  /api/daemon/sessions/:id  inflight 状态
│         POST /api/daemon/stop          优雅退出
│         POST /api/daemon/abort/:id     触发 AbortRegistry.abort(id)
├── process.on('SIGTERM') → graceful shutdown
└── process.on('uncaughtException') → log + exit(1)
```

IPC 和 dashboard **复用 `src/dashboard/server.ts` 的单一 HTTP server**，只新增 `/api/daemon/*`
路由。独立 `dashboard` 命令（无 daemon 时的只读模式）保留现有实现，但当检测到 daemon 在跑时
可以直接 302 重定向到 daemon 的 dashboardUrl（或直接提示用户用 daemon URL）。

## 7. Dashboard 集成

Dashboard 与 Daemon **生命周期完全解耦**，通过两种运行模式协作：

### 7.1 Embedded 模式（daemon 内建 dashboard）
- 无独立 dashboard 运行时，`daemon start` 自动启动内建 dashboard
- 所有现有 dashboard 路由照旧工作，额外暴露 `/api/daemon/*`
- Daemon tab 显示 pid / uptime / inflight sessions，直接读 app 内存态

### 7.2 Headless 模式（daemon + 独立 dashboard）
- 已有独立 dashboard 运行时，`daemon start` 以 headless 模式启动（不起 HTTP）
- 独立 dashboard 通过 `daemon.json` 发现 daemon 进程，提供 `/api/daemon/start` 和 `/api/daemon/stop` 控制路由
- Dashboard Daemon tab 提供 **启动 / 停止按钮**，可从 UI 控制 daemon
- `daemon stop` 仅停止 agent 进程，**不影响独立 dashboard**

### 7.3 端口探测机制
- `daemon start` 通过 `GET /api/meta` 探测配置端口是否已被本 workspace 的 dashboard 占用
- `/api/meta` 返回 `{ app: 'agent-slack-dashboard', cwd, mode }` 用于指纹识别
- 独立 dashboard 启动时写 `dashboard.json`，退出时清理

### 7.4 独立 `dashboard` 命令
- 默认绑定 `daemon.port`（config.yaml 配置，默认 51732）
- 启动时写 `dashboard.json`，退出时清理
- Daemon tab：offline 时显示"启动 Daemon"按钮，running 时显示"Stop"按钮

## 8. 代码改动范围

| 路径 | 类型 | 说明 |
|---|---|---|
| `src/daemon/ipc.ts` | 新增（可选合并到 entry.ts） | IPC 层小工具（如需） |
| `src/daemon/daemonFile.ts` | 新增 | daemon.json / pid / lock 读写与 stale 检测 |
| `src/daemon/entry.ts` | 新增 | daemon 子进程入口，装配 createApplication + 启动 dashboard server（含 /api/daemon/*） |
| `src/daemon/routes.ts` | 新增 | `/api/daemon/*` 路由处理（state/abort/stop） |
| `src/cli/commands/daemon.ts` | 新增 | start/stop/restart/status/logs/attach 子命令集 |
| `src/cli/index.ts` | 修改 | 注册 `daemon` 子命令 |
| `src/workspace/paths.ts` | 修改 | 新增 `daemonDir` / `daemonFile` / `daemonPidFile` / `daemonLockFile` |
| `src/dashboard/api.ts` | 修改 | daemon() 方法实现：读 daemon.json + fetch /api/state |
| `src/dashboard/ui.ts` | 修改 | Daemon tab 填真实 UI + 控制按钮 |
| `src/application/createApplication.ts` | 修改（可选） | 加 `mode: 'foreground' \| 'daemon'`，只改日志路径 |

## 9. 兼容性 / 迁移

- 不改 `start` 命令前台行为，纯增量
- `.agent-slack/daemon/` 目录首次启动自动创建
- dashboard 现有 daemon tab 从占位变真实面板，无破坏性

## 10. 风险与缓解

| 风险 | 缓解 |
|---|---|
| Node detached spawn 在 Windows 下行为差异 | 现阶段主要目标是 macOS/Linux；Windows 单独评估 |
| daemon.json 过时导致 stale fetch | dashboard 必须 `fetch + timeout 2s` 判 offline，daemon stop 清理 |
| IPC 未鉴权 → 本机任意进程可触发 stop | 接受：dashboard 也是同样假设；开发环境 |
| Slack connection 独占（daemon + foreground start 同时跑） | `daemon start` 和 `start` 检查对方存在即报错 |

## 11. 落地节奏（chunk 建议）

1. **Chunk D1**：daemonFile.ts + paths.ts + CLI 命令骨架（start/stop/status，仅 pidfile，不起 HTTP）
2. **Chunk D2**：daemon entry 装配 createApplication + 启动 dashboard server（共用端口）+ 写 daemon.json
3. **Chunk D3**：新增 `/api/daemon/*` 路由（state/abort/stop）+ dashboard Daemon tab 真实 UI + Abort 按钮
4. **Chunk D4**：logs/attach CLI + 独立 `dashboard` 命令检测 daemon 并跳转 + 文档更新

每 chunk 完成后用户 review 再进下一步。

## 12. 决定（已定）

- ✅ **Q1**：`daemon start` 与 `start` 同样读 `.env` + `.agent-slack/config.yaml`
- ✅ **Q2**：`daemon logs` 默认**不** follow；加 `--follow` / `-f` 启用 tail -f
- ✅ **Q3**：dashboard 中 **stop / restart** 按钮带确认弹窗，start 不用
- ✅ **Q4**：`.agent-slack/daemon/` 加入 `.gitignore`（运行态文件）
- ✅ **Q5**：daemon HTTP 端口**从 config 固定读取**（`daemon.port`，默认 `51732`）

# Agent Provider 适配 - 执行进度

对应计划：`docs/superpowers/plans/2026-04-21-agent-provider-adapters.md`

## 进度记录

- [x] P1 后端重构（config 精简 + ProviderSelector）✅ 2026-04-21
  - [x] P1.1 `agent.provider` schema 字段（方案 A：必填带默认 litellm） ✅ 2026-04-21
  - [x] P1.2 `ProviderSelector` 装配层 ✅ 2026-04-21
- [x] P2 Onboard UX 改造 ✅ 2026-04-21
  - [x] P2.1 `validateAnthropic` 形状校验 ✅ 2026-04-21
  - [x] P2.2 `templates.ts` 分支模板 ✅ 2026-04-21
  - [x] P2.3 `onboard.ts` 流程改造 ✅ 2026-04-21
- [x] P3 接入 `@ai-sdk/anthropic` ✅ 2026-04-21
  - [x] P3.1 引入依赖 ✅ 2026-04-21（最终版本 `@ai-sdk/anthropic@^1.2.12`，对齐 AI SDK 4 的 `LanguageModelV1` spec；`^3.0.71` 属 AI SDK 5 不兼容，已回退）
  - [x] P3.2 实装 anthropic 分支 ✅ 2026-04-21
  - [x] P3.3 真实回归验证（手工）✅ 2026-04-21（装配路径打通：请求成功到达 Anthropic API；收到业务层 `credit balance too low` 错误属账户问题，非代码问题）
- [x] P4 文档
  - [x] P4.1 `.env.example` ✅ 2026-04-21
  - [x] P4.2 `README.md` ✅ 2026-04-21（新增 "Provider 切换（LiteLLM / Anthropic）" 节）
  - [x] P4.3 `AGENTS.md` ✅ 2026-04-21
  - [x] P4.4 spec 状态 ✅ 2026-04-21（改为"已实装"）

## 时间线

### P1 完成（2026-04-21）

**改动文件**：
- `src/workspace/config.ts`：移除 `agent.provider` 字段
- `src/workspace/config.test.ts`：新增向后兼容测试
- `src/application/createApplication.ts`：
  - 新增 `AgentProvider` 类型 + `selectProvider()`（读 `AGENT_PROVIDER`，默认 litellm）
  - 新增 `loadProviderEnv()` 条件化 env 校验（litellm 要 LITELLM_*，anthropic 要 ANTHROPIC_API_KEY）
  - 新增 `buildProviderRuntime()`：litellm 分支迁入现逻辑，anthropic 分支抛"暂未实装"
  - 启动日志输出 `provider=xxx`
- `src/application/createApplication.test.ts`：新增 4 个分支用例

**验证**：`pnpm test` 166 pass / `pnpm lint` 通过

### P2 完成（2026-04-21）

**改动文件**：
- `src/cli/validators.ts`：新增 `validateAnthropic`（形状校验 `sk-ant-` 前缀 + 非空）
- `src/cli/validators.test.ts`：新增 3 用例
- `src/cli/templates.ts`：
  - `defaultConfigYaml` 去掉 `provider: litellm` 行
  - `DefaultEnvArgs` 改为 discriminated union（`provider: 'litellm' | 'anthropic'`）
  - `defaultEnv` 按 provider 分支渲染（anthropic 写 `AGENT_PROVIDER=anthropic` + `ANTHROPIC_API_KEY` + 可选 `ANTHROPIC_BASE_URL`；litellm 保持现状不写 `AGENT_PROVIDER`）
- `src/cli/commands/onboard.ts`：
  - Slack 三件套后插入 `provider` select（默认 litellm）
  - litellm 分支问 LiteLLM Base URL / API Key；anthropic 分支问 ANTHROPIC_API_KEY（sk-ant- 校验）+ 可选 ANTHROPIC_BASE_URL
  - 默认模型随 provider 切换（anthropic → claude-sonnet-4-5；litellm → claude-sonnet-4-6）
  - 对应 validator 分支调用
  - `defaultEnv(...)` 用 discriminated union 传参
- `src/cli/commands/onboard.test.ts`：新增 3 用例（anthropic / anthropic+baseUrl / litellm 回归），select 队列改为按序返回

**验证**：`pnpm test` 172 pass / `pnpm lint` 通过

### P4.1（含 P2 模板细化，2026-04-21）

**改动文件**：
- `.env.example`：精简，按 Slack / Provider 开关 / LiteLLM / Anthropic / 模型 / 日志分组；只给**需要选择/可选/值说明**的字段加注释
- `.env`（本地，gitignored）：同结构
- `src/cli/templates.ts` `defaultEnv`：重写分支模板 — 两个 provider 块都输出（当前启用的填值，另一个注释掉），注释仅保留在有选择空间的字段
- `src/cli/commands/onboard.test.ts`：调整 anthropic 断言为行首锚点（`^LITELLM_` / `^ANTHROPIC_BASE_URL=`），允许注释行存在

**验证**：`pnpm test` 172 pass / `pnpm lint` 通过

### P1.1 回调（保留 agent.provider，2026-04-21）

按新决策 "config > env 优先级"：
- `src/workspace/config.ts`：重新引入 `agent.provider` 为可选枚举 `z.enum(['litellm','anthropic']).optional()`
- `src/workspace/config.test.ts`：4 条用例（litellm/anthropic 合法、undefined 缺省、非法值报错）
- `src/application/createApplication.ts`：
  - `selectProvider(configProvider?)` 优先 config；为 undefined 时 fallback 到 env；再 fallback 默认 litellm
  - 加载流程改为先 bootstrap logger（仅 Slack secrets）→ loadWorkspaceContext → selectProvider(ctx.config.agent.provider) → 加 provider secrets → 重建最终 logger
- `src/application/createApplication.test.ts`：新增 2 用例（config 锁 anthropic 优先；config 锁 litellm 覆盖 env anthropic）
- spec §3.3 / §3.5 ⑧ / §1.1 / §8.1 同步更新

**验证**：`pnpm test` 177 pass / `pnpm lint` 通过

### 方案 A 实施：env / config 单一权威收敛（2026-04-21）

**背景**：AGENT_MODEL / AGENT_PROVIDER / PROVIDER_NAME 同时存在于 env 与 config.yaml，形成二重来源。用户选方案 A —— **config.yaml 单一权威管行为配置**，env 只放凭证 / 部署差异 / debug。

**改动文件**：
- `src/workspace/config.ts`：
  - `agent.provider` 从 `.optional()` 改为 `.default('litellm')`（必填带默认，空 config 也能跑）
  - 移除 `process.env.AGENT_MODEL` fallback —— model 只从 config 读取
- `src/workspace/config.test.ts`：4 条用例对齐新默认语义
- `src/application/createApplication.ts`：
  - `selectProvider(configProvider)` 简化为类型收窄（合法性由 zod 在解析时保证，env 不再参与）
  - `modelName` 只从 `ctx.config.agent.model` 读
  - `loadProviderEnv` litellm 分支 `providerName` 硬编码 `'litellm'`（删 `PROVIDER_NAME` env）
  - 错误文案：`AGENT_PROVIDER=anthropic 暂未实装` → `agent.provider=anthropic 暂未实装（改 config.yaml）`
- `src/application/createApplication.test.ts`：5 条用例重写（mock loadWorkspaceContext 返回的 config 默认带 `provider: 'litellm'`；新增 "env AGENT_PROVIDER 不再影响选择" 回归）
- `src/cli/templates.ts`：
  - `defaultConfigYaml(model, provider)` 签名新增 `provider`，在 `agent:` 块写 `provider: ${provider}` 行
  - `defaultEnv` 去掉"模型 & Provider 选项"段和 AGENT_PROVIDER 注释行
- `src/cli/commands/onboard.ts`：
  - 调用 `defaultConfigYaml(model, provider)` 时传 provider
  - providerHint 改为"编辑 config.yaml 切换 provider"
- `src/cli/commands/onboard.test.ts`：3 条 provider 相关用例改为断言 config.yaml 的 `provider: <value>`；断言 `.env.local` 完全不含 `AGENT_PROVIDER`
- `src/cli/commands/doctor.ts`：文案 `model=AGENT_MODEL 或 gpt-5.4` → `model=gpt-5.4 / provider=litellm`
- `.env.example` / `.env`：精简到 Slack / LiteLLM / Anthropic / LOG_LEVEL / SLACK_RENDER_DEBUG 五组；不含 AGENT_* / PROVIDER_NAME
- `AGENTS.md`：新增"Env / Config 单一权威原则（方案 A）"节，明确禁止行为类 env 变量
- spec §1.1 / §2.2 / §2.3 / §3.1 / §3.3 / §3.4 / §3.5 / §7 / §8.1 全面同步为方案 A 描述

**验证**：`pnpm vitest run` 175 pass / `pnpm lint` 通过

### P3 完成（2026-04-21）

**改动文件**：
- `package.json`：`@ai-sdk/anthropic@^3.0.71`
- `src/application/createApplication.ts`：
  - `import { createAnthropic } from '@ai-sdk/anthropic'`
  - `buildProviderRuntime` anthropic 分支：`createAnthropic({ apiKey, baseURL? }).languageModel(modelName)`，`providerNameForOptions: undefined`（不注入 `stream_options`，AI SDK anthropic 原生回传 usage）
  - 移除"暂未实装"的 ConfigError；替换为内部一致性守卫（provider 与 env.provider 不一致时抛错）
- `src/application/createApplication.test.ts`：
  - 新增 `createAnthropic` mock + `vi.mock('@ai-sdk/anthropic', ...)`
  - 原"暂未实装"断言替换为 2 条成功装配用例：
    - anthropic provider 仅 apiKey → `createAnthropic({ apiKey })`
    - anthropic provider + `ANTHROPIC_BASE_URL` → 含 `baseURL`

**待办**：P3.3 真实回归（用户手工跑 onboard → 选 anthropic → 实际发消息，确认 streamText 事件流 / usage / tool-call 正常）

**验证**：`pnpm vitest run` 176 pass / `pnpm lint` 通过

### Daemon 与 Dashboard 生命周期解耦（2026-04-22）

**背景**：daemon stop 会同时停止内建 dashboard，用户希望 dashboard 独立于 daemon 运行，并能从 dashboard UI 控制 daemon 启停。

**改动文件**：
- `src/workspace/paths.ts`：新增 `dashboardFile` 路径
- `src/daemon/daemonFile.ts`：
  - `DaemonMeta` 新增 `mode: 'embedded' | 'headless'` 字段
  - 新增 `DashboardMeta` 接口 + `readDashboardMeta` / `writeDashboardMeta` / `clearDashboardMeta`
- `src/daemon/entry.ts`：
  - 支持 `headless` 参数：headless 模式跳过 HTTP server，从 dashboard.json 获取 dashboardUrl
  - embedded 模式保持原行为，增加 `mode: 'embedded'`
- `src/cli/commands/daemon.ts`：
  - `daemonStartCommand` 端口占用时探测 `/api/meta` 判断是否为本 workspace 独立 dashboard
  - 是 → headless 模式启动；否 → 报错
  - spawn 时按需传 `--headless`
  - `daemonStatusCommand` 显示 mode 字段
- `src/cli/commands/dashboard.ts`：
  - standalone dashboard 默认绑定 `daemon.port`（config.yaml 配置）
  - 启动时写 `dashboard.json`，退出时清理
  - 移除 daemon 运行中时阻止启动的逻辑
- `src/cli/index.ts`：`__daemon-run` 新增 `--headless` 选项
- `src/dashboard/server.ts`：
  - 新增 `/api/meta` 路由（返回 app 指纹 + cwd + mode）
  - standalone 模式新增 `/api/daemon/start` 和 `/api/daemon/stop` 路由
- `src/dashboard/api.ts`：daemon() 返回值新增 `mode` 字段，headless 模式跳过 live fetch
- `src/dashboard/ui.ts`：
  - Daemon tab offline 状态：新增"启动 Daemon"按钮
  - Daemon tab stale 状态：新增"清理并启动 Daemon"按钮
  - Daemon tab running 状态：新增 Mode 卡片显示

**验证**：`pnpm lint` 通过
