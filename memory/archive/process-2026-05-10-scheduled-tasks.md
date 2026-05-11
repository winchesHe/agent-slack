# scheduledTasks 模块实施归档（2026-05-10 → 2026-05-11）

- **关联 spec：** [docs/superpowers/specs/2026-05-10-scheduled-tasks-design.md](../../docs/superpowers/specs/2026-05-10-scheduled-tasks-design.md)（v2，应对两轮 review）
- **关联 plan：** [docs/superpowers/plans/2026-05-10-scheduled-tasks-implementation.md](../../docs/superpowers/plans/2026-05-10-scheduled-tasks-implementation.md)
- **模式：** 主进程顺序执行（用户明确"不用 subagent"），每切片"测试先红 → 实现 → 测试绿 → commit"
- **结果：** 12 个切片全部完成；501 全套 vitest 测试全过，tsc 干净；CLI 命令、daemon 装配、history、模板、文档全部落地

## 切片执行清单

| Slice | 内容 | commit | 验证 |
|---|---|---|---|
| 0 | croner 10.0.1 + types.ts | e93d546 | tsc |
| 1 | example yaml + 模板注册（_assets / templates / paths / upgrade） | d8dab02 | 63 workspace 测试全过（+2 新） |
| 2 | config schema + loader | 0147054 | 17 case 全过 |
| 3 | jsonl runHistory（按文件串行化） | ac23dee | 4 case 全过；并发 50 条不丢行 |
| 4 | 抽 runSlackSession / runWechatSession helpers（无行为变更） | c27f96f | 136 IM 测试断言保持不变全过 |
| 5 | adapter 返回 handle 结构（adapter + scheduledHook + loadCredentialsOnly） | d5ebb71 | 468 测试全过 |
| 6 | runScheduledSlackSession + 接通 scheduledHook | 54113c6 | 5 单测 |
| 7 | runScheduledWechatSession + 接通 scheduledHook | dce93f7 | 3 单测 |
| 8 | scheduledTasks runner（hook 路由 + history） | b7c6370 | 8 单测 |
| 9 | scheduler + croner（cronFactory 注入式） | 39bd130 | 7 单测；vitest fake timers 与 croner 不兼容，转用 mock factory |
| 10 | createApplication 装配 + daemon 生命周期 | 0a8e9a5 | 集成测试 3 个 |
| 11 | CLI scheduled-tasks run <id> + wechatHandle.prepareForManualRun | 055b78d | 7 CLI 测试覆盖所有 exit code |
| 12 | live E2E + README + 架构 spec + memory 归档 | （本提交） | filehelper 实发需手动验证 |

## 关键决策清单

1. **`_assets.ts` 显式注册 SCHEDULED_TASKS_EXAMPLE**：upgrade 框架不会自动扫描 examples/，spec §4.7 已自标。新增条目 + 配套 generator + templates.test.ts 守护。
2. **adapter handle 拆 Slice 4/5 两步**：
   - Slice 4 抽 helper（行为不变，测试断言不动），为 scheduled 复用底层做准备
   - Slice 5 改返回类型 `{ adapter, scheduledHook }` + scheduledHook 暂抛 not-implemented（让 createApplication 装配先编译通过）
3. **scheduler 用 cronFactory 注入点**：vitest fake timers 推不动 croner 内部 setTimeout 链；测试用 mock factory 手动触发。生产仍走 croner。spec §8 没强约束实现方式。
4. **wechatHandle.prepareForManualRun**：把"load creds → 同步 baseUrl → setToken"打包成一个方法（spec §5.3 强调 baseUrl 同步可能从扫码态切换）。CLI 调一次即可，不需要拆开。
5. **createApplication 暴露 wechatHandle?**：CLI 模式 preflight 用；daemon 模式 adapter.start() 已自动 setToken。`Application` 接口加 `wechatHandle?` 字段，避免污染。
6. **不加 createApplication 的 `{ startInbound }` 开关**：CLI 调 createApplication 但不调 `app.start()`，Bolt App 构造时初始化 client（不连 socket）。slack scheduled 用 `app.client` 即可。
7. **runner.skip(rule, reason)**：scheduler 在 in-flight 时直接调 runner.skip，scheduler 不直接碰 history。trigger 强制 'cron'（manual 不会撞 in-flight）。

