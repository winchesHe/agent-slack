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

// 启发式：thread 目录下若存在任何顶层文件，则视为旧结构（messages.jsonl + 可能的边角文件），
// 全部迁移到 default/ 子目录。极小概率会误移用户人为放在 thread 目录的无关文件
// （如 README.md），属可接受边界情况；新结构里 thread 目录只应含 agentId 子目录。
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

**dashboard api 透传形态确认**：[`src/dashboard/api.ts:299`](../../../src/dashboard/api.ts) 的 `overview()` 直接返回 `config` 对象（即整份 `WorkspaceConfig`）。Chunk 1 改完 schema 后 `config.agents` 自然出现，前端 ui.ts 改用 `agents[0].name/model/provider` 即可。**api.ts 端无需结构改动**。

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

## Chunk 2：RolePromptLoader + TaskBoard + WorktreeManager

**目标**：把 P0 三个独立小模块（无相互依赖）一次性补齐。每个模块都是文件 IO 工具类，纯函数风格，易测易嵌入；为 Chunk 3 的 A2ABus 与 Chunk 4 的 orchestrator 提供原子能力。

**前置依赖**：Chunk 1 全绿（特别是 paths.ts 已暴露 `taskDir`/`taskBoardFile`/`worktreeDir`）。

**新增依赖**：`proper-lockfile`（跨平台 advisory file lock，用于 task.json 写入）。spec §5.3 列出该选型；该库零原生依赖，纯 JS。

### Task 2.1：装上 proper-lockfile 依赖

**Files:**
- Modify: `package.json`

- [ ] **Step 1：装包**

Run: `pnpm add proper-lockfile`
Expected: `package.json` `dependencies` 多一行 `"proper-lockfile": "^4.x"`，`pnpm-lock.yaml` 更新。

- [ ] **Step 2：装 typing**

Run: `pnpm add -D @types/proper-lockfile`

- [ ] **Step 3：commit**

```bash
git add package.json pnpm-lock.yaml
git commit -m "chore(deps): 引入 proper-lockfile 跨平台文件锁"
```

### Task 2.2：RolePromptLoader

**Files:**
- Create: `src/multiAgent/RolePromptLoader.ts`
- Create: `src/multiAgent/RolePromptLoader.test.ts`

- [ ] **Step 1：写失败测试**

```ts
import { describe, it, expect } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { loadSystemPrompt } from './RolePromptLoader.ts'
import type { Logger } from '@/logger/logger.ts'

const stubLogger: Logger = {
  withTag: () => stubLogger,
  trace: () => {}, debug: () => {}, info: () => {}, warn: () => {}, error: () => {},
}

async function makeWs(files: Record<string, string>): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-slack-prompt-'))
  await fs.mkdir(path.join(dir, '.agent-slack'), { recursive: true })
  for (const [name, content] of Object.entries(files)) {
    await fs.writeFile(path.join(dir, '.agent-slack', name), content)
  }
  return dir
}

describe('loadSystemPrompt', () => {
  it('returns system.md as-is for role=generic', async () => {
    const dir = await makeWs({ 'system.md': 'BASE PROMPT' })
    expect(await loadSystemPrompt(dir, 'generic', stubLogger)).toBe('BASE PROMPT')
  })

  it('joins base + role overlay with --- separator for role=pm', async () => {
    const dir = await makeWs({
      'system.md': 'BASE',
      'system.pm.md': 'PM OVERLAY',
    })
    const result = await loadSystemPrompt(dir, 'pm', stubLogger)
    expect(result).toBe('BASE\n\n---\n\nPM OVERLAY')
  })

  it('returns base alone when role overlay missing (with warn)', async () => {
    const dir = await makeWs({ 'system.md': 'BASE' })
    let warned = false
    // 注意：实现内部会调 logger.withTag(...).warn(...)，所以 withTag 必须返回包含
    // 同一 warned 闭包的对象。用一个递归 self-ref 的对象保证 mutate warn 后所有
    // withTag 衍生 logger 都能命中。
    const watched: Logger = {
      withTag: () => watched,
      trace: () => {},
      debug: () => {},
      info: () => {},
      warn: () => {
        warned = true
      },
      error: () => {},
    }
    const result = await loadSystemPrompt(dir, 'coding', watched)
    expect(result).toBe('BASE')
    expect(warned).toBe(true)
  })

  it('returns role overlay alone when system.md missing', async () => {
    const dir = await makeWs({ 'system.cs.md': 'CS OVERLAY' })
    expect(await loadSystemPrompt(dir, 'cs', stubLogger)).toBe('CS OVERLAY')
  })

  it('returns empty string when both missing for role=generic', async () => {
    const dir = await makeWs({})
    expect(await loadSystemPrompt(dir, 'generic', stubLogger)).toBe('')
  })
})
```

- [ ] **Step 2：跑测试看失败**

Run: `pnpm test src/multiAgent/RolePromptLoader.test.ts`
Expected: 文件不存在错误

- [ ] **Step 3：实现 RolePromptLoader.ts**

```ts
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import type { AgentRole } from './types.ts'
import type { Logger } from '@/logger/logger.ts'

export async function loadSystemPrompt(
  workspaceRoot: string,
  role: AgentRole,
  logger: Logger,
): Promise<string> {
  const root = path.join(workspaceRoot, '.agent-slack')
  const baseFile = path.join(root, 'system.md')
  const base = existsSync(baseFile) ? await readFile(baseFile, 'utf8') : ''

  if (role === 'generic') {
    return base
  }

  const overlayFile = path.join(root, `system.${role}.md`)
  if (!existsSync(overlayFile)) {
    logger.withTag('role-prompt').warn(
      `system.${role}.md 缺失，仅使用 system.md 作为 ${role} 的 system prompt`,
    )
    return base
  }
  const overlay = await readFile(overlayFile, 'utf8')
  if (!base) return overlay
  return `${base}\n\n---\n\n${overlay}`
}
```

- [ ] **Step 4：跑测试通过**

Run: `pnpm test src/multiAgent/RolePromptLoader.test.ts`
Expected: 5 PASS

- [ ] **Step 5：commit**

```bash
git add src/multiAgent/RolePromptLoader.ts src/multiAgent/RolePromptLoader.test.ts
git commit -m "feat(multiAgent): RolePromptLoader 拼装 base + role overlay"
```

### Task 2.3：TaskBoard

**Files:**
- Create: `src/multiAgent/TaskBoard.ts`
- Create: `src/multiAgent/TaskBoard.test.ts`

模块责任（spec §5.3）：
- 读 / 写 / 创建 `tasks/<id>/task.json`
- 用 proper-lockfile 守护写
- `update_task_board` 工具调用时追加 facts/decisions/openQuestions（去重）
- 渲染成 markdown 注入 system prompt

接口：

```ts
interface TaskBoardManager {
  create(init: Omit<TaskBoard, 'createdAt' | 'updatedAt' | 'scratchpad'> & {
    scratchpad?: Partial<TaskBoard['scratchpad']>
  }): Promise<TaskBoard>
  read(taskId: string): Promise<TaskBoard | null>
  update(taskId: string, patch: TaskBoardPatch): Promise<TaskBoard>
  appendScratchpad(taskId: string, append: ScratchpadAppend): Promise<TaskBoard>
  renderForPrompt(board: TaskBoard): string
}

interface TaskBoardPatch {
  state?: TaskBoard['state']
  activeAgent?: TaskBoard['activeAgent']
  goal?: string
  worktreePath?: string
}

interface ScratchpadAppend {
  facts?: string[]
  decisions?: string[]
  openQuestions?: string[]
}
```

- [ ] **Step 1：写失败测试**

```ts
import { describe, it, expect } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createTaskBoardManager } from './TaskBoard.ts'
import { resolveWorkspacePaths } from '@/workspace/paths.ts'
import { newTaskId } from './types.ts'

async function makeMgr() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-slack-tb-'))
  const paths = resolveWorkspacePaths(dir)
  const mgr = createTaskBoardManager(paths)
  return { dir, paths, mgr }
}

describe('TaskBoard', () => {
  it('creates task.json with initial state and reads it back', async () => {
    const { mgr } = await makeMgr()
    const taskId = newTaskId()
    const board = await mgr.create({
      taskId,
      threadTs: '1.2',
      channelId: 'C001',
      originalUser: 'U999',
      goal: '',
      state: 'active',
      activeAgent: 'pm',
    })
    expect(board.taskId).toBe(taskId)
    expect(board.scratchpad).toEqual({ facts: [], decisions: [], openQuestions: [] })
    const reread = await mgr.read(taskId)
    expect(reread?.taskId).toBe(taskId)
  })

  it('returns null when task does not exist', async () => {
    const { mgr } = await makeMgr()
    expect(await mgr.read('tsk_nonexistent')).toBeNull()
  })

  it('update patches fields and bumps updatedAt', async () => {
    const { mgr } = await makeMgr()
    const taskId = newTaskId()
    const created = await mgr.create({
      taskId, threadTs: '1.2', channelId: 'C001', originalUser: 'U', goal: '',
      state: 'active', activeAgent: 'pm',
    })
    await new Promise((r) => setTimeout(r, 5)) // 让 updatedAt 不同
    const updated = await mgr.update(taskId, { state: 'awaiting_user', goal: '修 bug' })
    expect(updated.state).toBe('awaiting_user')
    expect(updated.goal).toBe('修 bug')
    expect(updated.updatedAt).not.toBe(created.updatedAt)
  })

  it('appendScratchpad de-duplicates strings', async () => {
    const { mgr } = await makeMgr()
    const taskId = newTaskId()
    await mgr.create({
      taskId, threadTs: '1.2', channelId: 'C001', originalUser: 'U', goal: '',
      state: 'active', activeAgent: 'pm',
    })
    await mgr.appendScratchpad(taskId, { facts: ['A', 'B'] })
    const after = await mgr.appendScratchpad(taskId, { facts: ['B', 'C'], decisions: ['D'] })
    expect(after.scratchpad.facts).toEqual(['A', 'B', 'C'])
    expect(after.scratchpad.decisions).toEqual(['D'])
  })

  it('renderForPrompt produces a markdown section', async () => {
    const { mgr } = await makeMgr()
    const taskId = newTaskId()
    const board = await mgr.create({
      taskId, threadTs: '1.2', channelId: 'C001', originalUser: 'U',
      goal: '修 bug', state: 'active', activeAgent: 'pm',
    })
    const rendered = mgr.renderForPrompt({
      ...board,
      scratchpad: {
        facts: ['fact 1', 'fact 2'],
        decisions: ['decision 1'],
        openQuestions: [],
      },
    })
    expect(rendered).toContain('## Task Board')
    expect(rendered).toContain('Goal: 修 bug')
    expect(rendered).toContain('Known Facts')
    expect(rendered).toContain('- fact 1')
    expect(rendered).toContain('Decisions Made')
    expect(rendered).not.toContain('Open Questions') // 空段省略
  })

  it('renderForPrompt shows "(待 PM 设定)" when goal empty', async () => {
    const { mgr } = await makeMgr()
    const taskId = newTaskId()
    const board = await mgr.create({
      taskId, threadTs: '1.2', channelId: 'C001', originalUser: 'U',
      goal: '', state: 'active', activeAgent: null,
    })
    expect(mgr.renderForPrompt(board)).toContain('Goal: (待 PM 设定)')
  })
})
```

