# P0：Multi-Agent Runtime 实施计划

> **For agentic workers:** REQUIRED: 用 superpowers:subagent-driven-development（如有 subagent）或 superpowers:executing-plans 实施本计划。Steps 用 checkbox (`- [ ]`) 跟踪进度。

**Spec 对照**：[`docs/superpowers/specs/2026-04-27-slack-multi-agent-design.md`](../specs/2026-04-27-slack-multi-agent-design.md)（以下简称 spec）。实现与 spec 冲突时以 spec 为准；需改先改 spec。

**Goal**：搭起 Multi-Agent 的 runtime 骨架——A2A 总线、task 黑板、worktree 管理器、三个新 tool、ConversationOrchestrator 多 Agent 化、config/sessions 路径加 agentId 维度并向后兼容——**全程不接 Slack**，靠单元测试 + 集成测试投 envelope 验证。

**Architecture**：文件态持久化（无新依赖）；A2ABus 是内存事件总线 + 同步落 envelope 文件；ConversationOrchestrator 的 sessionKey 增加 agentId；现有 42KB orchestrator 测试套全部以 `agentId='default'` 跑通后再加 multi-agent 路径；config 旧 `agent.*` 字段启动时自动迁移成 `agents:[{id:'default',role:'generic',...}]`。

**Tech Stack**：TypeScript 5.6 / Node 22 / Vitest / pnpm workspace / `proper-lockfile` (新增依赖) / 复用现有 ai-sdk / consola / zod / yaml。

**Range**：spec §3-§7、§13 P0 行所有产出物 + §12 单 Agent 回归测试清单。

**不包含**：Slack 多 SocketMode（P1）、3 个角色 system prompt 模板的最终内容（P2）、dashboard 多 Agent tab（P3）、live e2e（P3）。

---

## 原则

- **TDD**：每个新模块先写失败的测试，再写实现。
- **Bite-sized commits**：每个 Task 独立 commit，message 中文。
- **单 Agent 零回归**：所有现有 42KB ConversationOrchestrator 测试 + 全部 vitest 必须在每次 commit 后保持通过。**任何一次 chunk 结束 `pnpm test && pnpm typecheck` 不全绿，停下修复再继续**。
- **每个 chunk 末尾用户 review 门禁**：chunk 完成后给出可观测验证（test 输出 / CLI 实跑），等用户确认再进下一个 chunk。
- **Import 风格**：新模块 `src/multiAgent/` 内部互引用全部用相对路径（`./foo.ts`）；跨包引用用 `@/...` alias（与现有 `src/workspace/`、`src/store/` 等保持一致）。
- **测试 logger**：测试中需要 Logger 的地方统一用现有 `src/workspace/SkillLoader.test.ts` 里的 `stubLogger` 模式，inline 在测试文件内部定义，不引入全局 helper。

---

## 文件结构（新增 / 修改）

### 新增文件

| 路径 | 责任 |
|---|---|
| `src/multiAgent/types.ts` | A2AEnvelope / TaskBoard / AgentId 等类型 + zod schema |
| `src/multiAgent/A2ABus.ts` | 内存事件总线 + envelope 文件落盘 |
| `src/multiAgent/TaskBoard.ts` | task.json 读写 + 文件锁 + prompt 渲染 |
| `src/multiAgent/WorktreeManager.ts` | per-task git worktree 创建/复用/清理 |
| `src/multiAgent/RolePromptLoader.ts` | system.md + system.<role>.md 拼装 |
| `src/multiAgent/migrateConfig.ts` | 旧 `agent.*` → `agents:[]` 自动迁移 |
| `src/multiAgent/A2ABus.test.ts` | 总线 + 落盘单测 |
| `src/multiAgent/TaskBoard.test.ts` | 黑板读写 + 锁 + 渲染单测 |
| `src/multiAgent/WorktreeManager.test.ts` | worktree 生命周期单测 |
| `src/multiAgent/RolePromptLoader.test.ts` | 拼装策略单测 |
| `src/multiAgent/migrateConfig.test.ts` | 迁移逻辑单测 |
| `src/agent/tools/delegateTo.ts` | `delegate_to` tool |
| `src/agent/tools/escalateToUser.ts` | `escalate_to_user` tool |
| `src/agent/tools/updateTaskBoard.ts` | `update_task_board` tool |
| `src/agent/tools/multiAgentTools.test.ts` | 三个 tool 单测 |
| `src/multiAgent/integration.test.ts` | PM + Coding 端到端 fixture 集成测试 |

### 修改文件

