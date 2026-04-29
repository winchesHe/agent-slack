# 当前执行进度

## 进行中：Spec A —— Reasoning 流降噪 + 配置入口治理拆分

本次需求拆为两个独立 spec，先 A 后 B：

### Spec A（本次先做）：Reasoning 流降噪

**已确认决策（brainstorm 阶段）**：

1. **Sink 内 reasoning 节流（1.2s 时间窗，仅 reasoning 触发）**
   - 节流逻辑放在 `src/im/slack/SlackEventSink.ts`（非 Renderer），维护 `lastReasoningUpdateAt` 等 local 状态
   - 时间窗 1.2s（≈ Slack `chat.update` 限速 1 req/s/channel + 缓冲）
   - 非 reasoning 事件（新 tool / status 切换 / clear / error / done / stopped）**立即冲掉窗口**并重置起点，不被 reasoning 节流连带拖慢
   - 仅 reasoningTail-only 增量进入节流路径；stream 结束（finalize 系列调用）时强制 flush 一次
   - tool/composing 路径维持原逻辑

2. **Reasoning log 每轮只打一次 `info`**
   - 现状：`src/im/slack/SlackRenderer.ts:308` 每个 reasoning chunk 一行 `info`
   - 改为：每个 turn 第一次出现 `state.reasoningTail` 时打一行 `info`（含 `tailPrefix`），后续静默
   - E2E `src/e2e/live/run-thinking-responses.ts` grep `:fluent-thinking-3d:` 仍能命中（一轮中至少有一行）
   - 仅更新 e2e 注释（行 39 / 134-135 描述"每个 chunk 一行"改为"每轮一行"），断言不变

3. **`[render-debug]` 双点改 `log.debug`，废弃 `SLACK_RENDER_DEBUG` env**
   - 改动点：
     - `src/im/slack/SlackRenderer.ts:202` `log.info` → `log.debug`
     - `src/im/slack/SlackEventSink.ts:190` `log.info` → `log.debug`
     - 删除 `isRenderDebugEnabled()` 调用与 `renderDebug` 门控（直接走 logger 级别）
     - `src/workspace/config.ts` 移除 `isRenderDebugEnabled` 导出
   - 联动同步：
     - `.env.example` 删除 `SLACK_RENDER_DEBUG` 段
     - `src/cli/templates.ts:defaultEnv` 删除 `SLACK_RENDER_DEBUG` 注释行
     - `AGENTS.md` 如有提及一并删除（grep 确认）

### 范围外（→ Spec B 后续做）

- `bash.ts:47` `执行命令` log 不动（用户决策：保持 info）
- 其他日志（confirm / compact / adapter 启停 / skill 加载）频率合理，不动
- 配置中心化（统一模板源 + `agent-slack upgrade` CLI + Dashboard 表单化 + AGENTS 联动规则）→ Spec B

### 执行 Chunks

- **Chunk A1 — Sink 节流**：在 `SlackEventSink.ts` 加 reasoning 节流；同目录加测试
- **Chunk A2 — Renderer reasoning log 单次化**：改 `SlackRenderer.ts:308` 逻辑 + 测试
- **Chunk A3 — render-debug 改 debug 级 + 删 env**：源码 + `.env.example` + `templates.ts` + AGENTS 联动
- **Chunk A4 — E2E 注释更新**：仅注释，无断言变更

每个 Chunk 完成后给测试结论让用户 review，再提交 commit、进下一个。

## 待办：Spec B —— 配置中心化

A 完成后再 brainstorm，范围已锁定：
1. 统一模板源（`templates.ts:defaultConfigYaml` 与根目录 `config.example.yaml` 当前不同步：缺 `responses` / `daemon` 字段）
2. 新增 `agent-slack upgrade` CLI 指令升级 workspace config（保留用户值，补缺字段）
3. Dashboard 表单化配置编辑（当前是 raw YAML）
4. `AGENTS.md` 增补"新增配置需在 模板/dashboard/cli 升级 三处都加"

## 最近归档

- `memory/archive/process-2026-04-29.md`：归档频道任务监听首版完结后的 process。
- `memory/archive/process-2026-04-26.md`：上下文压缩执行过程。
- `memory/archive/process-2026-04-23.md`：上下文压缩链路 Phase 1-4 + live E2E。

## 下一步恢复提示

如需继续历史任务，先读对应归档文件，再检查 `git --no-pager status --short` 和最新提交。