- [ ] **Step 2：跑测试看失败**

Run: `pnpm test src/multiAgent/TaskBoard.test.ts`

- [ ] **Step 3：实现 TaskBoard.ts**

```ts
import fs from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import lockfile from 'proper-lockfile'
import { TaskBoardSchema, type TaskBoard } from './types.ts'
import { taskDir, taskBoardFile, type WorkspacePaths } from '@/workspace/paths.ts'

export interface TaskBoardPatch {
  state?: TaskBoard['state']
  activeAgent?: TaskBoard['activeAgent']
  goal?: string
  worktreePath?: string
}

export interface ScratchpadAppend {
  facts?: string[]
  decisions?: string[]
  openQuestions?: string[]
}

export interface TaskBoardManager {
  create(init: CreateInit): Promise<TaskBoard>
  read(taskId: string): Promise<TaskBoard | null>
  update(taskId: string, patch: TaskBoardPatch): Promise<TaskBoard>
  appendScratchpad(taskId: string, append: ScratchpadAppend): Promise<TaskBoard>
  renderForPrompt(board: TaskBoard): string
}

type CreateInit = Omit<TaskBoard, 'createdAt' | 'updatedAt' | 'scratchpad'> & {
  scratchpad?: Partial<TaskBoard['scratchpad']>
}

export function createTaskBoardManager(paths: WorkspacePaths): TaskBoardManager {
  return {
    // 不加锁：v1 单写者保证（仅 MentionCommandRouter 在判定新 task 时调用一次）。
    // proper-lockfile.lock 也要求文件存在；create 是首次落盘，无文件可锁。
    async create(init) {
      const dir = taskDir(paths, init.taskId)
      await fs.mkdir(dir, { recursive: true })
      await fs.mkdir(path.join(dir, 'envelopes'), { recursive: true })
      const now = new Date().toISOString()
      const board: TaskBoard = TaskBoardSchema.parse({
        ...init,
        scratchpad: {
          facts: init.scratchpad?.facts ?? [],
          decisions: init.scratchpad?.decisions ?? [],
          openQuestions: init.scratchpad?.openQuestions ?? [],
        },
        createdAt: now,
        updatedAt: now,
      })
      await writeJson(taskBoardFile(paths, init.taskId), board)
      return board
    },

    async read(taskId) {
      const file = taskBoardFile(paths, taskId)
      if (!existsSync(file)) return null
      const raw = await fs.readFile(file, 'utf8')
      return TaskBoardSchema.parse(JSON.parse(raw))
    },

    async update(taskId, patch) {
      return mutate(paths, taskId, (board) => ({
        ...board,
        ...(patch.state !== undefined ? { state: patch.state } : {}),
        ...(patch.activeAgent !== undefined ? { activeAgent: patch.activeAgent } : {}),
        ...(patch.goal !== undefined ? { goal: patch.goal } : {}),
        ...(patch.worktreePath !== undefined ? { worktreePath: patch.worktreePath } : {}),
        updatedAt: new Date().toISOString(),
      }))
    },

    async appendScratchpad(taskId, append) {
      return mutate(paths, taskId, (board) => ({
        ...board,
        scratchpad: {
          facts: dedupAppend(board.scratchpad.facts, append.facts),
          decisions: dedupAppend(board.scratchpad.decisions, append.decisions),
          openQuestions: dedupAppend(board.scratchpad.openQuestions, append.openQuestions),
        },
        updatedAt: new Date().toISOString(),
      }))
    },

    renderForPrompt(board) {
      const lines: string[] = []
      lines.push(`## Task Board (task_id=${board.taskId}, state=${board.state})`)
      lines.push(`Goal: ${board.goal || '(待 PM 设定)'}`)
      const sp = board.scratchpad
      if (sp.facts.length > 0) {
        lines.push('', 'Known Facts:')
        for (const f of sp.facts) lines.push(`- ${f}`)
      }
      if (sp.decisions.length > 0) {
        lines.push('', 'Decisions Made:')
        for (const d of sp.decisions) lines.push(`- ${d}`)
      }
      if (sp.openQuestions.length > 0) {
        lines.push('', 'Open Questions:')
        for (const q of sp.openQuestions) lines.push(`- ${q}`)
      }
      return lines.join('\n')
    },
  }
}

function dedupAppend(base: string[], add?: string[]): string[] {
  if (!add || add.length === 0) return base
  const seen = new Set(base)
  const out = [...base]
  for (const x of add) {
    if (!seen.has(x)) {
      seen.add(x)
      out.push(x)
    }
  }
  return out
}

async function mutate(
  paths: WorkspacePaths,
  taskId: string,
  fn: (board: TaskBoard) => TaskBoard,
): Promise<TaskBoard> {
  const file = taskBoardFile(paths, taskId)
  if (!existsSync(file)) {
    throw new Error(`task ${taskId} 不存在`)
  }
  const release = await lockfile.lock(file, { retries: { retries: 5, minTimeout: 100 } })
  try {
    const raw = await fs.readFile(file, 'utf8')
    const board = TaskBoardSchema.parse(JSON.parse(raw))
    const next = TaskBoardSchema.parse(fn(board))
    await writeJson(file, next)
    return next
  } finally {
    await release()
  }
}

async function writeJson(file: string, obj: unknown): Promise<void> {
  await fs.writeFile(file, JSON.stringify(obj, null, 2))
}
```

- [ ] **Step 4：跑测试通过**

Run: `pnpm test src/multiAgent/TaskBoard.test.ts`
Expected: 6 PASS

- [ ] **Step 5：commit**

```bash
git add src/multiAgent/TaskBoard.ts src/multiAgent/TaskBoard.test.ts
git commit -m "feat(multiAgent): TaskBoard 文件态读写 + 文件锁 + scratchpad 去重 + prompt 渲染"
```

### Task 2.4：WorktreeManager

**Files:**
- Create: `src/multiAgent/WorktreeManager.ts`
- Create: `src/multiAgent/WorktreeManager.test.ts`

模块责任（spec §6.5）：
- 在 `<workspaceRoot>/.agent-slack/worktrees/<task_id>/` 下创建 git worktree
- branch 命名 `agent-slack/task/<task_id>`，从当前 HEAD 切出
- task done/aborted 时调 `markCleanable`，记录可清理时间戳
- `cleanupExpired` 删除 7 天前标记过的 worktree

接口：

```ts
interface WorktreeManager {
  ensureForTask(taskId: string): Promise<{ path: string; branch: string }>
  markCleanable(taskId: string): Promise<void>
  cleanupExpired(): Promise<{ removed: string[] }>
}
```

清理元数据放在 `.agent-slack/worktrees/.cleanable.json`（map: taskId → cleanableAt ISO）。

- [ ] **Step 1：写失败测试**

```ts
import { describe, it, expect, beforeAll } from 'vitest'
import fs from 'node:fs/promises'
import { existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { createWorktreeManager } from './WorktreeManager.ts'
import { resolveWorkspacePaths } from '@/workspace/paths.ts'

async function makeRepoWithWorkspace(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-slack-wt-'))
  // 初始化为最简单的 git repo
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir })
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir })
  execFileSync('git', ['config', 'user.name', 'test'], { cwd: dir })
  await fs.writeFile(path.join(dir, 'README.md'), 'hi')
  execFileSync('git', ['add', '.'], { cwd: dir })
  execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: dir })
  await fs.mkdir(path.join(dir, '.agent-slack'), { recursive: true })
  return dir
}

describe('WorktreeManager', () => {
  it('ensureForTask creates a real git worktree at expected path', async () => {
    const repo = await makeRepoWithWorkspace()
    const paths = resolveWorkspacePaths(repo)
    const mgr = createWorktreeManager(paths, repo)
    const taskId = 'tsk_aaa'
    const r = await mgr.ensureForTask(taskId)
    expect(r.path).toBe(path.join(paths.root, 'worktrees', taskId))
    expect(r.branch).toBe(`agent-slack/task/${taskId}`)
    expect(existsSync(path.join(r.path, 'README.md'))).toBe(true)
  })

  it('ensureForTask is idempotent (same call returns same worktree)', async () => {
    const repo = await makeRepoWithWorkspace()
    const paths = resolveWorkspacePaths(repo)
    const mgr = createWorktreeManager(paths, repo)
    const a = await mgr.ensureForTask('tsk_b')
    const b = await mgr.ensureForTask('tsk_b')
    expect(a).toEqual(b)
  })

  it('markCleanable writes a fresh ISO timestamp to .cleanable.json', async () => {
    const repo = await makeRepoWithWorkspace()
    const paths = resolveWorkspacePaths(repo)
    const mgr = createWorktreeManager(paths, repo)
    const taskId = 'tsk_mc'
    await mgr.ensureForTask(taskId)
    const before = Date.now()
    await mgr.markCleanable(taskId)
    const after = Date.now()
    const meta = JSON.parse(
      await fs.readFile(path.join(paths.root, 'worktrees', '.cleanable.json'), 'utf8'),
    ) as Record<string, string>
    expect(meta[taskId]).toBeTruthy()
    const ts = new Date(meta[taskId]).getTime()
    expect(ts).toBeGreaterThanOrEqual(before)
    expect(ts).toBeLessThanOrEqual(after)
  })

  it('cleanupExpired removes worktrees marked > 7 days ago (via direct meta write)', async () => {
    const repo = await makeRepoWithWorkspace()
    const paths = resolveWorkspacePaths(repo)
    const mgr = createWorktreeManager(paths, repo)
    const taskId = 'tsk_c'
    await mgr.ensureForTask(taskId)
    // 手动写一个 8 天前的 cleanable 记录
    const meta = path.join(paths.root, 'worktrees', '.cleanable.json')
    const eightDaysAgo = new Date(Date.now() - 8 * 86400_000).toISOString()
    await fs.writeFile(meta, JSON.stringify({ [taskId]: eightDaysAgo }))
    const result = await mgr.cleanupExpired()
    expect(result.removed).toEqual([taskId])
    expect(existsSync(path.join(paths.root, 'worktrees', taskId))).toBe(false)
  })

  it('cleanupExpired keeps worktrees younger than 7 days', async () => {
    const repo = await makeRepoWithWorkspace()
    const paths = resolveWorkspacePaths(repo)
    const mgr = createWorktreeManager(paths, repo)
    const taskId = 'tsk_d'
    await mgr.ensureForTask(taskId)
    await mgr.markCleanable(taskId)
    const result = await mgr.cleanupExpired()
    expect(result.removed).toEqual([])
    expect(existsSync(path.join(paths.root, 'worktrees', taskId))).toBe(true)
  })
})
```

- [ ] **Step 2：跑测试看失败**

Run: `pnpm test src/multiAgent/WorktreeManager.test.ts`

- [ ] **Step 3：实现 WorktreeManager.ts**

```ts
import fs from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { worktreeDir, type WorkspacePaths } from '@/workspace/paths.ts'

