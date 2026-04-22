# Dashboard CLI 指令 —— 开发进度

## 任务目标
给 agent-slack CLI 新增 `dashboard` 子命令：启动本地 web UI 观察
workspace 的 context / sessions / messages / skills / logs / config /
memory / system prompt / health / daemon。预留 daemon 面板位。

## 形态决策
- 交互形态：web UI（node 原生 http + 单页 HTML + vanilla JS）
- 零新依赖：不加任何 dep / devDep
- 后端只读聚合 + Config/System Prompt 的增删改
- 前端单页 SPA，左侧 tab 切换

## Tab 列表（最终 8 个）
overview / sessions / skills / memory / logs / config / system / daemon

（曾经有过 context 与 health，按用户要求从 TABS 移除；`/api/health`
后端接口保留未删，overview 里 env pill 也保留）

## 已完成的文件改动

### 新增
- `src/dashboard/api.ts` — DashboardApi 聚合层（只读 + 4 个写方法）
- `src/dashboard/server.ts` — 原生 http，/api/* JSON + SPA + SSE + PUT/DELETE
- `src/dashboard/ui.ts` — 单页 HTML（内嵌 CSS + vanilla JS）
- `src/cli/commands/dashboard.ts` — CLI 入口 + spawn 打开浏览器

### 修改
- `src/cli/index.ts` — 注册 `dashboard` 子命令，选项仅 `--cwd/--host/--port`
- `src/logger/logger.ts` — createLogger 加可选 logFile；addReporter 追加
  `[ISO] [level] [tag] msg`，经 redactor 脱敏，失败静默
- `src/application/createApplication.ts` — resolveDailyLogFile() 生成
  `<logsDir>/agent-YYYY-MM-DD.log`，bootstrap + 主 logger 都传入
- `package.json` — 新增 `dashboard:dev` 脚本 `tsx watch src/cli/index.ts dashboard`

## 核心能力

### 只读聚合（GET /api/*）
- `/api/overview` — agent 配置、session 总数、running 数、skills 数、
  usage 聚合、近期 error 数、env pill
- `/api/sessions` 列表；`/api/sessions/:id/messages?offset=&limit=` 分页
- `/api/skills` / `/api/skills/:name` 列表 + 详情
- `/api/memory` / `/api/memory/:file` 列表 + 单文件内容
- `/api/logs` / `/api/logs/:file?tail=N` 日志目录 + tail
- `/api/config` raw + parsed
- `/api/system-prompt` content
- `/api/health` node 版本 / slack auth / litellm 模型检查
- `/api/daemon` 预留占位（待 daemon 写 state 文件再读）

### 实时推送（SSE）
- `GET /api/stream` — 每 5s push 一次 overview
- 前端只在 overview tab 触发重渲染，避免在详情页被打回

### Config / System Prompt 增删改
- `PUT /api/config` raw YAML → parseConfig + zod schema 双重校验通过才写盘
- `DELETE /api/config`
- `PUT /api/system-prompt` 任意 markdown 文本
- `DELETE /api/system-prompt`
- body 限 1MB

### Overview 扩展（扁平化关键信息到首页）
- Health pill 行（Node / config / system / Slack env / LiteLLM env）
- Recent Sessions Top 5 表格（点行直达详情）
- Recent Events Timeline（session 更新 + error log 合并最近 10 条，
  error 红色左边框；session 事件点击跳详情）
- Memory 概况（count / totalSize / latest file & mtime）

### Watch 模式
- `pnpm dashboard:dev` → `tsx watch src/cli/index.ts dashboard`
- 改代码自动重启 server；SSE 已有 5s retry 自动重连；浏览器 ⌘R 看新 HTML

### SSE 无闪烁刷新
- tick 不再显示"加载中…"占位（仅首次渲染 / 切 tab 显示）
- overview view 支持接受预取数据，tick 直接用 SSE payload 构建 DOM（省一次 fetch）
- `main.replaceChildren(view)` 原子替换，无中间空白帧
- 保留 scrollTop，tick 前后 scroll 位置一致

### File logger
- createLogger 可选 logFile 参数
- consola.addReporter 追加写入（不替换 stdout）
- 写失败静默，不影响主流程
- 默认路径 `.agent-slack/logs/agent-YYYY-MM-DD.log`

## 关键技术点
- **端口 0**：默认让 OS 分配空闲端口，日志打印实际 URL
- **路径穿越防护**：memoryDetail/logTail 拒绝带 `/` 和 `\` 的 file 参数
- **Session id 选型**：用目录名（`<channelName>.<channelId>.<threadTs>`）
  做 id，避免与 SessionStore 内部 id 耦合
- **默认打开浏览器**：无选项控制，直接 spawn `open/xdg-open/start`
- **HTML 模板 `\n` 陷阱**（踩过的坑）：ui.ts 外层是 TS 模板字符串，
  里面写 `'...\n'` 会被 TS 提前解析成真实换行落到输出 JS 里，
  导致浏览器侧 "Unterminated string literal" 整个脚本失效。
  客户端 JS 需要换行字符时，TS 源里必须写 `'\\n'`（双反斜杠）。
- **`addEventListener('click', undefined)` 会抛 TypeError**：
  `el()` helper 在属性值为 null/undefined 时必须 skip，
  否则条件式 onclick（`onclick: cond ? fn : undefined`）会炸。

## 验证状态
- ✅ `pnpm lint` 通过
- ✅ `pnpm typecheck` 新增代码无错
  （有 3 个预存的 createApplication.test.ts 类型错误与本次无关）
- ✅ logger 单测 6/6 绿
- ✅ 用户本地 `pnpm cli dashboard` 实测页面正常渲染、tab 切换正常
- ✅ curl `/api/overview` 200 OK 返回完整 JSON

## 未做 / 已知事项
- `/api/health` 路由保留但 Health tab 已从 UI 去掉（用户决定）
- Daemon tab 占位，等 daemon 模块接入再扩 `/api/daemon`
- 写操作（PUT/DELETE config / system-prompt）没做鉴权，默认只绑定 127.0.0.1
- 保存 config 后主程序需重启才生效（config 仅在 bootstrap 时读一次）

## 约束（来自本次会话）
- 不生成测试脚本
- 不自己编译，不自己运行 —— 全部由用户在本地执行
- 按 chunk 完成后让用户 review，确认后再进下一步
- 任何 env 变更需联动 5 处（见 AGENTS.md）—— 本次未新增 env 变量