| 路径 | 改动 | 风险 |
|---|---|---|
| [`src/workspace/config.ts`](../../../src/workspace/config.ts) | `ConfigSchema` 加 `agents[]`；保留 `agent` 触发迁移 | 低（向后兼容） |
| [`src/workspace/paths.ts`](../../../src/workspace/paths.ts) | `slackSessionDir` 加 `agentId`；新增 `taskDir`/`taskBoardFile`/`envelopeFile`/`worktreeDir` | 低 |
| [`src/workspace/WorkspaceContext.ts`](../../../src/workspace/WorkspaceContext.ts) | 装配多 agent 时返回 `agents` 列表 + 每 agent 的 systemPrompt | 中 |
| [`src/store/SessionStore.ts`](../../../src/store/SessionStore.ts) | sessionKey 加 `agentId` 维度 | 中 |
| [`src/orchestrator/ConversationOrchestrator.ts`](../../../src/orchestrator/ConversationOrchestrator.ts) | 加 agentId 上下文 + A2A inbox 处理 + `<waiting/>` turn pause/resume | **高** |
| [`src/agent/tools/index.ts`](../../../src/agent/tools/index.ts) | 注册三个新 tool | 低 |
| [`src/application/createApplication.ts`](../../../src/application/createApplication.ts) | 循环装配 N 个 orchestrator + A2ABus 共享 | 中 |
| [`package.json`](../../../package.json) | 加 `proper-lockfile` 依赖 | 低 |

---

## Chunk 1：基础类型 + 配置迁移

**目标**：把 schema、路径、迁移逻辑改完，让 `pnpm test` 在新结构下保持全绿（单 Agent 路径继续跑）。

### Task 1.1：定义共享类型 + zod schema

**Files:**
- Create: `src/multiAgent/types.ts`

- [ ] **Step 1：写 types.ts**

```ts
import { z } from 'zod'

export const AgentIdSchema = z.string().regex(/^[a-z][a-z0-9_]*$/, {
  message: 'agent id 必须以小写字母开头，只能含小写字母/数字/下划线',
})
export type AgentId = z.infer<typeof AgentIdSchema>

export const AgentRoleSchema = z.enum(['generic', 'pm', 'coding', 'cs'])
export type AgentRole = z.infer<typeof AgentRoleSchema>

export const A2AEnvelopeSchema = z.object({
  id: z.string().startsWith('env_'),
  taskId: z.string().startsWith('tsk_'),
  from: z.union([z.literal('user'), AgentIdSchema]),
  to: z.union([AgentIdSchema, z.literal('thread')]),
  intent: z.enum(['delegate', 'reply', 'broadcast', 'final']),
  parentId: z.string().startsWith('env_').optional(),
  content: z.string(),
  references: z
    .array(
      z.object({
        kind: z.enum(['file', 'url', 'session', 'envelope']),
        value: z.string(),
      }),
    )
    .optional(),
  createdAt: z.string(),
})
export type A2AEnvelope = z.infer<typeof A2AEnvelopeSchema>

export const TaskBoardSchema = z.object({
  taskId: z.string().startsWith('tsk_'),
  threadTs: z.string(),
  channelId: z.string(),
  originalUser: z.string(),
  goal: z.string(),
  state: z.enum(['active', 'awaiting_agent', 'awaiting_user', 'done', 'aborted']),
  activeAgent: AgentIdSchema.nullable(),
  worktreePath: z.string().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
  scratchpad: z.object({
    facts: z.array(z.string()).default([]),
    decisions: z.array(z.string()).default([]),
    openQuestions: z.array(z.string()).default([]),
  }),
})
export type TaskBoard = z.infer<typeof TaskBoardSchema>

export function newEnvelopeId(): string {
  return 'env_' + generateShortId()
}
export function newTaskId(): string {
  return 'tsk_' + generateShortId()
}

// 时间戳前缀 + 8 字符随机；非规范 ULID（不需要单调保证），仅用于 envelope/task 标识
function generateShortId(): string {
  const ts = Date.now().toString(36).padStart(10, '0')
  const rand = Array.from({ length: 8 }, () =>
    Math.floor(Math.random() * 36).toString(36),
  ).join('')
  return ts + rand
}
```

- [ ] **Step 2：commit**

```bash
git add src/multiAgent/types.ts
git commit -m "feat(multiAgent): 添加 A2A envelope/TaskBoard 类型与 zod schema"
```

### Task 1.2：扩展 ConfigSchema 支持 agents[] + 兼容旧 agent 字段

**Files:**
- Modify: `src/workspace/config.ts`
- Test: `src/workspace/config.test.ts`

- [ ] **Step 1：先写失败的测试**

在 `src/workspace/config.test.ts` 末尾追加：

```ts
describe('multi-agent schema', () => {
  const baseAgent = {
    id: 'default',
    name: 'default',
    role: 'generic',
    model: 'gpt-5.4',
    maxSteps: 50,
    provider: 'litellm',
    slack: {
      botTokenEnv: 'SLACK_BOT_TOKEN',
      appTokenEnv: 'SLACK_APP_TOKEN',
      signingSecretEnv: 'SLACK_SIGNING_SECRET',
    },
  }

  it('parses agents[] when explicitly provided', () => {
    const c = parseConfig({ agents: [baseAgent] })
    expect(c.agents).toHaveLength(1)
    expect(c.agents[0].id).toBe('default')
    expect(c.agents[0].role).toBe('generic')
    expect(c.agents[0].provider).toBe('litellm')
  })

  it('rejects empty agents array', () => {
    expect(() => parseConfig({ agents: [] })).toThrow()
  })

  it('rejects duplicate agent ids', () => {
    expect(() =>
      parseConfig({
        agents: [
          { ...baseAgent, id: 'pm', role: 'pm' },
          { ...baseAgent, id: 'pm', role: 'coding' },
        ],
      }),
    ).toThrow(/重复/)
  })
})
```