const exec = promisify(execFile)
const RETENTION_DAYS = 7

export interface WorktreeManager {
  ensureForTask(taskId: string): Promise<{ path: string; branch: string }>
  markCleanable(taskId: string): Promise<void>
  cleanupExpired(): Promise<{ removed: string[] }>
}

export function createWorktreeManager(
  paths: WorkspacePaths,
  repoCwd: string,
): WorktreeManager {
  return {
    // 假设：branch 与 worktree 同生命周期。外部手动 `rm -rf` worktree 但保留分支
    // 的边界场景不做兜底（git worktree add -b 会因为分支已存在而失败，需要人工清理）。
    async ensureForTask(taskId) {
      const wtPath = worktreeDir(paths, taskId)
      const branch = `agent-slack/task/${taskId}`
      if (existsSync(wtPath)) {
        return { path: wtPath, branch }
      }
      await fs.mkdir(path.dirname(wtPath), { recursive: true })
      // -b：从当前 HEAD 切新分支
      await exec('git', ['worktree', 'add', '-b', branch, wtPath, 'HEAD'], {
        cwd: repoCwd,
      })
      return { path: wtPath, branch }
    },

    async markCleanable(taskId) {
      const meta = await readMeta(paths)
      meta[taskId] = new Date().toISOString()
      await writeMeta(paths, meta)
    },

    async cleanupExpired() {
      const meta = await readMeta(paths)
      const cutoff = Date.now() - RETENTION_DAYS * 86400_000
      const removed: string[] = []
      for (const [taskId, ts] of Object.entries(meta)) {
        if (new Date(ts).getTime() <= cutoff) {
          const wtPath = worktreeDir(paths, taskId)
          if (existsSync(wtPath)) {
            try {
              await exec('git', ['worktree', 'remove', '--force', wtPath], {
                cwd: repoCwd,
              })
            } catch {
              // 退化到 rm -rf；git worktree prune 会清理 metadata
              await fs.rm(wtPath, { recursive: true, force: true })
              await exec('git', ['worktree', 'prune'], { cwd: repoCwd }).catch(() => {})
            }
          }
          delete meta[taskId]
          removed.push(taskId)
        }
      }
      await writeMeta(paths, meta)
      return { removed }
    },
  }
}

async function readMeta(paths: WorkspacePaths): Promise<Record<string, string>> {
  const file = path.join(paths.root, 'worktrees', '.cleanable.json')
  if (!existsSync(file)) return {}
  try {
    const raw = await fs.readFile(file, 'utf8')
    const obj = JSON.parse(raw) as unknown
    if (obj && typeof obj === 'object') return obj as Record<string, string>
    return {}
  } catch {
    return {}
  }
}

async function writeMeta(
  paths: WorkspacePaths,
  meta: Record<string, string>,
): Promise<void> {
  const dir = path.join(paths.root, 'worktrees')
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(path.join(dir, '.cleanable.json'), JSON.stringify(meta, null, 2))
}
```

- [ ] **Step 4：跑测试通过**

Run: `pnpm test src/multiAgent/WorktreeManager.test.ts`
Expected: 5 PASS（这些测试会真的跑 git，需要本机有 git；CI 已默认有）

- [ ] **Step 5：commit**

```bash
git add src/multiAgent/WorktreeManager.ts src/multiAgent/WorktreeManager.test.ts
git commit -m "feat(multiAgent): WorktreeManager per-task git worktree 创建/标记/过期清理"
```

### ✅ Chunk 2 验证

完成后请用户做以下 review：

1. **测试与类型全绿**：`pnpm test && pnpm typecheck`
2. **新模块独立可用**（手动跑一下）：
   ```bash
   # 在 repl 里验证 RolePromptLoader：
   cat > /tmp/test-rpl.ts <<'EOF'
   import { loadSystemPrompt } from './src/multiAgent/RolePromptLoader.ts'
   const r = await loadSystemPrompt('/tmp/your-test-ws', 'pm', console as any)
   console.log(r)
   EOF
   ```
3. **TaskBoard 文件落盘形态符合 spec §5.3**：手工 create 一个 task，cat `.agent-slack/tasks/<id>/task.json`，结构对得上。
4. **WorktreeManager 真在 git 里建 worktree**：`git worktree list` 能看到新建的 task worktree。
5. **注意**：Chunk 2 完成后 WorktreeManager / TaskBoard 仍是孤立模块，没人调用 markCleanable / appendScratchpad，自动清理与黑板更新要等 Chunk 3-4 接入 tools 与 orchestrator 才生效。

只有上面四项都通过，才进 Chunk 3。

---

## Chunk 3：A2ABus + 三个 multi-agent tool

**目标**：把 A2A 总线（内存事件路由 + envelope 文件落盘）+ 三个新 tool（`delegate_to` / `escalate_to_user` / `update_task_board`）做完。Chunk 完成后这些都还是孤立组件，**Chunk 4 才把它们接入 ConversationOrchestrator**。

### Task 3.1：A2ABus

**Files:**
- Create: `src/multiAgent/A2ABus.ts`
- Create: `src/multiAgent/A2ABus.test.ts`

接口：

```ts
interface A2ABus {
  post(envelope: A2AEnvelope): Promise<void>
  subscribe(agentId: AgentId, handler: EnvelopeHandler): Unsubscribe
  // 取已订阅 inbox 内待消费 envelope 数量（dashboard / 测试用）
  inboxSize(agentId: AgentId): number
}

type EnvelopeHandler = (envelope: A2AEnvelope) => Promise<void> | void
type Unsubscribe = () => void
```

行为：
- `post`：先按 spec §5.1 写文件 `tasks/<taskId>/envelopes/<id>.json`；`to !== 'thread'` 时再 dispatch 给对应 agent 的订阅者
- `to === 'thread'` 落盘但**不 dispatch**（出口 envelope 由调用方自行处理 thread 推送，P0 没接 Slack 所以仅落盘）
- 单 agent 多 subscriber：本 v1 一个 agent 同一时刻仅一个 ConversationOrchestrator subscriber，多 subscribe 取最新（覆盖前者，前者收到 unsubscribe 信号）
- subscriber 未注册时收到的 envelope：**先 buffer 在 inbox 队列**，subscribe 时按时间序 flush

- [ ] **Step 1：写失败测试**

```ts
import { describe, it, expect } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { existsSync } from 'node:fs'
import { createA2ABus } from './A2ABus.ts'
import { resolveWorkspacePaths } from '@/workspace/paths.ts'
import { newEnvelopeId, newTaskId, type A2AEnvelope } from './types.ts'

async function makeBus() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-slack-bus-'))
  const paths = resolveWorkspacePaths(dir)
  const taskId = newTaskId()
  await fs.mkdir(path.join(paths.root, 'tasks', taskId, 'envelopes'), { recursive: true })
  const bus = createA2ABus(paths)
  return { dir, paths, bus, taskId }
}

function envelope(taskId: string, partial: Partial<A2AEnvelope> = {}): A2AEnvelope {
  return {
    id: newEnvelopeId(),
    taskId,
    from: 'pm',
    to: 'coding',
    intent: 'delegate',
    content: 'do thing',
    createdAt: new Date().toISOString(),
    ...partial,
  }
}

describe('A2ABus', () => {
  it('post writes envelope file to tasks/<taskId>/envelopes/<id>.json', async () => {
    const { paths, bus, taskId } = await makeBus()
    const env = envelope(taskId)
    await bus.post(env)
    const file = path.join(paths.root, 'tasks', taskId, 'envelopes', `${env.id}.json`)
    expect(existsSync(file)).toBe(true)
    const raw = JSON.parse(await fs.readFile(file, 'utf8'))
    expect(raw.id).toBe(env.id)
    expect(raw.content).toBe('do thing')
  })

  it('post dispatches to subscribed agent immediately', async () => {
    const { bus, taskId } = await makeBus()
    const received: A2AEnvelope[] = []
    bus.subscribe('coding', (e) => { received.push(e) })
    await bus.post(envelope(taskId))
    expect(received).toHaveLength(1)
    expect(received[0].content).toBe('do thing')
  })

  it('post buffers in inbox when no subscriber, flushes on later subscribe', async () => {
    const { bus, taskId } = await makeBus()
    await bus.post(envelope(taskId, { content: 'a' }))
    await bus.post(envelope(taskId, { content: 'b' }))
    expect(bus.inboxSize('coding')).toBe(2)
    const received: A2AEnvelope[] = []
    bus.subscribe('coding', (e) => { received.push(e) })
    // 异步 flush，等一帧
    await new Promise((r) => setTimeout(r, 10))
    expect(received.map((e) => e.content)).toEqual(['a', 'b'])
    expect(bus.inboxSize('coding')).toBe(0)
  })

  it('post with to=thread writes file but does not dispatch', async () => {
    const { paths, bus, taskId } = await makeBus()
    const received: A2AEnvelope[] = []
    bus.subscribe('coding', (e) => { received.push(e) })
    const env = envelope(taskId, { to: 'thread', intent: 'final', content: 'done' })
    await bus.post(env)
    const file = path.join(paths.root, 'tasks', taskId, 'envelopes', `${env.id}.json`)
    expect(existsSync(file)).toBe(true)
    expect(received).toHaveLength(0)
  })

  it('latter subscribe replaces former (former unsubscribed)', async () => {
    const { bus, taskId } = await makeBus()
    const aSeen: string[] = []
    const bSeen: string[] = []
    bus.subscribe('coding', (e) => { aSeen.push(e.content) })
    bus.subscribe('coding', (e) => { bSeen.push(e.content) })
    await bus.post(envelope(taskId, { content: 'after-replace' }))
    expect(aSeen).toEqual([])
    expect(bSeen).toEqual(['after-replace'])
  })

  it('unsubscribe stops dispatch', async () => {
    const { bus, taskId } = await makeBus()
    const received: A2AEnvelope[] = []
    const unsub = bus.subscribe('coding', (e) => { received.push(e) })
    unsub()
    await bus.post(envelope(taskId))
    expect(received).toHaveLength(0)
  })
})
```

- [ ] **Step 2：跑测试看失败**

Run: `pnpm test src/multiAgent/A2ABus.test.ts`

- [ ] **Step 3：实现 A2ABus.ts**

```ts
import fs from 'node:fs/promises'
import path from 'node:path'
import { type AgentId, type A2AEnvelope } from './types.ts'
import { envelopeFile, type WorkspacePaths } from '@/workspace/paths.ts'

export type EnvelopeHandler = (envelope: A2AEnvelope) => Promise<void> | void
export type Unsubscribe = () => void

