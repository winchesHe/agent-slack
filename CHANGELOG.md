## [0.1.9](https://github.com/winchesHe/agent-slack/compare/v0.1.8...v0.1.9) (2026-05-12)


### Bug Fixes

* **compact:** align tool-call/tool-result fixture with ai-sdk schema ([ab7656c](https://github.com/winchesHe/agent-slack/commit/ab7656c18101acdc1cf3a92242ade39eed48a17a))
* **compact:** widen COMPACT_INPUT_MAX_CHARS 120K→1M (transition) ([d97e2c0](https://github.com/winchesHe/agent-slack/commit/d97e2c06c81d08d24f2c360a74bd2d219db61ecb))
* **e2e:** findReplyContaining 严格按 botUserId 过滤防 false-positive ([f774b18](https://github.com/winchesHe/agent-slack/commit/f774b180a721bb6077351403ebb9e7dfdb5a8cc6))
* **logger:** redactor 展开嵌套 Error，修 {err:{}} 黑洞 ([e88299b](https://github.com/winchesHe/agent-slack/commit/e88299ba30d8c9722935397757172341e6004f7f))
* **wechat:** prepareForManualRun 写 baseUrl 时补 trailing / 归一化 ([029cc03](https://github.com/winchesHe/agent-slack/commit/029cc034432ba30d4fead22a499714f1176062b9))


### Features

* **app:** createApplication 装配 WechatAdapter ([db8ed16](https://github.com/winchesHe/agent-slack/commit/db8ed1682677b560accab72dbc10f75a8142c7a7))
* **cli:** scheduled-tasks run <id> 子命令 + wechat prepareForManualRun ([055b78d](https://github.com/winchesHe/agent-slack/commit/055b78d6c3358dd6be7c38e227a73f3d0c44ead8))
* **compact:** add deterministic 1m-char history fixture for e2e ([2b727fd](https://github.com/winchesHe/agent-slack/commit/2b727fd44b1b7e614ad581ba8e24c63511639ce9))
* **compact:** add groupMessagesByApiRound pure function ([d5a58d7](https://github.com/winchesHe/agent-slack/commit/d5a58d73523e8513c40b7544f86d6b187d75cc3e))
* **compact:** add stripImagesFromMessages pure function ([c00dddc](https://github.com/winchesHe/agent-slack/commit/c00dddc2d3709741b981c9313892f93e8b871872))
* **compact:** emit 4 compact event types to events.jsonl ([7fc4b68](https://github.com/winchesHe/agent-slack/commit/7fc4b68e34e737f801df3adc2120854522ddb056))
* **compact:** formatCompactSummary handles <analysis>/<summary>; drop noise filter ([acbfd2f](https://github.com/winchesHe/agent-slack/commit/acbfd2fd6f86b73d0803389c61de160cf475bf42))
* **compact:** preprocess input with tool_result placeholder + image strip ([0f63db5](https://github.com/winchesHe/agent-slack/commit/0f63db534011807792d845841d5422f18fd50b42))
* **compact:** PTL retry with API-round truncation; remove input hardcap ([4c03b9a](https://github.com/winchesHe/agent-slack/commit/4c03b9a85a40606ab12dc7382c25c3a44afb78d5))
* **compact:** rewrite system prompt with 9 sections + analysis/summary dual block ([b05e78c](https://github.com/winchesHe/agent-slack/commit/b05e78c5eebcabb90e24a5127c59342ea91b9234))
* **compact:** trigger judgement uses real apiInputTokens when available ([cadbf22](https://github.com/winchesHe/agent-slack/commit/cadbf2283488f425bc80d6083eccf7bf99ce3366))
* **e2e:** scenario 跑完自动清理对应 Slack session 目录 ([0816609](https://github.com/winchesHe/agent-slack/commit/08166097b636129c3d0d1d4637ba85d6e64f5f8c))
* **executor:** expose lastApiInputTokens in usage-info (override semantics) ([927bfbb](https://github.com/winchesHe/agent-slack/commit/927bfbb5b8fc959ea6c0ad1cd3f45d3f58715448))
* **im:** adapters 返回 handle 结构（adapter + scheduledHook） ([d5ebb71](https://github.com/winchesHe/agent-slack/commit/d5ebb71cbb2114c17885f72aed7592a7621f7abf))
* **scheduledTasks:** config schema + loader ([0147054](https://github.com/winchesHe/agent-slack/commit/0147054d668650d5920acb88752553b408e2d21f))
* **scheduledTasks:** createApplication 装配 runner+scheduler + 接入 daemon 生命周期 ([0a8e9a5](https://github.com/winchesHe/agent-slack/commit/0a8e9a53df3d48b3843e827b84ae145df91a1d2f))
* **scheduledTasks:** jsonl run history（按文件串行化） ([ac23dee](https://github.com/winchesHe/agent-slack/commit/ac23dee98dd762e78960dedb007d84b8318f60db))
* **scheduledTasks:** runner with hook 路由 + history 写入 ([b7c6370](https://github.com/winchesHe/agent-slack/commit/b7c6370ce230961d0cf192d1aac5314517455d49))
* **scheduledTasks:** scaffold types + add croner dep ([e93d546](https://github.com/winchesHe/agent-slack/commit/e93d546be87b98227e4958da47acdb68dbc11925))
* **scheduledTasks:** scheduler + cron 注入式工厂 ([39bd130](https://github.com/winchesHe/agent-slack/commit/39bd130e607f91ea5c0b58a7fa68d6ea24a45cdd))
* **slack:** runScheduledSlackSession + 接通 scheduledHook ([54113c6](https://github.com/winchesHe/agent-slack/commit/54113c6b6ff498e6df2326f2ebeff2d4a7c72be4))
* **store:** force message id on appendMessage ([b01655d](https://github.com/winchesHe/agent-slack/commit/b01655dd2742098788afa7faa9eccfd3f82cad8c))
* **store:** loadMessages defaults to compact-boundary slicing; add loadFullTranscript ([f4b968d](https://github.com/winchesHe/agent-slack/commit/f4b968d4c53cb27bd5153706892303cc544f5cea))
* **store:** persist lastUsage snapshot to meta.context.lastUsage ([52ee43b](https://github.com/winchesHe/agent-slack/commit/52ee43b73de4294991339dc355971c0033118de9))
* **telegram:** 新增 Telegram outbound 适配 承载 scheduled tasks ([417452c](https://github.com/winchesHe/agent-slack/commit/417452c87a13c083663a5d7e7860c88fbc4e87d9))
* **wechat:** ContextTokenStore（per-peer context_token 持久化） ([8691340](https://github.com/winchesHe/agent-slack/commit/86913409da249c36ea95f8e5ad6c17f4420498f3))
* **wechat:** CredentialsStore 实现 + 测试 ([ebef4ce](https://github.com/winchesHe/agent-slack/commit/ebef4ce0d89ee4888fd741381085d6900774e695))
* **wechat:** runScheduledWechatSession + 接通 scheduledHook ([dce93f7](https://github.com/winchesHe/agent-slack/commit/dce93f776e12744cb80ed5414501b24f32d63239))
* **wechat:** scheduled 路径按 target.to 从 ContextTokenStore 查 token ([15d59fe](https://github.com/winchesHe/agent-slack/commit/15d59fe916a893e741494cea122fabfa89b62af7))
* **wechat:** WechatAdapter inbound 路径落盘 contextToken ([e902022](https://github.com/winchesHe/agent-slack/commit/e90202278b9893b649f06511ff4d32a8a606a256))
* **wechat:** WechatAdapter 完整实现（扫码登录 + long-poll + processMessage） ([ca354ad](https://github.com/winchesHe/agent-slack/commit/ca354ade2ffcb70876e0b8024bd19fe9fb631b8f))
* **wechat:** WechatApi HTTP 客户端 + ilink 协议类型 ([470c91b](https://github.com/winchesHe/agent-slack/commit/470c91b9126f3b64efbb9463b5b1bc48e7ef82bc))
* **wechat:** WechatRenderer + WechatEventSink ([45bf8af](https://github.com/winchesHe/agent-slack/commit/45bf8af51213118a766210e5a90b69d9a808e14b))
* **workspace:** scheduled-tasks.yaml 模板 + upgrade target 注册 ([d8dab02](https://github.com/winchesHe/agent-slack/commit/d8dab024f3fac1103310fc037728f0d351e3de7f))



## [0.1.8](https://github.com/winchesHe/agent-slack/compare/v0.1.7...v0.1.8) (2026-04-30)



## [0.1.7](https://github.com/winchesHe/agent-slack/compare/v0.1.6...v0.1.7) (2026-04-29)


### Features

* **cli:** agent-slack upgrade 追加式补齐缺失顶层字段，--dry-run + 自动备份 ([16575d3](https://github.com/winchesHe/agent-slack/commit/16575d3d9a9fa9ac031a8ff09bd13524e9d18520))
* **dashboard:** Config tab 常用字段表单 + Raw YAML 兜底，局部覆盖保留中文注释 ([3782624](https://github.com/winchesHe/agent-slack/commit/3782624b427a793937326b72fadc27b17f4a8454))
* **slack/sink:** reasoning chat.update 1.2s 时间窗节流，止 Slack 限速 ([fc4ba6c](https://github.com/winchesHe/agent-slack/commit/fc4ba6cb2df764ea6e713599d293b333870d6ca9))
* **slack/usage:** :agent_time: 超过 1 分钟改 Xm Ys 复合显示 ([946314e](https://github.com/winchesHe/agent-slack/commit/946314e77c5df3eba29071a9d66b12792ad6a0e8))



## [0.1.6](https://github.com/winchesHe/agent-slack/compare/v0.1.5...v0.1.6) (2026-04-29)


### Bug Fixes

* **config:** align maxApproxChars test with schema default 900_000 ([0cb89b6](https://github.com/winchesHe/agent-slack/commit/0cb89b69b8c8d0bb2cc457f94b3634a4ffaed670))
* **provider:** turn off OpenAI Responses strict function schemas ([bcbf709](https://github.com/winchesHe/agent-slack/commit/bcbf709f121725bab29aec7015c853c7cd50b2bc))


### Features

* **config:** extend agent.provider with 'openai-responses' + responses sub-config ([57d818e](https://github.com/winchesHe/agent-slack/commit/57d818e19363e5f1f9c3a2697be2ec5aa422ba5a))
* **events:** add reasoningTokens to SessionUsageInfo.modelUsage ([e303995](https://github.com/winchesHe/agent-slack/commit/e30399548977d9896a824ac6ed278852b55562b4))
* **executor:** aggregate openai.reasoningTokens into SessionUsageInfo ([bbb5bd3](https://github.com/winchesHe/agent-slack/commit/bbb5bd35bdb3a800dcdbf16a565ed49ccca6c89e))
* **executor:** pass extraProviderOptions through streamText ([0867cb1](https://github.com/winchesHe/agent-slack/commit/0867cb1bd3e089b7670f4972b290f7506f779096))
* **provider:** wire 'openai-responses' provider via @ai-sdk/openai responses factory ([41a93b4](https://github.com/winchesHe/agent-slack/commit/41a93b48cc4339d10f4059ac50521abd4e9d3955))
* **slack:** append (N thinking) segment to usage line when reasoning tokens present ([469f17d](https://github.com/winchesHe/agent-slack/commit/469f17de799ed2707e2a9f5d42a47eecb33556b4))
* **slack:** use :fluent-thinking-3d: emoji in reasoning progress block ([5f62ebc](https://github.com/winchesHe/agent-slack/commit/5f62ebcb0a42f8d68de5e8e15801c785392a1fdf))



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
