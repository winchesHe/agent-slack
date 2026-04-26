# Changelog

## 0.1.5 (2026-04-26)


### Bug Fixes

* NaN usage 修复 + 格式优化 + PROVIDER_NAME 环境变量 + 文档同步 ([8f8ed06](https://github.com/winchesHe/agent-slack/commit/8f8ed06ae267823a05ef6dbb2379c633cb020c70))


### Features

* **ask-confirm:** Q0-Q2 实现阻塞式按钮确认 tool ([1a0a6d9](https://github.com/winchesHe/agent-slack/commit/1a0a6d952321990bb65652fa059f8471d1b916ea))
* **chunk6:** 清理 core/usage.ts + 新增 slack-render-flow 集成测试 ([083f35d](https://github.com/winchesHe/agent-slack/commit/083f35d979cfcfd68c9e6d090a28878ba7ff59db))
* **im/slack:** confirm 决策落 log + events.jsonl 审计 ([02c259d](https://github.com/winchesHe/agent-slack/commit/02c259dbe78c4be0480ec40c27bc096ae8b0616b))
* init docs ([d104ca8](https://github.com/winchesHe/agent-slack/commit/d104ca843d59a5bcc236daa679e286a0c5d854bb))
* **render:** Chunk 5 可观测性修复 — bash 工具显示 bash(cmd) xN 格式 ([93af525](https://github.com/winchesHe/agent-slack/commit/93af525c31a14cfa3355182aaf05c39a84924c57))
* **self_improve:** P4 规则后处理器 + 设计文档双 tool 策略更新 ([48dd441](https://github.com/winchesHe/agent-slack/commit/48dd44150fbd66f62e267c290fefb423e9b57806))
* **self-improve:** collector 读取 events.jsonl 并增 SessionSummary debug log ([87412cb](https://github.com/winchesHe/agent-slack/commit/87412cbe703882b34fb30d55a0dedf619671438b))
* **self-improve:** P5 双 tool 实现 + ConfirmSender 透传 ([e75d6d6](https://github.com/winchesHe/agent-slack/commit/e75d6d6408e4a480379ed55d766ed86e6a500650))
* **self-improve:** 新增数据收集器 (P3) ([0cd7a66](https://github.com/winchesHe/agent-slack/commit/0cd7a6675ffbd3b9cffab48a9587d5fbf8046b80))
* **self-improve:** 新增规则编写约束常量 (P2) ([94f2286](https://github.com/winchesHe/agent-slack/commit/94f2286b6783f9c50ce0b91e738ee33053b18b68))
* **self-improve:** 规则落盘 experience.md + P6 语义去重 + 门槛收紧 ([1840237](https://github.com/winchesHe/agent-slack/commit/18402374fa8e7af5cec623d695436b2715eaeb4b))
* **slack:** SlackAdapter 接入通用 confirm action 路由 (P1) ([c45e069](https://github.com/winchesHe/agent-slack/commit/c45e0691f84a6e4b5cefaa7ea49b9713d97dcd55))
* **slack:** 新增通用 SlackConfirm 模块并修复 typeerror ([ea710b8](https://github.com/winchesHe/agent-slack/commit/ea710b83d5f0040b22fee1758bea58e6f9e2df04))
* **store:** SessionStore 增加 appendEvent 追加 events.jsonl ([f6ffd85](https://github.com/winchesHe/agent-slack/commit/f6ffd8562607c2c766e151bb095029be900dbf0e))
* update AGENTS ([636626d](https://github.com/winchesHe/agent-slack/commit/636626dbf9da2da53859685b29c5c627baf25fe7))
* 增加 Slack 结束尾巴统计 ([be03175](https://github.com/winchesHe/agent-slack/commit/be03175a7f5d4fb09c0ce3ee0cf9de1f7619cab1))