- [ ] **Step 2：跑测试看它失败**

Run: `pnpm test src/workspace/config.test.ts`
Expected: 3 failures（parseConfig 暂不识别 agents 字段）

- [ ] **Step 3：改 ConfigSchema**

```ts
import { AgentIdSchema, AgentRoleSchema } from '@/multiAgent/types.ts'

const AgentSlackSchema = z.object({
  botTokenEnv: z.string(),
  appTokenEnv: z.string(),
  signingSecretEnv: z.string(),
})

const AgentContextSchema = z
  .object({
    maxApproxChars: z.number().int().positive().default(240_000),
    keepRecentMessages: z.number().int().positive().default(80),
    keepRecentToolResults: z.number().int().positive().default(20),
    autoCompact: z
      .object({
        enabled: z.boolean().default(true),
        triggerRatio: z.number().positive().max(1).default(0.8),
        maxFailures: z.number().int().positive().default(2),
      })
      .default({}),
  })
  .default({})

const AgentConfigSchema = z.object({
  id: AgentIdSchema,
  name: z.string().default('default'),                       // ← 显示用，dashboard/status 引用
  role: AgentRoleSchema,
  model: z.string(),
  maxSteps: z.number().int().positive().default(50),
  // provider 仍是单 agent 单值（v1 三个 agent 共用一个 provider env）；保留在每 agent 上
  // 以便未来支持每 agent 用不同 provider，但 P0 只取 agents[0].provider
  provider: z.enum(['litellm', 'anthropic']).default('litellm'),
  context: AgentContextSchema,
  slack: AgentSlackSchema,
})

export const ConfigSchema = z
  .object({
    // 兼容旧字段；preprocess 阶段会被迁移成 agents[] 后丢弃
    agent: z.unknown().optional(),
    agents: z.array(AgentConfigSchema).min(1).optional(),
    skills: z.object({ enabled: z.array(z.string()).default(['*']) }).default({}),
    im: z
      .object({
        provider: z.literal('slack').default('slack'),
        slack: z.object({ resolveChannelName: z.boolean().default(true) }).default({}),
      })
      .default({}),
    daemon: z
      .object({
        port: z.number().int().min(0).max(65535).default(51732),
        host: z.string().default('127.0.0.1'),
      })
      .default({}),
  })
  .superRefine((cfg, ctx) => {
    if (!cfg.agents) {
      ctx.addIssue({ code: 'custom', message: 'agents 必填（旧 agent.* 请用 agent-slack upgrade 迁移）' })
      return
    }
    const seen = new Set<string>()
    for (const a of cfg.agents) {
      if (seen.has(a.id)) {
        ctx.addIssue({ code: 'custom', message: `agent id 重复：${a.id}` })
      }
      seen.add(a.id)
    }
  })

export type WorkspaceConfig = z.infer<typeof ConfigSchema>
export type AgentConfig = z.infer<typeof AgentConfigSchema>

export const DEFAULT_AGENT: AgentConfig = AgentConfigSchema.parse({
  id: 'default',
  name: 'default',
  role: 'generic',
  model: 'gpt-5.4',
  maxSteps: 50,
  provider: 'litellm',
  slack: {
    botTokenEnv: 'SLACK_BOT_TOKEN',
    appTokenEnv: 'SLACK_APP_TOKEN',
    signingSecretEnv: 'SLACK_SIGNING_SECRET',
  },
})

export const DEFAULT_CONFIG: WorkspaceConfig = ConfigSchema.parse({ agents: [DEFAULT_AGENT] })

export function parseConfig(raw: unknown): WorkspaceConfig {
  return ConfigSchema.parse(raw)
}
```

注意：DEFAULT_CONFIG 的旧用法 `DEFAULT_CONFIG.agent.maxSteps` 会失效。下一步修旧测试。

- [ ] **Step 4：修复现有 config.test.ts 中的旧断言**

把 `DEFAULT_CONFIG.agent.maxSteps` 改为 `DEFAULT_CONFIG.agents[0].maxSteps`，`DEFAULT_CONFIG.agent.context` 改为 `DEFAULT_CONFIG.agents[0].context`。

- [ ] **Step 5：跑全套测试**