export interface A2ABus {
  post(envelope: A2AEnvelope): Promise<void>
  subscribe(agentId: AgentId, handler: EnvelopeHandler): Unsubscribe
  inboxSize(agentId: AgentId): number
}

export function createA2ABus(paths: WorkspacePaths): A2ABus {
  const handlers = new Map<AgentId, EnvelopeHandler>()
  const inboxes = new Map<AgentId, A2AEnvelope[]>()

  async function persist(envelope: A2AEnvelope): Promise<void> {
    const file = envelopeFile(paths, envelope.taskId, envelope.id)
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.writeFile(file, JSON.stringify(envelope, null, 2))
  }

  async function dispatch(agentId: AgentId, envelope: A2AEnvelope): Promise<void> {
    const handler = handlers.get(agentId)
    if (handler) {
      await handler(envelope)
    } else {
      const inbox = inboxes.get(agentId) ?? []
      inbox.push(envelope)
      inboxes.set(agentId, inbox)
    }
  }

  return {
    async post(envelope) {
      await persist(envelope)
      if (envelope.to === 'thread') return
      await dispatch(envelope.to, envelope)
    },

    subscribe(agentId, handler) {
      handlers.set(agentId, handler)
      // flush 已 buffer 的（异步）
      const buffered = inboxes.get(agentId) ?? []
      if (buffered.length > 0) {
        inboxes.set(agentId, [])
        ;(async () => {
          for (const env of buffered) {
            await handler(env)
          }
        })().catch(() => {
          // 单测期望 dispatch 异常被 swallow，让 bus 继续可用；
          // 真生产场景下 ConversationOrchestrator 的 handler 自带 try/catch + logger
        })
      }
      return () => {
        // 仅当当前注册的 handler 还是 self 时才清除
        if (handlers.get(agentId) === handler) {
          handlers.delete(agentId)
        }
      }
    },

    inboxSize(agentId) {
      return inboxes.get(agentId)?.length ?? 0
    },
  }
}
```

- [ ] **Step 4：跑测试通过**

Run: `pnpm test src/multiAgent/A2ABus.test.ts`
Expected: 6 PASS

- [ ] **Step 5：commit**

```bash
git add src/multiAgent/A2ABus.ts src/multiAgent/A2ABus.test.ts
git commit -m "feat(multiAgent): A2ABus 内存路由 + envelope 文件落盘 + inbox buffer"
```

### Task 3.2：扩展 ToolContext，注入 multi-agent 依赖

**Files:**
- Modify: `src/agent/tools/bash.ts`（`ToolContext` 类型定义在这里）

为后续三个 tool 提供运行期上下文。沿用现有 ToolContext 风格——追加可选字段，单 agent 模式下为 undefined。

- [ ] **Step 1：扩展 ToolContext**

修改 [`src/agent/tools/bash.ts:6-19`](../../../src/agent/tools/bash.ts) 的 `ToolContext`：

```ts
import type { AgentId } from '@/multiAgent/types.ts'
import type { A2ABus } from '@/multiAgent/A2ABus.ts'
import type { TaskBoardManager } from '@/multiAgent/TaskBoard.ts'

export interface ToolContext {
  cwd: string
  logger: {
    debug(m: string, meta?: unknown): void
    info(m: string, meta?: unknown): void
    warn(m: string, meta?: unknown): void
    error(m: string, meta?: unknown): void
    withTag(t: string): ToolContext['logger']
  }
  currentUser?: { userName: string; userId: string }
  confirm?: ConfirmSender
  // 以下三项仅 multi-agent 模式注入；single 模式下整体 undefined
  multiAgent?: {
    agentId: AgentId
    taskId: string
    bus: A2ABus
    taskBoard: TaskBoardManager
  }
}
```

- [ ] **Step 2：跑全套测试 + typecheck**

Run: `pnpm test && pnpm typecheck`
Expected: 全绿（仅扩展 optional 字段，不破坏现有调用）

- [ ] **Step 3：commit**

```bash
git add src/agent/tools/bash.ts
git commit -m "feat(tools): ToolContext 增加 multiAgent 可选上下文（agentId/taskId/bus/taskBoard）"
```

### Task 3.3：delegate_to tool

**Files:**
- Create: `src/agent/tools/delegateTo.ts`
- Test: `src/agent/tools/multiAgentTools.test.ts`（三个 tool 共用一个测试文件）

行为（spec §5.2）：
- 校验 `agent !== self`、`agent ∈ {'pm','coding','cs'}`
- 构造 envelope（intent='delegate'）+ post 到 bus
- 同步返回 `{ envelopeId, status: 'queued' }`
- 单 agent 模式下（`ctx.multiAgent` 不存在）调用 → 抛错"该工具仅在 multi-agent 模式可用"

- [ ] **Step 1：先写所有三个 tool 的失败测试（共用文件）**

创建 `src/agent/tools/multiAgentTools.test.ts`：

```ts
import { describe, it, expect, beforeEach } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { delegateToTool } from './delegateTo.ts'
import { escalateToUserTool } from './escalateToUser.ts'
import { updateTaskBoardTool } from './updateTaskBoard.ts'
import { createA2ABus } from '@/multiAgent/A2ABus.ts'
import { createTaskBoardManager } from '@/multiAgent/TaskBoard.ts'
import { resolveWorkspacePaths } from '@/workspace/paths.ts'
import { newTaskId, type A2AEnvelope } from '@/multiAgent/types.ts'
import type { ToolContext } from './bash.ts'

const stubLogger: ToolContext['logger'] = {
  withTag: () => stubLogger,
  debug: () => {}, info: () => {}, warn: () => {}, error: () => {},
}

async function makeCtx(agentId: 'pm' | 'coding' | 'cs') {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-slack-mat-'))
  const paths = resolveWorkspacePaths(dir)
  const bus = createA2ABus(paths)
  const tb = createTaskBoardManager(paths)
  const taskId = newTaskId()
  const board = await tb.create({
    taskId, threadTs: '1.2', channelId: 'C001', originalUser: 'U999',
    goal: '', state: 'active', activeAgent: 'pm',
  })
  const ctx: ToolContext = {
    cwd: dir,
    logger: stubLogger,
    multiAgent: { agentId, taskId, bus, taskBoard: tb },
  }
  return { dir, paths, bus, tb, ctx, taskId, board }
}

describe('delegate_to tool', () => {
  it('posts a delegate envelope and returns envelopeId+queued', async () => {
    const { ctx, taskId, bus } = await makeCtx('pm')
    const received: A2AEnvelope[] = []
    bus.subscribe('coding', (e) => { received.push(e) })
    const tool = delegateToTool(ctx)
    const r = await tool.execute(
      { agent: 'coding', content: 'fix the bug', references: [] },
      { toolCallId: 't1', messages: [] } as any,
    )
    expect(r).toEqual(expect.objectContaining({ envelopeId: expect.stringMatching(/^env_/), status: 'queued' }))
    expect(received).toHaveLength(1)
    expect(received[0].from).toBe('pm')
    expect(received[0].to).toBe('coding')
    expect(received[0].intent).toBe('delegate')
    expect(received[0].taskId).toBe(taskId)
  })

  it('rejects delegate to self', async () => {
    const { ctx } = await makeCtx('pm')
    const tool = delegateToTool(ctx)
    await expect(
      tool.execute({ agent: 'pm', content: 'x' }, { toolCallId: 't', messages: [] } as any),
    ).rejects.toThrow(/self/)
  })

  it('throws when ctx.multiAgent missing (single-agent mode)', async () => {
    const tool = delegateToTool({ cwd: '/tmp', logger: stubLogger })
    await expect(
      tool.execute({ agent: 'coding', content: 'x' }, { toolCallId: 't', messages: [] } as any),
    ).rejects.toThrow(/multi-agent/)
  })

  it('rejects unknown agent name via schema', async () => {
    const { ctx } = await makeCtx('pm')
    const tool = delegateToTool(ctx)
    await expect(
      // @ts-expect-error 故意传入非枚举值，验证 zod 拒绝
      tool.execute({ agent: 'unknown', content: 'x' }, { toolCallId: 't', messages: [] } as any),
    ).rejects.toThrow()
  })
})

describe('escalate_to_user tool', () => {
  it('writes a thread envelope and sets task state to awaiting_user', async () => {
    const { ctx, tb, taskId, paths } = await makeCtx('pm')
    const tool = escalateToUserTool(ctx)
    const r = await tool.execute(
      { reason: '需要密钥' },
      { toolCallId: 't', messages: [] } as any,
    )
    expect(r).toEqual({ status: 'escalated' })
    const board = await tb.read(taskId)
    expect(board?.state).toBe('awaiting_user')
    // 落盘的 envelope
    const envelopeDir = path.join(paths.root, 'tasks', taskId, 'envelopes')
    const files = await fs.readdir(envelopeDir)
    expect(files).toHaveLength(1)
    const env = JSON.parse(await fs.readFile(path.join(envelopeDir, files[0]!), 'utf8'))
    expect(env.to).toBe('thread')
    expect(env.from).toBe('pm')
    expect(env.content).toContain('需要密钥')
  })

  it('throws when called from non-PM agent', async () => {
    const { ctx } = await makeCtx('coding')
    const tool = escalateToUserTool(ctx)
    await expect(
      tool.execute({ reason: 'x' }, { toolCallId: 't', messages: [] } as any),
    ).rejects.toThrow(/PM/)
  })
})

describe('update_task_board tool', () => {
  it('appends scratchpad facts/decisions/openQuestions', async () => {
    const { ctx, tb, taskId } = await makeCtx('coding')
    const tool = updateTaskBoardTool(ctx)
    await tool.execute(
      { facts: ['fact 1'], decisions: ['decided X'] },
      { toolCallId: 't', messages: [] } as any,
    )
    const board = await tb.read(taskId)
    expect(board?.scratchpad.facts).toEqual(['fact 1'])
    expect(board?.scratchpad.decisions).toEqual(['decided X'])
  })

  it('PM uses it to set goal via goal patch (special path)', async () => {
    const { ctx, tb, taskId } = await makeCtx('pm')
    const tool = updateTaskBoardTool(ctx)
    await tool.execute(
      { goal: '修首页 bug' },
      { toolCallId: 't', messages: [] } as any,
    )
    const board = await tb.read(taskId)
    expect(board?.goal).toBe('修首页 bug')
  })

  it('throws when ctx.multiAgent missing', async () => {
    const tool = updateTaskBoardTool({ cwd: '/tmp', logger: stubLogger })
    await expect(
      tool.execute({ facts: ['x'] }, { toolCallId: 't', messages: [] } as any),
    ).rejects.toThrow(/multi-agent/)
  })

  it('non-PM caller passing goal is silently ignored (facts still written)', async () => {
    const { ctx, tb, taskId } = await makeCtx('coding')
    const tool = updateTaskBoardTool(ctx)
    await tool.execute(
      { goal: '不该被写', facts: ['fact 1'] },
      { toolCallId: 't', messages: [] } as any,
    )
    const board = await tb.read(taskId)
    expect(board?.goal).toBe('') // goal 保持初始空值
    expect(board?.scratchpad.facts).toEqual(['fact 1']) // facts 仍写入
  })
})
```

- [ ] **Step 2：跑测试看失败**

Run: `pnpm test src/agent/tools/multiAgentTools.test.ts`
Expected: 文件不存在错误

- [ ] **Step 3：实现 delegateTo.ts**

```ts
import { tool } from 'ai'
import { z } from 'zod'
import { newEnvelopeId } from '@/multiAgent/types.ts'
import type { ToolContext } from './bash.ts'

