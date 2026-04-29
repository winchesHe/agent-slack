// Dashboard 常用配置字段元数据（**与 ConfigSchema 平行声明**，AGENTS.md "Env / Config 变更联动规则" 第 4 项约束）。
//
// 加新字段：判断是否常用 → 加入这里 + Schema + generator；不常用则仅在 raw YAML 兜底里调即可。
//
// 字段类型说明：
// - text: 普通字符串
// - number: 数字
// - boolean: 复选框
// - select: 枚举（options 必填）
// - array-of-strings: 字符串数组（前端按多行/逗号分隔输入）

export type ConfigFieldType = 'text' | 'number' | 'boolean' | 'select' | 'array-of-strings'

export interface ConfigField {
  // path 数组：例如 ['agent', 'context', 'autoCompact', 'enabled']
  path: string[]
  // 表单展示的字段标签（中文）
  label: string
  type: ConfigFieldType
  // type='select' 时必填
  options?: string[]
  // 字段说明（tooltip）
  help?: string
}

export const COMMON_CONFIG_FIELDS: ConfigField[] = [
  // ---- agent 基础 ----
  { path: ['agent', 'name'], label: 'agent.name', type: 'text', help: '日志/dashboard 标识' },
  {
    path: ['agent', 'provider'],
    label: 'agent.provider',
    type: 'select',
    options: ['litellm', 'anthropic', 'openai-responses'],
    help: '行为配置唯一权威；不要用 env 切换',
  },
  { path: ['agent', 'model'], label: 'agent.model', type: 'text', help: '需要与 provider 对应' },
  {
    path: ['agent', 'maxSteps'],
    label: 'agent.maxSteps',
    type: 'number',
    help: '单轮 run 最多调用模型/工具步数',
  },

  // ---- agent.responses（仅 provider=openai-responses 生效）----
  {
    path: ['agent', 'responses', 'reasoningEffort'],
    label: 'responses.reasoningEffort',
    type: 'select',
    options: ['low', 'medium', 'high'],
    help: 'OpenAI 推理预算档位（仅 openai-responses 生效）',
  },
  {
    path: ['agent', 'responses', 'reasoningSummary'],
    label: 'responses.reasoningSummary',
    type: 'select',
    options: ['auto', 'concise', 'detailed'],
    help: '是否在响应里附带 reasoning summary 文字',
  },

  // ---- agent.context ----
  {
    path: ['agent', 'context', 'maxApproxChars'],
    label: 'context.maxApproxChars',
    type: 'number',
    help: '模型视图字符预算；约 3 字符 ≈ 1 token',
  },
  {
    path: ['agent', 'context', 'keepRecentMessages'],
    label: 'context.keepRecentMessages',
    type: 'number',
    help: '最近消息数上限',
  },
  {
    path: ['agent', 'context', 'keepRecentToolResults'],
    label: 'context.keepRecentToolResults',
    type: 'number',
    help: '保留完整 tool 结果的最近条数',
  },
  {
    path: ['agent', 'context', 'autoCompact', 'enabled'],
    label: 'autoCompact.enabled',
    type: 'boolean',
    help: '达到预算阈值时先整理上下文再继续',
  },
  {
    path: ['agent', 'context', 'autoCompact', 'triggerRatio'],
    label: 'autoCompact.triggerRatio',
    type: 'number',
    help: '触发压缩的预算比例（0-1）',
  },

  // ---- skills ----
  {
    path: ['skills', 'enabled'],
    label: 'skills.enabled',
    type: 'array-of-strings',
    help: "['*'] = 启用全部；或填具体 skill 名称",
  },

  // ---- im ----
  {
    path: ['im', 'slack', 'resolveChannelName'],
    label: 'im.slack.resolveChannelName',
    type: 'boolean',
    help: '是否调 Slack API 解析 channel name',
  },

  // ---- daemon ----
  { path: ['daemon', 'host'], label: 'daemon.host', type: 'text', help: '默认 127.0.0.1' },
  { path: ['daemon', 'port'], label: 'daemon.port', type: 'number', help: '默认 51732' },
]

export interface ConfigFieldUpdate {
  path: string[]
  value: unknown
}