Run: `pnpm test`
Expected: `config.test.ts` 全绿（含新加的 3 个 it）；其他用 `ctx.config.agent` 的下游模块（createApplication / cli/status.ts / cli/doctor.ts / dashboard/api.ts / dashboard/ui.ts 等）此刻可能编译/运行失败 —— 在 Task 1.6 统一修。**先确认仅是 `ctx.config.agent` 引用导致的失败，不是新逻辑 bug**。

- [ ] **Step 6：commit**

```bash
git add src/workspace/config.ts src/workspace/config.test.ts
git commit -m "feat(workspace): config schema 支持 agents[]，单 Agent 表达为长度 1 数组"
```

### Task 1.3：实现 migrateConfig（旧 `agent.*` → `agents:[{default}]`）

**Files:**
- Create: `src/multiAgent/migrateConfig.ts`
- Test: `src/multiAgent/migrateConfig.test.ts`

- [ ] **Step 1：写失败测试**

```ts
import { describe, it, expect } from 'vitest'
import { migrateLegacyAgentField } from './migrateConfig.ts'

describe('migrateLegacyAgentField', () => {
  it('converts legacy agent.* into agents:[{default}] and preserves name/provider/maxSteps/model', () => {
    const legacy = {
      agent: { name: 'foo', model: 'gpt-5.4', maxSteps: 30, provider: 'anthropic' },
      skills: { enabled: ['*'] },
    }
    const { migrated, changed } = migrateLegacyAgentField(legacy)
    expect(changed).toBe(true)
    expect(migrated.agents).toEqual([
      expect.objectContaining({
        id: 'default',
        name: 'foo',
        role: 'generic',
        model: 'gpt-5.4',
        maxSteps: 30,
        provider: 'anthropic',
        slack: {
          botTokenEnv: 'SLACK_BOT_TOKEN',
          appTokenEnv: 'SLACK_APP_TOKEN',
          signingSecretEnv: 'SLACK_SIGNING_SECRET',
        },
      }),
    ])
    expect(migrated.agent).toBeUndefined()
  })

  it('is no-op when agents already present', () => {
    const cfg = { agents: [{ id: 'pm', role: 'pm' }] }
    const { migrated, changed } = migrateLegacyAgentField(cfg)
    expect(changed).toBe(false)
    expect(migrated).toBe(cfg)
  })

  it('returns changed=true and adds default agents when neither exists', () => {
    const { migrated, changed } = migrateLegacyAgentField({})
    expect(changed).toBe(true)
    expect(migrated.agents).toHaveLength(1)
    expect(migrated.agents[0].id).toBe('default')
  })
})
```

- [ ] **Step 2：运行确认失败**

Run: `pnpm test src/multiAgent/migrateConfig.test.ts`
Expected: 文件不存在错误

- [ ] **Step 3：实现 migrateConfig.ts**

```ts
export interface MigrationResult {
  migrated: Record<string, unknown>
  changed: boolean
}

const DEFAULT_SLACK = {
  botTokenEnv: 'SLACK_BOT_TOKEN',
  appTokenEnv: 'SLACK_APP_TOKEN',
  signingSecretEnv: 'SLACK_SIGNING_SECRET',
}

export function migrateLegacyAgentField(raw: unknown): MigrationResult {
  if (typeof raw !== 'object' || raw === null) {
    return { migrated: { agents: [defaultAgent()] }, changed: true }
  }
  const obj = raw as Record<string, unknown>
  if (Array.isArray(obj.agents) && obj.agents.length > 0) {
    return { migrated: obj, changed: false }
  }
  const legacy = (obj.agent ?? {}) as Record<string, unknown>
  const next = { ...obj }
  delete next.agent
  next.agents = [
    {
      id: 'default',
      name: typeof legacy.name === 'string' ? legacy.name : 'default',
      role: 'generic',
      model: typeof legacy.model === 'string' ? legacy.model : 'gpt-5.4',
      maxSteps: typeof legacy.maxSteps === 'number' ? legacy.maxSteps : 50,
      provider:
        legacy.provider === 'anthropic' || legacy.provider === 'litellm'
          ? legacy.provider
          : 'litellm',
      ...(typeof legacy.context === 'object' && legacy.context !== null
        ? { context: legacy.context }
        : {}),
      slack: DEFAULT_SLACK,
    },
  ]
  return { migrated: next, changed: true }
}

function defaultAgent(): Record<string, unknown> {
  return {
    id: 'default',
    name: 'default',
    role: 'generic',
    model: 'gpt-5.4',
    maxSteps: 50,
    provider: 'litellm',
    slack: DEFAULT_SLACK,
  }
}
```

- [ ] **Step 4：跑测试**

Run: `pnpm test src/multiAgent/migrateConfig.test.ts`
Expected: 3 PASS

- [ ] **Step 5：commit**

```bash
git add src/multiAgent/migrateConfig.ts src/multiAgent/migrateConfig.test.ts
git commit -m "feat(multiAgent): 旧 agent.* 字段自动迁移成 agents:[{default}]"
```

### Task 1.4：在启动期串入 migrateConfig 并写回 yaml