## spec 与现状已确认差异（plan 阶段标记，实施时处理）

| 项 | 实施处理 |
|---|---|
| _assets.ts 不自动扫描 examples/ | Slice 1 显式注册 SCHEDULED_TASKS_EXAMPLE + scheduledTasks.ts generator |
| croner 缺失 | Slice 0 pnpm add croner（10.0.1） |
| adapter 返回类型升级 | Slice 5 引入 handle 结构，createApplication 解构 |

## spec 与实际偏差点

- spec §3 写 `RunScheduledSlackArgs.deps` 含 `sessionStore / runQueue / abortRegistry`；实际实现只需要 `orchestrator / renderer / workspaceLabel? / logger`（其余在 orchestrator 内已闭包持有）。不影响功能。
- spec §5.2 文字描述 `messageTs:<生成 id>`；实际 wechat 路径用 `scheduled-${taskId}-${nowMs}` 形态，可注入 `nowMs` 工厂保证确定性。
- scheduler 引入 cronFactory 是 spec 未提到的实现选择，但符合 plan Slice 9.1 的退路条款。

## 已知未验证 / 待办

- **wechat filehelper 实发**（spec §6.4 强制门槛）：需手动跑 `agent-slack scheduled-tasks run <wechat-task-id>` 验证 `contextToken:''` 真的能投递。我作为 AI 无法替你扫码完成凭证。如果实发失败，按 spec §6.4 决议：wechat target 标"未支持"，slack 单独上线。
- 长期：若需要非 filehelper 联系人，可在收到对方任意入站消息时把 `contextToken` 持久化（per-peer）。本期不做。

## 关键文件指引

```
src/scheduledTasks/
  types.ts                # ScheduledTaskTarget / RunRecord
  config.ts               # Zod schema + loadScheduledTasksConfigFile
  runHistory.ts           # appendScheduledTaskRun
  runner.ts               # createScheduledTaskRunner（hook 路由 + history）
  scheduler.ts            # createScheduledTaskScheduler（croner-based + in-flight skip）
  index.ts                # 公开导出

src/im/slack/scheduled.ts        # runScheduledSlackSession 纯函数
src/im/slack/SlackAdapter.ts     # runSlackSession helper + scheduledHook
src/im/wechat/scheduled.ts       # runScheduledWechatSession 纯函数
src/im/wechat/WechatAdapter.ts   # runWechatSession helper + scheduledHook + prepareForManualRun + MissingWechatCredentialsError

src/cli/commands/scheduledTasks.ts    # CLI run <id>
src/cli/index.ts                      # 路由注册

src/application/createApplication.ts  # 装配 runner+scheduler；start/stop 接 scheduler
src/application/types.ts              # Application.scheduledTasks?, Application.wechatHandle?

src/workspace/paths.ts                # scheduledTasksFile / scheduledTasksLogFile
src/workspace/templates/scheduledTasks.ts  # generator
src/cli/commands/upgrade.ts                # 注册到 upgrade targets

examples/scheduled-tasks.example.yaml

src/e2e/live/run-scheduled-task-wechat.ts  # 手动 filehelper 验证
src/e2e/live/run-scheduled-task-slack.ts   # 可选 slack 验证
```

## 测试覆盖统计

- scheduledTasks 模块：17 (config) + 4 (runHistory) + 8 (runner) + 7 (scheduler) = 36 单测
- IM scheduled：5 (slack) + 3 (wechat) = 8 单测
- CLI scheduled-tasks：7 单测
- 集成（createApplication）：3 新增（含 IM 交叉校验、装配通路）
- 守护无行为变更：现有 SlackAdapter / WechatAdapter / createApplication 测试 50+ 全过

总计：501 全套测试全过、tsc 干净、6 commit + 1 plan + 1 memory 归档。
