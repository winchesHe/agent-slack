# 当前执行进度

## Spec B —— 配置中心化（已完成）

四个 chunk 已落地：
- `cf467fd` Chunk B1：模板 generator 收口（`src/workspace/templates/`）+ 守护测试 + `pnpm gen:examples`
- `16575d3` Chunk B2：`agent-slack upgrade --dry-run`，追加式补缺顶层字段 + 自动备份
- `3782624` Chunk B3：Dashboard Config tab 常用字段表单（15 字段）+ Raw YAML 兜底，局部覆盖保留中文注释
- 最后一 commit：Chunk B4 AGENTS 联动规则增补到 8 项（Schema / generator / upgrade / dashboard fields / 装配 / pnpm gen:examples + 守护 / .env / spec）

后续可考虑：
- upgrade 嵌套缺失自动 AST 插入（第二版）
- Dashboard channel-tasks 表单化（rules[] 嵌套，复杂度高，按需评估）
- fields 元数据迁到 Schema 注解（`z.describe`）

---

## 历史决策（保留供复盘）

### Spec A —— Reasoning 流降噪（已完成）

详见 `archive/process-2026-04-29-spec-a.md`。四个 commit：
- `fc4ba6c` Sink 节流（reasoning chat.update 时间窗）
- `c97538c` reasoning emoji log 由 Renderer 每 chunk 一行降为 Sink turn 内一次
- `726f9b6` E2E 注释更新

后续穿插的小优化：
- `946314e` :agent_time: 超过 1 分钟改 Xm Ys 复合显示

---

### Spec B 已确认决策（brainstorm 阶段）

**1. 模板权威源 = 代码 generator（方案 A）**
- `src/workspace/templates/` 下写 4 个 generator（config / env / channel-tasks / system）
- 根目录 `*.example.*` 退化为生成产物
- 新增 `pnpm gen:examples` 脚本 + vitest 守护测试断言根目录 example == generator 输出（字节一致）
- onboard / `CHANNEL_TASKS_CONFIG_TEMPLATE` / dashboard 全部从 generator 取

**2. `agent-slack upgrade` 升级语义 = 追加式（方案 α）**
- 解析用户 yaml → 与 generator 输出对比缺哪些 key → 在用户原文相应位置追加缺失字段块（含中文注释）
- 深层嵌套追加位置取"父 key 的最后一行"，做不到则 fallback 文件末尾
- `--dry-run` 显示将追加的内容
- 升级前自动备份到 `.agent-slack/<file>.bak.<ISO>`
- 范围 = `config.yaml` / `channel-tasks.yaml` / `system.md`（system.md 仅在不存在时按模板创建）
- **不动 `.env.local`**（凭证类，用户自管）

**3. Dashboard 表单化 = 常用字段表单 + raw YAML 兜底（方案 III）**
- 常用字段表单字段：
  - `agent.name`、`agent.provider`（select）、`agent.model`、`agent.maxSteps`
  - `agent.responses.reasoningEffort`（select）、`agent.responses.reasoningSummary`（select）
  - `agent.context.maxApproxChars`、`agent.context.keepRecentMessages`、`agent.context.keepRecentToolResults`、`agent.context.autoCompact.enabled`、`agent.context.autoCompact.triggerRatio`
  - `skills.enabled`（数组，多行/逗号分隔输入）
  - `im.slack.resolveChannelName`（checkbox）
  - `daemon.port`、`daemon.host`
- 表单提交 = **局部覆盖式**（解析用户 yaml → 改对应字段 → 写回），保留用户写的中文注释
- "切到 YAML" 按钮提供 raw 编辑兜底
- channel-tasks 仍保持 raw YAML（rules[] 嵌套表单复杂度过高）
- 字段元数据与 generator 共用一份 fields 描述

**4. AGENTS.md 联动规则增补**
将 "Env / Config 变更联动规则" 段扩展为 8 项（增加：模板 generator 单一权威、upgrade、dashboard 表单；强调"运行 pnpm gen:examples 重新生成 example，CI 守护测试断言一致"）。

---

### 执行 Chunks

- **Chunk B1 — 模板 generator + 守护测试**：`src/workspace/templates/` 下写 4 个 generator，根目录 example 改为生成产物，新增 `pnpm gen:examples` + vitest 守护测试。onboard / `CHANNEL_TASKS_CONFIG_TEMPLATE` 切换到 generator。验证：守护测试通过；onboard 行为不变；根目录 example 字节一致。
- **Chunk B2 — `agent-slack upgrade` CLI**：新增 upgrade 子命令；追加式 diff（schema-driven） + `--dry-run` + 自动备份。验证：单测覆盖 diff/append/backup；fixture workspace e2e 一次。
- **Chunk B3 — Dashboard 常用字段表单**：表单 fields 元数据 + ui.ts config tab 表单视图（局部覆盖提交）+ "切到 YAML" 按钮兜底；channel-tasks 不动。验证：单测 + 浏览器验证。
- **Chunk B4 — AGENTS 联动规则增补**：扩展 AGENTS.md，删历史措辞。验证：文字 review。

每个 chunk 完成后给测试结论让用户 review，再 commit + 进下一个。

---

## 最近归档

- `memory/archive/process-2026-04-29-spec-a.md`：Spec A 完整执行过程（4 chunks + 决策清单）
- `memory/archive/process-2026-04-29.md`：频道任务监听首版完结
- `memory/archive/process-2026-04-26.md`：上下文压缩执行过程
- `memory/archive/process-2026-04-23.md`：上下文压缩链路 Phase 1-4

## 下一步恢复提示

如需继续历史任务，先读对应归档文件，再检查 `git --no-pager status --short` 和最新提交。