**Files:**
- Modify: `src/workspace/WorkspaceContext.ts`
- Test: `src/workspace/WorkspaceContext.test.ts`

**当前 WorkspaceContext 装配关键代码（[`WorkspaceContext.ts:25-29`](../../../src/workspace/WorkspaceContext.ts)）**：

```ts
const config = existsSync(paths.configFile)
  ? parseConfig(YAML.parse(await readFile(paths.configFile, 'utf8')))
  : parseConfig({})
```

迁移逻辑插在 `YAML.parse(...)` 与 `parseConfig(...)` 之间。

- [ ] **Step 1：先写失败的集成测试**

在 `src/workspace/WorkspaceContext.test.ts` 末尾追加（用现有 [`SkillLoader.test.ts:9-21`](../../../src/workspace/SkillLoader.test.ts) 的 stubLogger 模式，inline 在文件内部）：

```ts
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { Logger } from '@/logger/logger.ts'

const stubLogger: Logger = {
  withTag: () => stubLogger,
  trace: () => {},
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
}

it('automatically migrates legacy agent.* config and writes backup', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-slack-mig-'))
  await fs.mkdir(path.join(dir, '.agent-slack'), { recursive: true })
  await fs.writeFile(
    path.join(dir, '.agent-slack', 'config.yaml'),
    `agent:\n  name: foo\n  model: gpt-5.4\n  maxSteps: 30\n  provider: anthropic\n`,
  )
  const ctx = await loadWorkspaceContext(dir, stubLogger)
  expect(ctx.config.agents).toHaveLength(1)
  expect(ctx.config.agents[0].id).toBe('default')
  expect(ctx.config.agents[0].name).toBe('foo')
  expect(ctx.config.agents[0].provider).toBe('anthropic')
  expect(ctx.config.agents[0].maxSteps).toBe(30)
  // 备份存在
  const files = await fs.readdir(path.join(dir, '.agent-slack'))
  expect(files.some((f) => f.startsWith('config.yaml.bak.'))).toBe(true)
  // 原 yaml 已被改写
  const newYaml = await fs.readFile(path.join(dir, '.agent-slack', 'config.yaml'), 'utf8')
  expect(newYaml).toContain('agents:')
  expect(newYaml).not.toMatch(/^agent:\s*$/m)
})

it('is no-op when config.yaml already has agents[]', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-slack-mig-noop-'))
  await fs.mkdir(path.join(dir, '.agent-slack'), { recursive: true })
  const yamlContent = [
    'agents:',
    '  - id: default',
    '    name: default',
    '    role: generic',
    '    model: gpt-5.4',
    '    maxSteps: 50',
    '    provider: litellm',
    '    slack:',
    '      botTokenEnv: SLACK_BOT_TOKEN',
    '      appTokenEnv: SLACK_APP_TOKEN',
    '      signingSecretEnv: SLACK_SIGNING_SECRET',
    '',
  ].join('\n')
  await fs.writeFile(path.join(dir, '.agent-slack', 'config.yaml'), yamlContent)
  await loadWorkspaceContext(dir, stubLogger)
  const files = await fs.readdir(path.join(dir, '.agent-slack'))
  // 没有产生备份
  expect(files.some((f) => f.startsWith('config.yaml.bak.'))).toBe(false)
})
```

- [ ] **Step 2：跑测试看失败**

Run: `pnpm test src/workspace/WorkspaceContext.test.ts`
Expected: 上面 2 个新 it 失败；现有用例保持通过状态

- [ ] **Step 3：在 WorkspaceContext 中接入迁移**

修改 [`src/workspace/WorkspaceContext.ts`](../../../src/workspace/WorkspaceContext.ts) 的 `loadWorkspaceContext`，把现有的：

```ts
const config = existsSync(paths.configFile)
  ? parseConfig(YAML.parse(await readFile(paths.configFile, 'utf8')))
  : parseConfig({})
```

替换为：

```ts
import { writeFile, copyFile } from 'node:fs/promises'
import path from 'node:path'
import { migrateLegacyAgentField } from '@/multiAgent/migrateConfig.ts'

let config: WorkspaceConfig
if (existsSync(paths.configFile)) {
  const raw = YAML.parse(await readFile(paths.configFile, 'utf8'))
  const isLegacy =
    raw && typeof raw === 'object' && 'agent' in (raw as object) && !Array.isArray((raw as Record<string, unknown>).agents)
  const { migrated } = migrateLegacyAgentField(raw)
  if (isLegacy) {
    const ts = new Date().toISOString().replace(/[:.]/g, '-')
    const bakPath = `${paths.configFile}.bak.${ts}`
    await copyFile(paths.configFile, bakPath)
    await writeFile(paths.configFile, YAML.stringify(migrated))
    logger.info(`已自动迁移 config.yaml（备份：${path.basename(bakPath)}）`)
  }
  config = parseConfig(migrated)
} else {
  config = parseConfig({})
}
```