// agent 字段使用 enum 而非 AgentIdSchema regex —— 后者会接受任意符合命名规则的字符串
// （包括幻觉出来的 agent 名），导致 envelope 写到一个永远没人订阅的 inbox。
// 当未来 agents 列表动态化（用户自定义角色）时，可改为基于 config.agents[].id
// 动态构造枚举（在 createApplication 装配 tool 时注入）。
const TargetAgentSchema = z.enum(['pm', 'coding', 'cs'])

export function delegateToTool(ctx: ToolContext) {
  return tool({
    description:
      '把任务派发给另一个 Agent。tool 同步返回 queued；本 turn 结束后等对方 reply 再继续。' +
      '禁止把任务派给自己。',
    parameters: z.object({
      agent: TargetAgentSchema,
      content: z.string().min(1),
      references: z
        .array(
          z.object({
            kind: z.enum(['file', 'url', 'session', 'envelope']),
            value: z.string(),
          }),
        )
        .optional(),
    }),
    async execute({ agent, content, references }) {
      if (!ctx.multiAgent) {
        throw new Error('delegate_to 仅在 multi-agent 模式可用')
      }
      const { agentId, taskId, bus } = ctx.multiAgent
      if (agent === agentId) {
        throw new Error(`不能 delegate to self (${agentId})`)
      }
      const envelope = {
        id: newEnvelopeId(),
        taskId,
        from: agentId,
        to: agent,
        intent: 'delegate' as const,
        content,
        ...(references ? { references } : {}),
        createdAt: new Date().toISOString(),
      }
      await bus.post(envelope)
      return { envelopeId: envelope.id, status: 'queued' as const }
    },
  })
}
```

- [ ] **Step 4：跑 delegate_to 那部分测试通过**

Run: `pnpm test src/agent/tools/multiAgentTools.test.ts -t "delegate_to"`
Expected: 4 PASS（其他 2 个 describe 仍失败）

- [ ] **Step 5：commit（先 commit delegate_to，分批节奏）**

```bash
git add src/agent/tools/delegateTo.ts src/agent/tools/multiAgentTools.test.ts
git commit -m "feat(tools): delegate_to 工具，handoff 作为 tool call 派发到 A2A bus"
```

### Task 3.4：escalate_to_user tool

**Files:**
- Create: `src/agent/tools/escalateToUser.ts`

行为（spec §5.2）：
- 仅 PM 可用（运行期校验 `ctx.multiAgent.agentId === 'pm'`，非 PM 抛错；非工具层面强制隔离，依赖 system prompt 自律 + 这道防御性校验）
- 写 envelope `to: 'thread'`，content = `[ESCALATE] ${reason}`，from='pm'
- 把 task state 设为 `awaiting_user`
- P0 不接 Slack，仅落盘 + 改 task.json；P1 接 Slack 时再加真正的 thread post

- [ ] **Step 1：实现 escalateToUser.ts**

```ts
import { tool } from 'ai'
import { z } from 'zod'
import { newEnvelopeId } from '@/multiAgent/types.ts'
import type { ToolContext } from './bash.ts'

export function escalateToUserTool(ctx: ToolContext) {
  return tool({
    description:
      'PM 专用：当遇到必须真用户拍板的事项（凭证 / 权限 / 严重偏离原始目标 / 多方案利弊相当且皆有重大代价）时调用。' +
      '会在 thread 里 @ 原始用户，并把 task 状态置为 awaiting_user。',
    parameters: z.object({
      reason: z.string().min(1),
    }),
    async execute({ reason }) {
      if (!ctx.multiAgent) {
        throw new Error('escalate_to_user 仅在 multi-agent 模式可用')
      }
      const { agentId, taskId, bus, taskBoard } = ctx.multiAgent
      if (agentId !== 'pm') {
        throw new Error(`escalate_to_user 仅 PM 可用（当前 agent=${agentId}）`)
      }
      // intent 取 'broadcast'：spec §5.1 的 intent 枚举里没有专属 'escalate'。
      // 不能用 'final'（spec §5.4 里 final + to:'thread' 表示 task done）。
      // 用 broadcast + content 前缀 [ESCALATE] 区分；Chunk 4 的 orchestrator
      // 不依赖 intent 判定 escalate，而看 task.state === 'awaiting_user'。
      const envelope = {
        id: newEnvelopeId(),
        taskId,
        from: 'pm' as const,
        to: 'thread' as const,
        intent: 'broadcast' as const,
        content: `[ESCALATE] ${reason}`,
        createdAt: new Date().toISOString(),
      }
      await bus.post(envelope)
      await taskBoard.update(taskId, { state: 'awaiting_user' })
      return { status: 'escalated' as const }
    },
  })
}
```

- [ ] **Step 2：跑 escalate_to_user 测试通过**

Run: `pnpm test src/agent/tools/multiAgentTools.test.ts -t "escalate_to_user"`
Expected: 2 PASS

- [ ] **Step 3：commit**

```bash
git add src/agent/tools/escalateToUser.ts
git commit -m "feat(tools): escalate_to_user 工具，PM 专用，触发 awaiting_user 状态"
```

### Task 3.5：update_task_board tool

**Files:**
- Create: `src/agent/tools/updateTaskBoard.ts`

行为（spec §5.3）：
- 三个 agent 都能用
- 接受 `facts? / decisions? / openQuestions?`：调 `taskBoard.appendScratchpad`（去重）
- 接受 `goal?`：仅当当前 agent === 'pm' 时允许覆盖 goal（PM 首 turn 设定）；非 PM 调时静默忽略 goal 字段不报错（避免误用阻塞）

- [ ] **Step 1：实现 updateTaskBoard.ts**

```ts
import { tool } from 'ai'
import { z } from 'zod'
import type { ToolContext } from './bash.ts'

export function updateTaskBoardTool(ctx: ToolContext) {
  return tool({
    description:
      '把当前任务的关键事实 / 决策 / 待解问题写到 task 黑板，下游 Agent 读黑板避免重复查。' +
      'PM 首 turn 可通过 goal 字段写入目标摘要；其他 Agent 传 goal 字段会被忽略。' +
      '所有数组字段是追加去重，不是覆盖。',
    parameters: z.object({
      facts: z.array(z.string()).optional(),
      decisions: z.array(z.string()).optional(),
      openQuestions: z.array(z.string()).optional(),
      goal: z.string().optional(),
    }),
    async execute(args) {
      if (!ctx.multiAgent) {
        throw new Error('update_task_board 仅在 multi-agent 模式可用')
      }
      const { agentId, taskId, taskBoard } = ctx.multiAgent
      if (args.facts || args.decisions || args.openQuestions) {
        await taskBoard.appendScratchpad(taskId, {
          ...(args.facts ? { facts: args.facts } : {}),
          ...(args.decisions ? { decisions: args.decisions } : {}),
          ...(args.openQuestions ? { openQuestions: args.openQuestions } : {}),
        })
      }
      if (args.goal !== undefined && agentId === 'pm') {
        await taskBoard.update(taskId, { goal: args.goal })
      }
      return { ok: true as const }
    },
  })
}
```

- [ ] **Step 2：跑 update_task_board 测试通过**

Run: `pnpm test src/agent/tools/multiAgentTools.test.ts -t "update_task_board"`
Expected: 4 PASS

- [ ] **Step 3：跑全部多 agent tool 测试**

Run: `pnpm test src/agent/tools/multiAgentTools.test.ts`
Expected: 10 PASS（delegate 4 + escalate 2 + update 4）

- [ ] **Step 4：commit**

```bash
git add src/agent/tools/updateTaskBoard.ts
git commit -m "feat(tools): update_task_board 工具，黑板 facts/decisions 追加 + PM goal 覆盖"
```

### Task 3.6：在 buildBuiltinTools 注册三个新 tool

**Files:**
- Modify: `src/agent/tools/index.ts`

把三个新 tool 加到 toolset。**全部 agent 装配同一份 ToolSet**（spec §6 决策：tools 全局），是否真正可用由 `ctx.multiAgent` 是否存在决定。单 agent 模式调这些 tool 会抛错，但因为 system prompt 不引导调用，模型不会主动调。

- [ ] **Step 1：先写 index 测试（确认 toolset 包含新 tool）**

[`src/agent/tools/tools.test.ts:13-25`](../../../src/agent/tools/tools.test.ts) 已有 `stubCtx()` helper。在文件末尾新增 `describe` 块，使用该 helper + 一个最小 `stubDeps()`：

```ts
import { buildBuiltinTools, type BuiltinToolDeps } from './index.ts'
import { resolveWorkspacePaths } from '@/workspace/paths.ts'

const stubDeps = (): BuiltinToolDeps => ({
  memoryStore: { save: async () => '' } as any,
  selfImproveCollector: {} as any,
  selfImproveGenerator: {} as any,
  confirmBridge: {} as any,
  paths: resolveWorkspacePaths(cwd),
  logger: stubCtx().logger,
})

describe('buildBuiltinTools', () => {
  it('toolset includes multi-agent tools', () => {
    const tools = buildBuiltinTools(stubCtx(), stubDeps())
    expect(tools).toHaveProperty('delegate_to')
    expect(tools).toHaveProperty('escalate_to_user')
    expect(tools).toHaveProperty('update_task_board')
  })

  it('toolset still has legacy tools', () => {
    const tools = buildBuiltinTools(stubCtx(), stubDeps())
    expect(tools).toHaveProperty('bash')
    expect(tools).toHaveProperty('edit_file')
    expect(tools).toHaveProperty('save_memory')
  })
})
```

注意 `stubDeps` 用 `as any` 强转最小 mock；只验证 toolset 装配结构，不调真 execute。

- [ ] **Step 2：跑测试看失败**

Run: `pnpm test src/agent/tools/tools.test.ts -t "multi-agent"`
Expected: 缺三个 property 失败

- [ ] **Step 3：注册**

修改 [`src/agent/tools/index.ts`](../../../src/agent/tools/index.ts) 的 `buildBuiltinTools`：

```ts
import { delegateToTool } from './delegateTo.ts'
import { escalateToUserTool } from './escalateToUser.ts'
import { updateTaskBoardTool } from './updateTaskBoard.ts'

