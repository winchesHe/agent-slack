# Compact E2E Fixtures

预生成的大尺寸历史样本，供 live e2e 在不依赖 LLM 真实生成的情况下测试 compact 行为。

## 文件清单

- `large-history-1m.jsonl` — ~1M chars 的真实尺度 history，包含 dense user/assistant/tool 配对。用于 `compact-effectiveness` / `auto-compact-no-rework` 等 e2e。

## 重新生成

```bash
pnpm tsx scripts/build-compact-fixture.ts
```

确定性种子（生成脚本内 hardcode），重复运行产出 byte-identical 输出，便于 git diff 审查。

## 注意事项

- 内容为伪英文 lorem ipsum 风格，不含敏感数据。
- 每条 message 都带 `id` 字段（确定性 PRNG 生成的 UUID 形式字符串），符合 SessionStore.appendMessage 的强制 id 要求。
- tool_use / tool_result 严格配对，避免裁剪场景产生悬空 tool。