注意：`raw` 可能为 `null`（YAML 空文件）/ 数组等异常情况；`isLegacy` 仅在 raw 是 object 且确实带 `agent` 字段时为真。其他场景走 `parseConfig({})` 的默认逻辑（migrate 也会兜底加 default agent）。

- [ ] **Step 4：跑测试**

Run: `pnpm test src/workspace/WorkspaceContext.test.ts`
Expected: 新加的 2 个 it 通过

- [ ] **Step 5：跑全套测试**

Run: `pnpm test`
Expected: 新 migrate 测试通过；其他下游模块（createApplication / status / doctor / dashboard 等用 `ctx.config.agent` 的地方）会 typecheck/runtime 失败 —— 在 Task 1.6 修。**先确认仅是 `ctx.config.agent` 引用导致的失败，不是新逻辑 bug**。

- [ ] **Step 6：commit**

```bash
git add src/workspace/WorkspaceContext.ts src/workspace/WorkspaceContext.test.ts
git commit -m "feat(workspace): 启动期自动迁移旧 agent.* 字段并备份原文件"
```

### Task 1.5：扩展 paths.ts，sessions/tasks/worktrees 路径加 agentId

**Files:**
- Modify: `src/workspace/paths.ts`
- Test: `src/workspace/paths.test.ts`

- [ ] **Step 1：先写新路径函数的失败测试**

```ts
import {
  resolveWorkspacePaths,
  slackSessionDir,
  taskDir,
  taskBoardFile,
  envelopeFile,
  worktreeDir,
} from './paths.ts'

describe('multi-agent paths', () => {
  const paths = resolveWorkspacePaths('/tmp/ws')

  it('slackSessionDir includes agentId segment', () => {
    expect(slackSessionDir(paths, 'general', 'C001', '1.2', 'pm')).toBe(
      '/tmp/ws/.agent-slack/sessions/slack/general.C001.1.2/pm',
    )
  })

  it('slackSessionDir defaults agentId to "default" when omitted', () => {
    expect(slackSessionDir(paths, 'general', 'C001', '1.2')).toBe(
      '/tmp/ws/.agent-slack/sessions/slack/general.C001.1.2/default',
    )
  })

  it('taskDir resolves under tasks/', () => {
    expect(taskDir(paths, 'tsk_abc')).toBe('/tmp/ws/.agent-slack/tasks/tsk_abc')
  })

  it('taskBoardFile resolves under tasks/<id>/task.json', () => {
    expect(taskBoardFile(paths, 'tsk_abc')).toBe(
      '/tmp/ws/.agent-slack/tasks/tsk_abc/task.json',
    )
  })

  it('envelopeFile resolves under tasks/<id>/envelopes/<eid>.json', () => {
    expect(envelopeFile(paths, 'tsk_abc', 'env_xyz')).toBe(
      '/tmp/ws/.agent-slack/tasks/tsk_abc/envelopes/env_xyz.json',
    )
  })

  it('worktreeDir resolves under worktrees/<id>/', () => {
    expect(worktreeDir(paths, 'tsk_abc')).toBe('/tmp/ws/.agent-slack/worktrees/tsk_abc')
  })
})
```

- [ ] **Step 2：跑测试看失败**

- [ ] **Step 3：在 paths.ts 实现**

```ts
export function slackSessionDir(
  paths: WorkspacePaths,
  channelName: string,
  channelId: string,
  threadTs: string,
  agentId: string = 'default',     // ★ 新增 default 参数
): string {
  const safe = sanitizeFsSegment(channelName)
  return path.join(paths.sessionsDir, 'slack', `${safe}.${channelId}.${threadTs}`, agentId)
}

export function taskDir(paths: WorkspacePaths, taskId: string): string {
  return path.join(paths.root, 'tasks', taskId)
}
export function taskBoardFile(paths: WorkspacePaths, taskId: string): string {
  return path.join(taskDir(paths, taskId), 'task.json')
}
export function envelopeFile(
  paths: WorkspacePaths,
  taskId: string,
  envelopeId: string,
): string {
  return path.join(taskDir(paths, taskId), 'envelopes', `${envelopeId}.json`)
}
export function worktreeDir(paths: WorkspacePaths, taskId: string): string {
  return path.join(paths.root, 'worktrees', taskId)
}
```

- [ ] **Step 4：跑路径单测通过**

- [ ] **Step 5：写老 sessions 自动迁移的失败测试**

新建 `src/workspace/migrateSessions.test.ts`：