// ... 在 return 对象末尾追加
return {
  bash: bashTool(ctx),
  edit_file: editFileTool(ctx),
  save_memory: saveMemoryTool(ctx, { memoryStore: deps.memoryStore }),
  self_improve_collect: selfImproveCollectTool(ctx, { collector: deps.selfImproveCollector }),
  self_improve_confirm: selfImproveConfirmTool(ctx, {
    generator: deps.selfImproveGenerator,
    ...(deps.selfImproveSemanticDedup ? { semanticDedup: deps.selfImproveSemanticDedup } : {}),
    paths: deps.paths,
    logger: deps.logger,
  }),
  ask_confirm: askConfirmTool(ctx, { bridge: deps.confirmBridge, logger: deps.logger }),
  delegate_to: delegateToTool(ctx),
  escalate_to_user: escalateToUserTool(ctx),
  update_task_board: updateTaskBoardTool(ctx),
}
```

- [ ] **Step 4：跑全套测试 + typecheck**

Run: `pnpm test && pnpm typecheck`
Expected: 全绿

- [ ] **Step 5：commit**

```bash
git add src/agent/tools/index.ts src/agent/tools/tools.test.ts
git commit -m "feat(tools): 注册 delegate_to / escalate_to_user / update_task_board 到 builtin toolset"
```

### ✅ Chunk 3 验证

完成后请用户做以下 review：

1. **测试与类型全绿**：`pnpm test && pnpm typecheck`
2. **A2ABus 行为**：手写一段脚本（或 vitest in-process）创建 bus → subscribe → post → 看到 envelope 文件落盘 + handler 收到。
3. **Tool 单点验证**：在一个 multi-agent 模式 fixture 下手动调 `delegate_to` → 检查 `tasks/<id>/envelopes/` 多了文件 + 订阅者收到。
4. **单 Agent 模式仍可用**：跑现有所有非 multi-agent 的 e2e（不接 Slack），确认 `delegate_to` 没被 agent 误调（因为 single 模式 system prompt 不引导，模型不会主动调）。
5. **注意**：Chunk 3 完成后这些 tool 还没被 ConversationOrchestrator 真正注入 multiAgent context。Chunk 4 才把 ToolContext 在 orchestrator 装配时填上 `multiAgent` 字段；在 Chunk 4 完成前，端到端的"PM delegate Coding"链路还没法跑通。

只有上面四项都通过，才进 Chunk 4。

---

## Chunk 4：ConversationOrchestrator 多 Agent 化

**目标**：把 ConversationOrchestrator 的 sessionKey / runQueue / abortRegistry / sessionStore 路径都加上 `agentId` 维度，并接入 A2A bus（订阅 envelope → 合成 InboundMessage 进入处理流），注入 multiAgent ToolContext，处理 `<waiting/>` 的 turn 暂停。**严格保证现有 42KB 单 Agent 测试在 `agentId='default'` 下全绿**——这是本 chunk 的最重风险。

**核心设计**：
- 一个 ConversationOrchestrator 实例 = 一个 Agent。createApplication 在 multi 模式起 N 个 orchestrator，每个 subscribe A2A bus 自己 agentId 的 inbox
- 收到 envelope 时合成 InboundMessage：`text` = envelope.content，`channelId/threadTs` 取自 task.json，`userId` 用 envelope.from（或 originalUser），messageTs 用 envelope.id（保证 abort key 唯一）
- `<waiting/>` 处理：模型在某 turn 输出含该标记 → orchestrator 不立刻 finalize，标记 session 为 awaiting；下一条 inbound（来自 A2A reply）到达时复用该 session 继续

### Task 4.1：SessionStore 加 agentId 维度

**Files:**
- Modify: `src/store/SessionStore.ts`

- [ ] **Step 1：先扩 GetOrCreateArgs + 改 key 推导（先写测试）**

修改 [`src/store/SessionStore.test.ts`](../../../src/store/SessionStore.test.ts) 加一条：

```ts
it('isolates sessions by agentId on the same thread', async () => {
  const store = createSessionStore(paths)
  const args = {
    imProvider: 'slack' as const,
    channelId: 'C001',
    channelName: 'general',
    threadTs: '1.2',
    imUserId: 'U001',
  }
  const a = await store.getOrCreate({ ...args, agentId: 'pm' })
  const b = await store.getOrCreate({ ...args, agentId: 'coding' })
  expect(a.id).not.toBe(b.id)
  expect(a.dir).toContain('/pm')
  expect(b.dir).toContain('/coding')
})

it('defaults agentId to "default" when omitted', async () => {
  const store = createSessionStore(paths)
  const s = await store.getOrCreate({
    imProvider: 'slack', channelId: 'C001', channelName: 'general',
    threadTs: '1.2', imUserId: 'U001',
  })
  expect(s.dir).toContain('/default')
})
```

- [ ] **Step 2：跑测试看失败**

Run: `pnpm test src/store/SessionStore.test.ts`

- [ ] **Step 3：实现 SessionStore agentId 扩展**

修改 [`src/store/SessionStore.ts`](../../../src/store/SessionStore.ts)：

1. `GetOrCreateArgs` 增加 `agentId?: string`（缺省 'default'）
2. session id / 路径推导用 `slackSessionDir(paths, ..., agentId ?? 'default')`
3. 内部 `sessionKey` 字符串增加 agentId 段：`${args.imProvider}:${args.channelId}:${args.threadTs}:${args.agentId ?? 'default'}`

具体改动：
- [`SessionStore.ts:62-69`](../../../src/store/SessionStore.ts) `GetOrCreateArgs` 加 `agentId?: string`
- 第 144 行的 key 推导加 agentId 段
- 第 157 行附近 `slackSessionDir(...)` 调用补传 `agentId ?? 'default'`

- [ ] **Step 4：跑全套测试**

Run: `pnpm test`
Expected: SessionStore 新测试通过；现有 SessionStore 测试 + 下游 orchestrator 测试因 path 变化（多了 `/default` 段）可能断言失败。**逐个修断言**——把 `'sessions/slack/<thread>/messages.jsonl'` 类断言改成 `'sessions/slack/<thread>/default/messages.jsonl'`。

- [ ] **Step 5：commit**

```bash
git add src/store/SessionStore.ts src/store/SessionStore.test.ts
git commit -m "feat(store): SessionStore 加 agentId 维度，单 Agent 行为等同（默认 default）"
```

### Task 4.2：ConversationOrchestrator sessionKey + runQueue + abortRegistry 加 agentId

**Files:**
- Modify: `src/orchestrator/ConversationOrchestrator.ts`
- Test: `src/orchestrator/ConversationOrchestrator.test.ts`

- [ ] **Step 1：扩 ConversationOrchestratorDeps**

修改 [`ConversationOrchestrator.ts:39-51`](../../../src/orchestrator/ConversationOrchestrator.ts) 加：

```ts
export interface ConversationOrchestratorDeps {
  agentId?: string                           // 缺省 'default'，向后兼容
  toolsBuilder: ToolsBuilder
  // ...原字段不变
}
```

- [ ] **Step 2：sessionKeyFor 加 agentId**

[`ConversationOrchestrator.ts:64-65`](../../../src/orchestrator/ConversationOrchestrator.ts)：

```ts
const agentId = deps.agentId ?? 'default'
const sessionKeyFor = (input: InboundMessage): string =>
  `${input.imProvider}:${input.channelId}:${input.threadTs}:${agentId}`
```

- [ ] **Step 3：getOrCreate 时透传 agentId**

[`ConversationOrchestrator.ts:175-181`](../../../src/orchestrator/ConversationOrchestrator.ts) `sessionStore.getOrCreate({...})` 加 `agentId`。

- [ ] **Step 4：跑现有 orchestrator 测试**

Run: `pnpm test src/orchestrator/ConversationOrchestrator.test.ts`
Expected: 全绿（向后兼容：`deps.agentId` 缺省时走 'default'，sessionKey 多一段不影响行为）。如有失败，逐条排查是否 fixture 期望 sessionKey 没有最后一段。

- [ ] **Step 5：commit**

```bash
git add src/orchestrator/ConversationOrchestrator.ts
git commit -m "feat(orchestrator): sessionKey/runQueue 加 agentId 维度，向后兼容默认 default"
```

### Task 4.3：注入 multiAgent ToolContext + task 黑板 prompt 渲染

**Files:**
- Modify: `src/orchestrator/ConversationOrchestrator.ts`

- [ ] **Step 1：扩 deps（可选 multiAgent）**

```ts
export interface ConversationOrchestratorDeps {
  // ...
  multiAgent?: {
    bus: A2ABus
    taskBoard: TaskBoardManager
    /** 入站 InboundMessage 找到 / 创建对应 task 的回调；缺省（单 Agent）时不绑 task */
    resolveTaskId(input: InboundMessage): Promise<string | undefined>
  }
}
```

`resolveTaskId` 由 application 层提供：根据 `(channelId, threadTs)` 查找已有 task；如果是 PM 收到的初次 mention，则创建新 task 并返回 id。Chunk 5 实现该回调；Chunk 4 仅暴露接口。

- [ ] **Step 2：在 toolsBuilder 之前装配 multiAgent ToolContext**

[`createApplication.ts:98-118`](../../../src/application/createApplication.ts) 现有 `toolsBuilder` 拿 `currentUser` + `imContext`。Chunk 4 仅改 orchestrator 内部：在 `handle` 内拿到 `taskId` 后传 multiAgent 上下文给 `toolsBuilder`：

```ts
// 在 handle 入口附近：
let taskId: string | undefined
if (deps.multiAgent) {
  taskId = await deps.multiAgent.resolveTaskId(input)
}
// ...构造 toolsBuilder context 时
const toolCtxExtra = deps.multiAgent && taskId
  ? {
      multiAgent: {
        agentId,
        taskId,
        bus: deps.multiAgent.bus,
        taskBoard: deps.multiAgent.taskBoard,
      },
    }
  : {}
const tools = deps.toolsBuilder(currentUser, { confirm: ..., ...toolCtxExtra })
```

注意：`toolsBuilder` 当前签名是 `(currentUser, { confirm? })`。需要把第二个参数扩成可包 `multiAgent`。修 application 层 [`createApplication.ts`](../../../src/application/createApplication.ts) 的 `toolsBuilder` 闭包签名以接受多余字段，原样透传给 `buildBuiltinTools(ctx, deps)` 的 `ctx`。

- [ ] **Step 3：把 task 黑板渲染到 systemPrompt**

[`ConversationOrchestrator.ts:278-300`](../../../src/orchestrator/ConversationOrchestrator.ts) 现有：

```ts
const systemPromptWithMemory = `${deps.systemPrompt}${memoryHint}`
```

改为：

```ts
let taskBoardSection = ''
if (deps.multiAgent && taskId) {
  const board = await deps.multiAgent.taskBoard.read(taskId)
  if (board) taskBoardSection = `\n\n${deps.multiAgent.taskBoard.renderForPrompt(board)}`
}
const systemPromptWithMemory = `${deps.systemPrompt}${memoryHint}${taskBoardSection}`
```

- [ ] **Step 4：写 multi-agent 模式的集成测试（mock multiAgent deps）**

`src/orchestrator/ConversationOrchestrator.test.ts` 末尾追加 `describe('multi-agent mode')`：用真 A2ABus + TaskBoard、mock executorFactory（返回固定 model output）、断言：

(a) `handle` 时 toolsBuilder 收到的 ctx 含 `multiAgent: { agentId, taskId, bus, taskBoard }`
(b) systemPrompt 中包含 `## Task Board` 段
(c) `agentId='default'` 时（无 multiAgent deps）行为完全等同今天

