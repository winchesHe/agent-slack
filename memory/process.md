# 当前执行进度

当前无进行中的 process 事项。

**最近完成（2026-05-16）：**

- agent-slack upgrade 命令补强 v0.1.9 schema 迁移漏洞（branch `feat/upgrade-im-migration`，plan：[docs/superpowers/plans/2026-05-16-upgrade-im-schema-migration.md](../docs/superpowers/plans/2026-05-16-upgrade-im-schema-migration.md)）
  - P0-1: `im.provider` → `im.enabled` 持久化字段改名迁移（用 yaml Document AST 保留注释/格式；运行时 `migrateLegacyImProvider` 不变，仍作没跑 upgrade 用户的兜底）
  - P0-2: scheduled-tasks `target.im` 跨文件校验 vs `config.im.enabled`，输出 warning + 修复建议（不自动改 enabled）
  - P1: 嵌套缺失警告附 generator 模板片段（agent.responses / agent.context.* / im.slack 等），剥离公共缩进供用户复制
- 触发场景：用户跑 `daemon start` 报"未在 config.im.enabled 中启用"，根因是 config.yaml 旧 `provider` 字段未持久化迁移 + scheduled-tasks 用 telegram 但 enabled=[slack]
- 端到端 dry-run 在用户实际 workspace 上一次复现两个根因

**最近完成（2026-05-11）：**

- scheduledTasks 主线 12 切片（归档：[memory/archive/process-2026-05-10-scheduled-tasks.md](archive/process-2026-05-10-scheduled-tasks.md)）
- 验证暴露的 2 个 bug fix：redactor `{err:{}}` 黑洞 + WechatAdapter.prepareForManualRun baseUrl 归一化
- spec §6.4 contextToken 持久化长期方案落地（Slice A-D）
- **filehelper 路径全量删除（Slice E）**：实测 filehelper 也需要 contextToken，没有"兜底联系人"特殊性
  - `runScheduledWechatSession` 改为：store 未命中 → 抛 `MissingContextTokenError`（runner 写 history failed）
  - `WechatAdapterDeps.contextTokenStore` 改必填
  - examples / README / spec §6.4 / e2e 脚本注释全部重写为唯一支持路径："target.to 必须是 store 已命中的 microid"
  - 错误信息友好指引（提示用户去补入站消息建立 token 缓存）

## 行为契约（最终）

微信 scheduled tasks 上线门槛：
1. daemon 必须先跑起来
2. target 联系人**先给 bot 发过一条入站消息**（store 自动落盘 token）
3. `target.to` 填那个联系人的 ilink_user_id（推 bot ↔ 管理员私聊：填 credentials.json 的 userId）

未命中 store → 抛 MissingContextTokenError → history failed，错误信息指引用户怎么修。

---

## 最近归档

- `memory/archive/process-2026-05-10-scheduled-tasks.md`：scheduledTasks 主线（4 chunk / 12 切片）
- `memory/archive/process-2026-05-10-spec-b.md`：Spec B 配置中心化
- `memory/archive/process-2026-04-29-spec-a.md`：Spec A
- `memory/archive/process-2026-04-29.md`：频道任务监听首版完结
- `memory/archive/process-2026-04-26.md`：上下文压缩执行过程
- `memory/archive/process-2026-04-23.md`：上下文压缩链路 Phase 1-4

## 下一步恢复提示

如需继续历史任务，先读对应归档文件，再检查 `git --no-pager status --short` 和最新提交。