```ts
import { describe, it, expect } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { migrateLegacySessions } from './migrateSessions.ts'
import { resolveWorkspacePaths } from './paths.ts'
import type { Logger } from '@/logger/logger.ts'

const stubLogger: Logger = {
  withTag: () => stubLogger,
  trace: () => {},
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
}

describe('migrateLegacySessions', () => {
  it('moves messages.jsonl from <thread>/ to <thread>/default/', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-slack-sm-'))
    const paths = resolveWorkspacePaths(dir)
    const threadDir = path.join(paths.sessionsDir, 'slack', 'general.C001.1.2')
    await fs.mkdir(threadDir, { recursive: true })
    await fs.writeFile(path.join(threadDir, 'messages.jsonl'), '{"role":"user"}\n')

    await migrateLegacySessions(paths, stubLogger)

    expect(
      await fs
        .stat(path.join(threadDir, 'default', 'messages.jsonl'))
        .then(() => true)
        .catch(() => false),
    ).toBe(true)
    expect(
      await fs
        .stat(path.join(threadDir, 'messages.jsonl'))
        .then(() => true)
        .catch(() => false),
    ).toBe(false)
  })

  it('skips threads already migrated (has subdirectories instead of messages.jsonl)', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-slack-sm2-'))
    const paths = resolveWorkspacePaths(dir)
    const threadDir = path.join(paths.sessionsDir, 'slack', 'general.C001.1.2', 'pm')
    await fs.mkdir(threadDir, { recursive: true })
    await fs.writeFile(path.join(threadDir, 'messages.jsonl'), '{}\n')

    await migrateLegacySessions(paths, stubLogger)

    // pm/messages.jsonl 还在原位
    expect(
      await fs.readFile(path.join(threadDir, 'messages.jsonl'), 'utf8'),
    ).toBe('{}\n')
  })

  it('is no-op when sessions dir does not exist', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-slack-sm3-'))
    const paths = resolveWorkspacePaths(dir)
    await migrateLegacySessions(paths, stubLogger) // 不应抛
  })
})
```

- [ ] **Step 6：跑测试看失败**

Run: `pnpm test src/workspace/migrateSessions.test.ts`
Expected: 文件不存在错误

- [ ] **Step 7：实现 migrateSessions.ts**

新建 `src/workspace/migrateSessions.ts`：

```ts
import fs from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import type { WorkspacePaths } from './paths.ts'
import type { Logger } from '@/logger/logger.ts'

export async function migrateLegacySessions(
  paths: WorkspacePaths,
  logger: Logger,
): Promise<void> {
  const slackDir = path.join(paths.sessionsDir, 'slack')
  if (!existsSync(slackDir)) return
  const entries = await fs.readdir(slackDir, { withFileTypes: true })
  for (const e of entries) {
    if (!e.isDirectory()) continue
    const threadDir = path.join(slackDir, e.name)
    const inThread = await fs.readdir(threadDir, { withFileTypes: true })
    const hasFiles = inThread.some((x) => x.isFile())
    if (!hasFiles) continue // 已是新结构（仅含 agentId 子目录）

    const target = path.join(threadDir, 'default')
    await fs.mkdir(target, { recursive: true })
    for (const x of inThread) {
      if (x.isFile()) {
        await fs.rename(path.join(threadDir, x.name), path.join(target, x.name))
      }
    }
    logger.info(`已迁移 session：${e.name} → default/`)
  }
}
```

- [ ] **Step 8：跑测试看通过**

Run: `pnpm test src/workspace/migrateSessions.test.ts`
Expected: 3 PASS

- [ ] **Step 9：在 WorkspaceContext 中调用 sessions 迁移**

修改 [`src/workspace/WorkspaceContext.ts`](../../../src/workspace/WorkspaceContext.ts)，在 Task 1.4 的 config 迁移之后、`loadSkills` 之前加：

```ts
import { migrateLegacySessions } from './migrateSessions.ts'

await migrateLegacySessions(paths, logger)
```

- [ ] **Step 10：把 worktrees/ 加入 .gitignore**

worktree 目录是临时工作产物，**绝不能进 git**，否则 `git worktree add` 会和已存在的 tracked 文件冲突。

修改项目根 `.gitignore`，确认包含：

```
.agent-slack/worktrees/
.agent-slack/tasks/
```

如果 `.agent-slack/` 已整体被 ignore，可省略；用 `git check-ignore -v .agent-slack/worktrees/` 验证。

- [ ] **Step 11：跑全套测试**

Run: `pnpm test`
Expected: paths + sessions 迁移测试全绿；下游 `ctx.config.agent` 引用仍可能失败 —— 在 Task 1.6 修。

- [ ] **Step 12：commit**

```bash
git add src/workspace/paths.ts src/workspace/paths.test.ts src/workspace/migrateSessions.ts src/workspace/migrateSessions.test.ts src/workspace/WorkspaceContext.ts .gitignore
git commit -m "feat(workspace): paths 加 agentId 维度 + tasks/ + worktrees/，老 sessions 自动迁移到 default/ 子目录"
```

### Task 1.6：修复下游引用 `ctx.config.agent` 的所有点

**Files（已 grep 全 src/ 命中）**：