具体细节：现有 `ConversationOrchestrator.test.ts` 用 `createConversationOrchestrator` 直接 wire；mock executor 返回 `{ steps: [], finalText: 'done', usage: ... }` 即可；toolsBuilder 用 spy 记录传入的 ctx。

- [ ] **Step 5：跑测试通过**

Run: `pnpm test src/orchestrator/ConversationOrchestrator.test.ts`
Expected: 现有 + 新增全绿

- [ ] **Step 6：commit**

```bash
git add src/orchestrator/ConversationOrchestrator.ts src/orchestrator/ConversationOrchestrator.test.ts src/application/createApplication.ts
git commit -m "feat(orchestrator): 注入 multiAgent ToolContext + 渲染 task 黑板到 system prompt"
```

### Task 4.4：A2A envelope inbox 订阅 → 合成 InboundMessage

**Files:**
- Modify: `src/orchestrator/ConversationOrchestrator.ts`

- [ ] **Step 1：暴露 subscribe API**

ConversationOrchestrator 新增 `subscribeA2A()` 方法：

```ts
export interface ConversationOrchestrator {
  handle(input: InboundMessage, sink: EventSink): Promise<void>
  /** Multi-agent 模式：订阅 A2A bus 自己 agentId 的 inbox。返回 unsubscribe 函数。 */
  subscribeA2A(): () => void
}
```

实现：

```ts
subscribeA2A() {
  if (!deps.multiAgent) {
    throw new Error('subscribeA2A 仅在 multi-agent 模式可用')
  }
  return deps.multiAgent.bus.subscribe(agentId, async (envelope) => {
    // 合成 InboundMessage，复用现有 handle 流程
    const board = await deps.multiAgent!.taskBoard.read(envelope.taskId)
    if (!board) {
      log.warn(`收到 envelope 但 task 不存在 ${envelope.taskId}`)
      return
    }
    const synthetic: InboundMessage = {
      imProvider: 'slack',
      channelId: board.channelId,
      channelName: '<a2a>',
      threadTs: board.threadTs,
      messageTs: envelope.id,                 // 用 envelopeId 作 abort key 唯一
      userId: envelope.from === 'user' ? board.originalUser : `agent:${envelope.from}`,
      userName: envelope.from === 'user' ? board.originalUser : envelope.from,
      text: envelope.content,
      // 其他必填字段补默认（参考 InboundMessage 类型）
    }
    // sink 用 noop（A2A 路径不发 Slack；P1 接 Slack 时再换 SlackEventSink）
    const noopSink: EventSink = {
      onEvent: async () => {},
      finalize: async () => {},
    }
    await this.handle(synthetic, noopSink)
  })
}
```

注意：`InboundMessage` 类型其他必填字段需对照 [`src/im/types.ts`](../../../src/im/types.ts) 补齐。`<a2a>` channelName 仅作为占位，sessionStore 创建 session 时会用上但 P0 不影响功能。

- [ ] **Step 2：写 A2A 入站集成测试**

`ConversationOrchestrator.test.ts` 加：

```ts
it('processes A2A envelope as a synthesized InboundMessage', async () => {
  const { bus, tb, taskId } = await setupMultiAgentFixture()
  const orchestrator = createConversationOrchestrator({
    agentId: 'coding',
    multiAgent: { bus, taskBoard: tb, resolveTaskId: async () => taskId },
    // 其他 deps...
    executorFactory: () => mockExecutor((messages) => ({
      finalText: '收到，开干',
      steps: [],
      // ...
    })),
  })
  orchestrator.subscribeA2A()

  await bus.post({
    id: 'env_test',
    taskId,
    from: 'pm',
    to: 'coding',
    intent: 'delegate',
    content: '请修复 foo bug',
    createdAt: new Date().toISOString(),
  })

  // 等 handle 完成
  await new Promise((r) => setTimeout(r, 50))

  // session 已建：sessions/slack/<chan>.<thread>/coding/messages.jsonl 存在
  // messages.jsonl 含一条 user 消息 = envelope.content
  // ...
})
```

- [ ] **Step 3：跑测试通过**

Run: `pnpm test src/orchestrator/ConversationOrchestrator.test.ts -t "A2A envelope"`

- [ ] **Step 4：commit**

```bash
git add src/orchestrator/ConversationOrchestrator.ts src/orchestrator/ConversationOrchestrator.test.ts
git commit -m "feat(orchestrator): subscribeA2A 把 envelope 合成 InboundMessage 进入处理流"
```

### Task 4.5：`<waiting/>` 标记处理（turn 暂停）

**Files:**
- Modify: `src/orchestrator/ConversationOrchestrator.ts`

行为（spec §5.2 时序图）：
- 模型在某 turn 输出含 `<waiting/>` 标记的文本 → orchestrator 不抛错、不 emit assistant-message 到 sink、不 finalize
- 该 turn 的 model output 仍写入 messages.jsonl（保留对话历史）
- 当 A2A reply envelope 到达 → `subscribeA2A` 触发 `handle` 复用同一 sessionKey → SessionRunQueue 自动排队 → 模型看到新 user 消息（reply 内容）继续

实际上由于 SessionRunQueue + sessionStore 已是串行机制，**`<waiting/>` 不需要特殊状态机**——只需在某 turn 模型输出 `<waiting/>` 时跳过 finalizeSink、不 emit。下次 envelope 到达时排队下一轮 turn 自然会继续。

- [ ] **Step 1：写测试**

```ts
it('does not finalize when model output contains <waiting/>', async () => {
  const orchestrator = createConversationOrchestrator({
    // ...
    executorFactory: () => mockExecutor(() => ({
      finalText: '在等 CS 回，<waiting/>',
      steps: [],
    })),
  })
  const sink = makeSpySink()
  await orchestrator.handle(makeInbound(), sink)
  expect(sink.finalize).not.toHaveBeenCalled()
})

it('finalizes when next turn produces final output (no waiting)', async () => {
  let turn = 0
  const orchestrator = createConversationOrchestrator({
    executorFactory: () => mockExecutor(() => {
      turn++
      return {
        finalText: turn === 1 ? '<waiting/>' : '最终答复',
        steps: [],
      }
    }),
  })
  const sink1 = makeSpySink()
  await orchestrator.handle(makeInbound('msg-1'), sink1)
  expect(sink1.finalize).not.toHaveBeenCalled()
  const sink2 = makeSpySink()
  await orchestrator.handle(makeInbound('msg-2'), sink2)
  expect(sink2.finalize).toHaveBeenCalled()
})
```

- [ ] **Step 2：实现**

在 [`ConversationOrchestrator.ts`](../../../src/orchestrator/ConversationOrchestrator.ts) `handle` 末尾：

```ts
const isWaiting = /\<waiting\/\>/.test(modelFinalText)
if (!isWaiting) {
  await sink.onEvent({ type: 'assistant-message', text: modelFinalText })
  await finalizeSink()
} else {
  log.info(`agent=${agentId} 输出 <waiting/>，turn 不 finalize，等待 reply envelope`)
  // 仍把 model output 写入 messages.jsonl（已在前面 appendMessage 完成）
}
```

具体注入位置：找到现在调 `sink.onEvent({ type: 'assistant-message' ... })` 的那段，包一层 isWaiting 检测。

- [ ] **Step 3：跑测试**

Run: `pnpm test src/orchestrator/ConversationOrchestrator.test.ts -t "waiting"`

- [ ] **Step 4：commit**

```bash
git add src/orchestrator/ConversationOrchestrator.ts src/orchestrator/ConversationOrchestrator.test.ts
git commit -m "feat(orchestrator): 模型输出含 <waiting/> 时 turn 不 finalize，等待 reply envelope"
```

### Task 4.6：单 Agent 回归全套测试

**Files:** 无（仅跑测试 + 修必要断言）

- [ ] **Step 1：跑现有 42KB orchestrator 测试套**

Run: `pnpm test src/orchestrator/ConversationOrchestrator.test.ts`
Expected: 全绿。如有失败，多半是 sessionKey 路径多了 `/default` 段、或 sessionKey 字符串多了一段。逐条修断言。

- [ ] **Step 2：跑全套**

Run: `pnpm test && pnpm typecheck`
Expected: 全绿

- [ ] **Step 3：commit（如有断言修订）**

```bash
git add -u
git commit -m "test(orchestrator): 现有用例适配 agentId='default' 新 sessionKey 与路径"
```

### ✅ Chunk 4 验证

完成后请用户做以下 review：

1. **测试与类型全绿**：`pnpm test && pnpm typecheck`
2. **回归手测**：在测试 workspace 起 daemon，发一条 mention，行为完全等同今天（Slack 回复正常、session 路径多了 `default/` 一层、abort 仍能用）
3. **关键代码 review**：
   - `ConversationOrchestrator.subscribeA2A` 实现是否正确把 envelope 转 InboundMessage
   - `<waiting/>` 检测的位置是否在正确的 turn 末尾
   - multiAgent ToolContext 是否在所有 toolsBuilder 调用点都注入
4. **注意**：Chunk 4 完成后，**单 Agent 模式可上线**（向后兼容）；但 multi-agent 模式还需要 Chunk 5 装配 createApplication 才能跑 PM+Coding 端到端。

只有上面三项都通过，才进 Chunk 5。

---

## Chunk 5：createApplication 多 Agent 装配 + 端到端集成测试

**目标**：把所有部件串起来——createApplication 在 multi 模式实例化 N 个 ConversationOrchestrator，共享 A2ABus + TaskBoardManager + WorktreeManager；提供 `resolveTaskId` 实现（PM 创建 task，其他 agent 沿用）；写 PM+Coding 两 Agent 端到端 fixture 集成测试，验证 spec §13 P0 的"两个 Agent 跑通一次完整 A2A 来回"单位价值。

### Task 5.1：createApplication multi-agent wiring

**Files:**
- Modify: `src/application/createApplication.ts`

- [ ] **Step 1：装配多 orchestrator + 共享 bus / taskBoard / worktreeManager**

[`createApplication.ts`](../../../src/application/createApplication.ts) 改造：

