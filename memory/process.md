# 当前执行进度

**当前进行中：** scheduledTasks 增量——spec §6.4 长期方案（contextToken 持久化）已提前落地，等手动实发验证。

## 增量切片进度（2026-05-11，scheduled-tasks 主线之后）

- [x] 修复 2 个验证暴露的 bug：
  - `src/logger/redactor.ts`：`{err:{}}` 黑洞（Error 非枚举属性）
  - `src/im/wechat/WechatAdapter.ts:prepareForManualRun`：baseUrl 缺尾斜杠 → fetch failed
- [x] Slice A：`src/im/wechat/ContextTokenStore.ts` + 7 单测（per-peer 持久化、原子 write+rename、损坏文件兜底）
- [x] Slice B：`WechatAdapter.processMessage` 入站时 fire-and-forget `store.save`；`WechatAdapterDeps.contextTokenStore?` 可选注入
- [x] Slice C：`runScheduledWechatSession` 按 `args.to` 查 store；`createApplication` 装配 store
- [ ] Slice D：手动实发验证（待你做）
  1. `agent-slack daemon restart`（让 daemon 用新代码持久化你跟 bot 私聊的 token）
  2. 手机微信用你自己的微信号给 bot 发任意一条文字（如 "ping"），让 inbound 路径把 `context_token` 落盘
  3. 检查 `.agent-slack/wechat/context-tokens.json` 出现你的 `oXXX...@im.wechat` → token 映射
  4. 编辑 `.agent-slack/scheduled-tasks.yaml` 加一条 `target.to: <你的 microid>` 的任务
  5. `pnpm tsx src/e2e/live/run-scheduled-task-wechat.ts <id>`
  6. 你跟 bot 的私聊里应该看到那条 prompt 的回复

## 关键决策（这次增量）

- contextToken store 用 `Record<peerUserId, token>` JSON，原子 write+rename
- inbound 入站 save 走 fire-and-forget + warn（失败不阻塞入站消息处理）
- scheduled 查 token 失败时 fallback `''`（filehelper 仍可用，向后兼容）
- 内存 Map (`contextTokens` in `runLongPollLoop`) 仍保留作为快速读路径，store 只是它的持久化伴随

## 已知风险

- 服务端可能要求 token 新鲜，旧 token 仍可能被拒（无 TTL，永久覆盖）
- 一期不实现 TTL；如果实测发现 contextToken 有"窗口期"，再加 timestamp 跟 maxAgeMs

---

## 最近归档

- `memory/archive/process-2026-05-10-scheduled-tasks.md`：scheduledTasks 主线（4 chunk / 12 切片）
- `memory/archive/process-2026-05-10-spec-b.md`：Spec B 配置中心化（4 chunks + 决策清单）
- `memory/archive/process-2026-04-29-spec-a.md`：Spec A（4 chunks + 决策清单）
- `memory/archive/process-2026-04-29.md`：频道任务监听首版完结
- `memory/archive/process-2026-04-26.md`：上下文压缩执行过程
- `memory/archive/process-2026-04-23.md`：上下文压缩链路 Phase 1-4

## 下一步恢复提示

如需继续历史任务，先读对应归档文件，再检查 `git --no-pager status --short` 和最新提交。