| 文件 | 行 | 当前代码 | 改成 |
|---|---|---|---|
| `src/application/createApplication.ts` | 67 | `selectProvider(ctx.config.agent.provider)` | `selectProvider(ctx.config.agents[0].provider)` |
| `src/application/createApplication.ts` | 88 | `const modelName = ctx.config.agent.model` | `const modelName = ctx.config.agents[0].model` |
| `src/application/createApplication.ts` | 125 | `maxSteps: ctx.config.agent.maxSteps` | `maxSteps: ctx.config.agents[0].maxSteps` |
| `src/application/createApplication.ts` | 138 | `modelMessageBudget: ctx.config.agent.context` | `modelMessageBudget: ctx.config.agents[0].context` |
| `src/cli/commands/status.ts` | 23 | `${ctx.config.agent.name} / ${ctx.config.agent.model}` | `${ctx.config.agents[0].name} / ${ctx.config.agents[0].model}` |
| `src/cli/commands/doctor.ts` | 75 | `const modelName = ctx.config.agent.model` | `const modelName = ctx.config.agents[0].model` |
| `src/dashboard/api.ts` | 460 | `modelAvailable: ids.includes(config.agent.model)` | `modelAvailable: ids.includes(config.agents[0].model)` |
| `src/dashboard/ui.ts` | 161-162 | `o.config.agent.name + '/' + o.config.agent.model`、`o.config.agent.provider` | `o.config.agents[0].name + '/' + o.config.agents[0].model`、`o.config.agents[0].provider` |

**注意**：dashboard 后端 [`src/dashboard/api.ts`](../../../src/dashboard/api.ts) 给前端的 `overview.config` 应是整份 `WorkspaceConfig`（含 `agents`），前端 [`src/dashboard/ui.ts`](../../../src/dashboard/ui.ts) 也按 `agents[0]` 取值；如果 api 当前只透传 `config.agent`，需要改成透传 `config.agents`。

**e2e 文件不改**：以下文件直接操作 raw YAML 对象（不是 typed config），保持不动：

- `src/e2e/live/run-max-steps.ts` `config.agent = { ...agent, maxSteps: 1 }`
- `src/e2e/live/run-auto-compact.ts`
- `src/e2e/live/run-context-pruning-no-llm.ts`
- `src/e2e/live/run-compact-boundary.ts`

它们写出的 yaml 仍是旧 `agent.*` 格式，agent-slack 启动时 `migrateLegacyAgentField` 会自动把它转成 `agents[]`，运行时行为不变。**这是验证自动迁移在真实 e2e 链路下生效的核心证据**，不要破坏。

- [ ] **Step 1：执行 grep 二次确认无遗漏**

Run: `grep -rn "config\.agent\b\|ctx\.config\.agent\b\|\.config\.agent\." src/ --include="*.ts" | grep -v "\.test\." | grep -v "src/e2e/"`
Expected: 输出和上表一致；如有遗漏点补到上表后再继续。

- [ ] **Step 2：逐点修改**

按上表逐行改。dashboard ui 那两行（161-162）要确保前端取到的 `o.config` 真的有 `agents` 字段（去 `src/dashboard/api.ts` 的 `overview()` 里看 `config:` 那一段，必要时改成 `config: { ...ctx.config }` 或仅暴露 `agents: ctx.config.agents`）。

- [ ] **Step 3：跑全套测试 + typecheck**

Run: `pnpm test && pnpm typecheck`
Expected: 全绿。如有 .test 文件里也用了 `config.agent.*`，一并修。

- [ ] **Step 4：commit**

```bash
git add -u
git commit -m "refactor(application/cli/dashboard): 下游消费方改为 ctx.config.agents[0]，单 Agent 行为等同今天"
```

### ✅ Chunk 1 验证

完成后请用户做以下 review：

1. **测试与类型全绿**：`pnpm test && pnpm typecheck`（package.json 已有 `typecheck` script）
2. **老 config 自动迁移**：
   - 在一个测试 workspace 写一份旧 `agent: { name: foo, model: gpt-5.4, maxSteps: 30, provider: anthropic }` 的 config.yaml
   - 运行 `agent-slack status`（任何会触发 `loadWorkspaceContext` 的命令都行）
   - 验证：
     - `config.yaml` 已被改写成 `agents: [...]`，且 `name/model/maxSteps/provider` 全部保留
     - 同目录有 `config.yaml.bak.<timestamp>`
     - status 输出显示的 agent name / model / provider 与原值一致
3. **老 sessions 自动迁移**：
   - 在测试 workspace 创建 `.agent-slack/sessions/slack/general.C001.1.2/messages.jsonl`（不带 agentId 子目录）
   - 跑 `agent-slack status`
   - 验证：
     - 文件移到 `.agent-slack/sessions/slack/general.C001.1.2/default/messages.jsonl`
     - 老路径无遗留文件
4. **e2e 文件不改也能跑**：抽查一个 `src/e2e/live/run-max-steps.ts`，确认其 `config.agent = {...}` 写法在当前迁移逻辑下仍能工作（不必跑真 LLM，只跑 dry-run 即可）

只有上面四项都通过，才进 Chunk 2。

---