```ts
import { createA2ABus } from '@/multiAgent/A2ABus.ts'
import { createTaskBoardManager } from '@/multiAgent/TaskBoard.ts'
import { createWorktreeManager } from '@/multiAgent/WorktreeManager.ts'
import { loadSystemPrompt } from '@/multiAgent/RolePromptLoader.ts'
import { newTaskId } from '@/multiAgent/types.ts'

const isMultiAgent = ctx.config.agents.length > 1
const bus = createA2ABus(ctx.paths)
const taskBoard = createTaskBoardManager(ctx.paths)
const worktreeManager = createWorktreeManager(ctx.paths, ctx.cwd)

// 启动期清理过期 worktree
await worktreeManager.cleanupExpired().catch((err) => log.warn('worktree cleanup 失败', err))

const orchestrators: Array<{
  agentId: string
  orchestrator: ConversationOrchestrator
  unsubscribeA2A?: () => void
}> = []

for (const agentCfg of ctx.config.agents) {
  const systemPrompt = await loadSystemPrompt(args.workspaceDir, agentCfg.role, logger)
  const provider = selectProvider(agentCfg.provider)
  const providerEnv = loadProviderEnv(provider) // P0 共用一组 env，但保留 per-agent 选择能力
  const runtime = buildProviderRuntime(provider, providerEnv, agentCfg.model)

  const orchestrator = createConversationOrchestrator({
    agentId: agentCfg.id,
    toolsBuilder: (currentUser, imContext) =>
      buildBuiltinTools(
        { cwd: ctx.cwd, logger, currentUser, ...imContext },
        { memoryStore, selfImproveCollector, selfImproveGenerator, selfImproveSemanticDedup, confirmBridge, paths: ctx.paths, logger },
      ),
    executorFactory: (tools) =>
      createAiSdkExecutor({
        model: runtime.model, modelName: runtime.modelName, tools,
        maxSteps: agentCfg.maxSteps, logger,
        ...(runtime.providerNameForOptions ? { providerName: runtime.providerNameForOptions } : {}),
      }),
    sessionStore, memoryStore, runQueue, abortRegistry,
    systemPrompt,
    modelMessageBudget: agentCfg.context,
    mentionCommandRouter, contextCompactor, logger,
    ...(isMultiAgent
      ? {
          multiAgent: {
            bus,
            taskBoard,
            resolveTaskId: async (input) => resolveTaskIdForInbound(input, agentCfg.id, taskBoard, ctx),
          },
        }
      : {}),
  })

  const item: typeof orchestrators[number] = { agentId: agentCfg.id, orchestrator }
  if (isMultiAgent) {
    item.unsubscribeA2A = orchestrator.subscribeA2A()
  }
  orchestrators.push(item)
}
```

`resolveTaskIdForInbound` 实现（spec §5.3）：

```ts
async function resolveTaskIdForInbound(
  input: InboundMessage,
  agentId: string,
  taskBoard: TaskBoardManager,
  ctx: WorkspaceContext,
): Promise<string> {
  // 用 (channelId, threadTs) 作为天然 task key：扫 tasks/ 目录找匹配
  // P0 用最朴素的扫描；P1 加一个反向索引文件优化
  const matched = await findExistingTask(ctx.paths, input.channelId, input.threadTs)
  if (matched) return matched
  // 否则创建新 task：仅当当前 agent 是 PM（首次 mention 由 PM 起）
  // 非 PM 收到无 task 的 inbound 时——P0 也允许创建（用户直接 @coding 走"直接对话"路径）
  const taskId = newTaskId()
  await taskBoard.create({
    taskId,
    threadTs: input.threadTs,
    channelId: input.channelId,
    originalUser: input.userId,
    goal: '',
    state: 'active',
    activeAgent: agentId,
  })
  return taskId
}
```

`findExistingTask` 简单实现：扫 `paths.root/tasks/*/task.json` 读 channelId/threadTs。

- [ ] **Step 2：扩 Application 类型暴露 orchestrators 列表**

[`src/application/types.ts`](../../../src/application/types.ts) 增加 `orchestrators` 字段（dashboard / 测试用）。`stop()` 内调每个 unsubscribeA2A。

- [ ] **Step 3：跑全套测试**

Run: `pnpm test && pnpm typecheck`
Expected: 全绿

- [ ] **Step 4：commit**

```bash
git add src/application/createApplication.ts src/application/types.ts
git commit -m "feat(application): multi 模式装配 N 个 orchestrator + 共享 A2ABus/TaskBoard/Worktree"
```

### Task 5.2：端到端 fixture 集成测试（PM + Coding）

**Files:**
- Create: `src/multiAgent/integration.test.ts`

测试场景（spec §13 P0 单位价值）：
- 启动一个 mini application（不接 Slack）：2 个 agent (pm/coding)，mock executorFactory
- PM 收到模拟用户消息「修复 foo bug」（通过直接调 PM orchestrator.handle）
- PM 模型 mock 输出："`<waiting/>`" 同时 toolCall delegate_to(coding, "fix foo")
- Coding 模型 mock 输出：toolCall delegate_to(pm, "已修复") with intent='reply'
- PM 收到 reply 后输出："✓ 已合并"
- 断言：
  (a) `tasks/<id>/envelopes/` 至少 3 条 envelope（pm→coding delegate / coding→pm reply / pm→thread final）
  (b) `task.json.state === 'done'` 或 'active' + 有 final envelope
  (c) PM 与 Coding 各自的 sessions/.../{pm,coding}/messages.jsonl 都被写入
  (d) Coding 的 worktree 被创建（如果 mock 模型有调 git tool）

P0 集成测试不跑真 LLM；用 mock executorFactory 按预设脚本响应。脚本设计示例：

```ts
const scripts: Record<string, Array<MockTurn>> = {
  pm: [
    { tool: 'delegate_to', args: { agent: 'coding', content: 'fix foo' }, finalText: '<waiting/>' },
    { finalText: '✓ 已合并', emitFinalEnvelope: true },  // intent='final', to='thread'
  ],
  coding: [
    { tool: 'delegate_to', args: { agent: 'pm', content: '已修复', intent: 'reply' }, finalText: '<waiting/>' },
  ],
}
```

集成测试用 helper `setupMultiAgentApp(scripts)` 起 mini application，return `{ pmOrchestrator, codingOrchestrator, taskBoard, paths }`。

- [ ] **Step 1：写集成测试**

```ts
// src/multiAgent/integration.test.ts
import { describe, it, expect } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import { setupMultiAgentApp, makeUserInbound } from './testHelpers.ts'  // 新建辅助

describe('Multi-Agent end-to-end (P0 fixture)', () => {
  it('PM → Coding → PM completes a delegate-reply-final round trip', async () => {
    const app = await setupMultiAgentApp({
      pm: [
        { delegateTo: { agent: 'coding', content: 'fix foo' }, waiting: true },
        { finalText: '✓ 已合并', finalEnvelope: true },
      ],
      coding: [
        { replyTo: { agent: 'pm', content: '已修复' } },
      ],
    })

    await app.pm.handle(makeUserInbound('修复 foo bug'), app.noopSink())

    // 等所有 A2A 流转完成
    await app.drain()

    const envelopes = await fs.readdir(
      path.join(app.paths.root, 'tasks', app.taskId, 'envelopes'),
    )
    expect(envelopes.length).toBeGreaterThanOrEqual(3)

    const board = await app.taskBoard.read(app.taskId)
    expect(board?.state).toBe('done')

    expect(
      await fs
        .stat(
          path.join(
            app.paths.sessionsDir,
            'slack',
            `<chan>.<id>.<ts>/pm/messages.jsonl`,
          ),
        )
        .then(() => true)
        .catch(() => false),
    ).toBe(true)
  })

  it('runs single-agent mode unchanged (regression guard)', async () => {
    const app = await setupSingleAgentApp({ default: [{ finalText: 'hi' }] })
    const sink = app.spySink()
    await app.default.handle(makeUserInbound('hi'), sink)
    expect(sink.finalize).toHaveBeenCalled()
    // 没有 task / envelope 文件
    expect(
      await fs
        .stat(path.join(app.paths.root, 'tasks'))
        .then(() => true)
        .catch(() => false),
    ).toBe(false)
  })
})
```

- [ ] **Step 2：实现 testHelpers**

`src/multiAgent/testHelpers.ts` 提供：
- `setupMultiAgentApp(scripts)` / `setupSingleAgentApp(scripts)`：起 mini app（无 Slack）
- `makeUserInbound(text)`：构造 InboundMessage
- `mockExecutorFromScript(script)`：模型脚本 → AgentExecutor mock

- [ ] **Step 3：跑集成测试**

Run: `pnpm test src/multiAgent/integration.test.ts`
Expected: 2 PASS

- [ ] **Step 4：commit**

```bash
git add src/multiAgent/integration.test.ts src/multiAgent/testHelpers.ts
git commit -m "test(multiAgent): P0 端到端 fixture 集成测试，PM+Coding 完整 A2A 来回"
```

### Task 5.3：daemon worktree 定时清理任务

**Files:**
- Modify: `src/daemon/`（具体文件待找）

spec §6.5 要求 daemon 启动 + 每天凌晨扫一次 cleanupExpired。

- [ ] **Step 1：在 daemon 主循环加 setInterval**

具体位置：daemon entry 文件（grep 找当前 daemon 的 main loop）。加：

```ts
// 启动期已在 createApplication 跑过一次；daemon 内每 24h 再跑一次
const cleanupTimer = setInterval(() => {
  app.worktreeManager.cleanupExpired().catch((err) =>
    logger.warn('定时 worktree cleanup 失败', err),
  )
}, 24 * 60 * 60 * 1000)
process.on('exit', () => clearInterval(cleanupTimer))
```

- [ ] **Step 2：commit**

```bash
git add src/daemon/...
git commit -m "feat(daemon): 每日定时清理过期 worktree"
```

### ✅ Chunk 5 验证（也是 P0 终验）

完成后请用户做以下 review：

1. **测试 + 类型全绿**：`pnpm test && pnpm typecheck`
2. **集成测试断言**：`src/multiAgent/integration.test.ts` 两个 case 都绿
3. **手测单 Agent 回归**：在真 workspace 跑现有所有 e2e（`pnpm e2e`），全绿
4. **手测 multi 模式雏形**（不接 Slack）：写一段 `tsx` 脚本起 mini application，手动 push 一条 envelope，看到 envelope 文件落盘 + task.json 状态变化 + sessions 多个 agentId 子目录
5. **spec §12 单 Agent 回归测试清单逐项验证**：
   - [ ] 单 mention 触发 → 单 turn 完整跑完 → Slack 回复（手测）
   - [ ] 多轮 thread 对话 → session 持久化正确（路径多了 `default/` 一层）（手测）
   - [ ] channel-tasks 触发 → agent run + 回复（手测）
   - [ ] context compact 在 maxApproxChars 触达后正常压缩（沿用现有 e2e）
   - [ ] abort 能中止当前 turn（手测 stop 命令）
   - [ ] memory / skill 调用结果与今天一致（手测）
   - [ ] dashboard 各 tab 正常
   - [ ] 老 `agent.*` 配置自动迁移生效（手测一份旧 yaml）

P0 = 上述全部通过。可以进入 P1（Slack 多 SocketMode 接入 + onboard 模式选择 + upgrade CLI）。

---

每个 chunk 完成后过 plan-document-reviewer，通过再继续。
