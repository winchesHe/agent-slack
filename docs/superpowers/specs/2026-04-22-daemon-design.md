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
- **daemon 内建 dashboard web UI**：`daemon start` 一条命令同时起 agent + IPC + dashboard，
  `daemon.json` 直接暴露 dashboard URL；独立 `dashboard` 命令保留作为"无 daemon 时的只读观察模式"
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
| IPC 协议 | local HTTP 127.0.0.1 + 随机端口 | 零新依赖（复用 node:http）；Windows 对 unix socket 兼容差 |
| 元数据 | `.agent-slack/daemon/daemon.json` | dashboard 读此文件拿 URL，fetch 失败即判 offline；同时记录 dashboardUrl |
| 内建 dashboard | daemon 进程内同时起 dashboard HTTP server（复用 `src/dashboard/server.ts`），端口从 config 读或随机 | 一条命令全搞定；IPC 与 dashboard 可共用同一 HTTP server（同端口不同路由）|
| 日志 | 继续复用 file logger，daemon stdout/stderr 额外重定向到 `.agent-slack/logs/daemon-YYYY-MM-DD.log` | 复用已有 logger 基础设施 |
| 鉴权 | 无（只绑 127.0.0.1） | 和 dashboard 一致，本机开发场景 |

## 4. 目录结构

```
.agent-slack/
  daemon/
    daemon.json    # 元数据：{pid, port, url, startedAt, version, cwd}
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
  "cwd": "/abs/path/to/workspace"
}
```

> 默认 IPC 与 dashboard **共用一个 HTTP server 一个端口**：`/api/*` 给 IPC，`/` 给 dashboard SPA。
> 省端口、省进程、daemon.json 简洁。

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

由于 daemon 内建 dashboard（方案 B），dashboard UI 直接跑在 daemon 进程里，天然能访问 app
实例；无需跨进程读 daemon.json：

- Daemon 内嵌 dashboard 模式：
  - 所有现有 dashboard 路由照旧工作，额外暴露 `/api/daemon/*`
  - Daemon tab 显示 pid / uptime / inflight sessions，直接读 app 内存态
  - SessionDetail 的 "Abort" 按钮调用 `/api/daemon/abort/:id`
  - 顶部显示 "Daemon mode" 标识
- 独立 `dashboard` 命令（无 daemon 时）：
  - 启动前检查 daemon.json，若 daemon 在跑则打印 dashboardUrl 并退出（或打开浏览器）
  - 否则以只读模式跑（现有行为），Daemon tab 显示 "offline"

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
