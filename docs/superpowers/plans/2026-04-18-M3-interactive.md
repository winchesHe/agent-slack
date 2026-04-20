# M3 交互完善 实施计划（阶段 5）

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 补齐"生产可用"所需交互：Skills 加载进 system prompt、同 session 消息串行（SessionRunQueue）、🛑 reaction 中断（AbortRegistry）、tool-call / tool-result 配对持久化到 messages.jsonl。

**Architecture:** 在 Orchestrator 内层挂两条新组件：`SessionRunQueue`（每 session 一个 FIFO 队列）和 `AbortRegistry`（key = messageTs，保存 AbortController）。SlackAdapter 新增 `reaction_added` handler 捕获 🛑 事件，触发 `registry.abort(messageTs)`。Skills 加载由 `SkillLoader` 在 `createApplication` 时一次性扫描 `<cwd>/.agent-slack/skills/` 并拼接到 systemPrompt。

**Tech Stack:** `gray-matter`（SKILL.md frontmatter）、既有 AbortController、`@slack/bolt` reaction_added event。

**Spec 对照：** spec §2.2 `Skill` 接口、§4.2 Abort 路径、§4.4 并发控制。

**Range:** spec §7 阶段 5。**前置**：M2 完成。**不包含**：CLI（M4）、memory 全文检索（二期）。

**执行 gate（新增）**：
- chunk-1 → chunk-4 必须严格串行推进，不并行开工。
- 每个 chunk 完成实现后，先执行该 chunk 的 **Slack UI 可验证观测性任务**。
- 只有在人工 review + Slack 验证明确通过后，才能继续下一块。
- `logs/...`、`messages.jsonl`、`meta.json`、结构化 debug 事件只作为补充排查信息，不是这些观测性任务的主验收标准。

---

## File Structure

```
src/
  workspace/
    SkillLoader.ts                      # 新增
    SkillLoader.test.ts
    WorkspaceContext.ts                 # 改：loadWorkspaceContext 接 SkillLoader
  orchestrator/
    AbortRegistry.ts                    # 新增
    AbortRegistry.test.ts
    SessionRunQueue.ts                  # 新增（每 session 一个 promise 链）
    SessionRunQueue.test.ts
    ConversationOrchestrator.ts         # 改：接 queue + registry + tool 持久化
  im/slack/
    SlackAdapter.ts                     # 改：新增 reaction_added handler + ⏳ queued reaction
  store/
    SessionStore.ts                     # 改：append 支持 AssistantMessage（tool-call array） + ToolResultMessage
```

---

## Chunk 1: Skills 加载

### Task 1.1: SkillLoader

**Files:**
- Create: `src/workspace/SkillLoader.ts`
- Create: `src/workspace/SkillLoader.test.ts`

**语义**：
- 扫描 `<skillsDir>/*/SKILL.md`
- `gray-matter` 解析 frontmatter：`{ name, description, whenToUse? }`
- 按 `config.skills.enabled`（`['*']` 或具体名字列表）过滤
- 按字母序排序（spec §10 待决已定一期字母序）
- 返回 `Skill[]`，source = 绝对路径
- 任何 SKILL.md 解析失败只 warn 不 throw

- [ ] **Step 1: 测试**

```ts
import { describe, expect, it, beforeEach } from 'vitest'
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { loadSkills } from './SkillLoader.ts'

let skillsDir: string
beforeEach(() => {
  const tmp = mkdtempSync(path.join(tmpdir(), 'skills-'))
  skillsDir = path.join(tmp, 'skills')
  mkdirSync(skillsDir)
})

const writeSkill = (name: string, body: string) => {
  mkdirSync(path.join(skillsDir, name), { recursive: true })
  writeFileSync(path.join(skillsDir, name, 'SKILL.md'), body)
}

describe('loadSkills', () => {
  it('加载并按字母序', async () => {
    writeSkill('b-skill', '---\nname: b-skill\ndescription: b\n---\nbody b')
    writeSkill('a-skill', '---\nname: a-skill\ndescription: a\n---\nbody a')
    const skills = await loadSkills(skillsDir, ['*'], stubLogger())
    expect(skills.map((s) => s.name)).toEqual(['a-skill', 'b-skill'])
  })

  it('enabled 白名单过滤', async () => {
    writeSkill('a', '---\nname: a\ndescription: a\n---\nx')
    writeSkill('b', '---\nname: b\ndescription: b\n---\nx')
    const skills = await loadSkills(skillsDir, ['a'], stubLogger())
    expect(skills.map((s) => s.name)).toEqual(['a'])
  })

  it('坏 frontmatter 跳过不抛', async () => {
    writeSkill('broken', '---\ninvalid: [\n---\nx')
    const skills = await loadSkills(skillsDir, ['*'], stubLogger())
    expect(skills).toEqual([])
  })

  it('skillsDir 不存在返回空', async () => {
    const skills = await loadSkills('/nonexistent/path', ['*'], stubLogger())
    expect(skills).toEqual([])
  })
})

function stubLogger(): any {
  const l: any = { debug() {}, info() {}, warn() {}, error() {}, withTag: () => l }
  return l
}
```

- [ ] **Step 2: 实现**

```ts
import { readFile, readdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import matter from 'gray-matter'
import type { Skill } from './WorkspaceContext.ts'
import type { Logger } from '@/logger/logger.ts'

export async function loadSkills(
  skillsDir: string,
  enabled: readonly string[],
  logger: Logger,
): Promise<Skill[]> {
  const log = logger.withTag('skills')
  if (!existsSync(skillsDir)) return []
  const entries = await readdir(skillsDir, { withFileTypes: true })
  const loaded: Skill[] = []
  for (const e of entries) {
    if (!e.isDirectory()) continue
    const file = path.join(skillsDir, e.name, 'SKILL.md')
    if (!existsSync(file)) continue
    try {
      const raw = await readFile(file, 'utf8')
      const parsed = matter(raw)
      const fm = parsed.data as { name?: string; description?: string; whenToUse?: string }
      const name = fm.name ?? e.name
      const description = fm.description ?? ''
      loaded.push({
        name,
        description,
        whenToUse: fm.whenToUse,
        content: parsed.content.trim(),
        source: file,
      })
    } catch (err) {
      log.warn(`解析 SKILL.md 失败: ${file}`, err)
    }
  }
  const wildcard = enabled.includes('*')
  const filtered = wildcard ? loaded : loaded.filter((s) => enabled.includes(s.name))
  return filtered.sort((a, b) => a.name.localeCompare(b.name))
}
```

- [ ] **Step 3: Commit**

```bash
git add src/workspace/SkillLoader.ts src/workspace/SkillLoader.test.ts
git commit -m "阶段 5: SkillLoader"
```

### Task 1.2: WorkspaceContext 接入 Skills + systemPrompt 拼接

**Files:**
- Modify: `src/workspace/WorkspaceContext.ts`
- Modify: `src/workspace/WorkspaceContext.test.ts`
- Modify: `src/application/createApplication.ts`

- [ ] **Step 1: 修改 WorkspaceContext**

```ts
// 追加 loadSkills 调用
import { loadSkills } from './SkillLoader.ts'
import type { Logger } from '@/logger/logger.ts'

export async function loadWorkspaceContext(
  cwd: string,
  logger: Logger,       // ← 新增参数
): Promise<WorkspaceContext> {
  const paths = resolveWorkspacePaths(cwd)
  const config = existsSync(paths.configFile)
    ? parseConfig(YAML.parse(await readFile(paths.configFile, 'utf8')))
    : parseConfig({})
  const systemPromptBase = existsSync(paths.systemFile)
    ? await readFile(paths.systemFile, 'utf8')
    : ''
  const skills = await loadSkills(paths.skillsDir, config.skills.enabled, logger)
  const systemPrompt = composeSystemPrompt(systemPromptBase, skills)
  return { cwd, paths, config, systemPrompt, skills }
}

function composeSystemPrompt(base: string, skills: Skill[]): string {
  if (skills.length === 0) return base
  const skillSection = skills
    .map((s) => {
      const whenLine = s.whenToUse ? `\n**When to use:** ${s.whenToUse}` : ''
      return `### Skill: ${s.name}\n${s.description}${whenLine}\n\n${s.content}`
    })
    .join('\n\n---\n\n')
  return `${base}\n\n## Available Skills\n\n${skillSection}`.trim()
}
```

- [ ] **Step 2: 更新测试**：注入 stubLogger，并加一个"有 skill 的 workspace → systemPrompt 包含 'Available Skills'"的 case。

- [ ] **Step 3: 修改 createApplication 传 logger**

```ts
const logger = createLogger({ level: env.logLevel, redactor })
const ctx = await loadWorkspaceContext(args.workspaceDir, logger)   // ← 第二个参数
```

- [ ] **Step 4: Run tests → PASS，Commit**

```bash
git add src/workspace/WorkspaceContext.ts src/workspace/WorkspaceContext.test.ts src/application/createApplication.ts
git commit -m "阶段 5: Skills 拼接到 system prompt"
```

### Chunk 1 Slack UI 可验证观测性任务：Skills 文案生效

- **目标文件**：`src/workspace/SkillLoader.ts`、`src/workspace/WorkspaceContext.ts`、`src/application/createApplication.ts`；手工验收时额外创建/更新 `<cwd>/.agent-slack/skills/tone/SKILL.md`。
- **Slack 上的操作 / 触发方式**：重启服务后，在同一 Slack thread 发送 `@bot 你好吗？请用两句话回答。`，其中 `tone` skill 明确要求使用正式书面中文。
- **Slack UI 中可直接看到的预期结果**：bot 最终回复直接体现 skill 约束（正式、书面、非口语化）；主验收只看 Slack 中的最终文案是否生效。
- **补充观察（非主标准）**：若人工 review 需要二次确认，可额外参考 system prompt debug log 是否包含 `Available Skills`，但它不能替代 Slack UI 验收。
- **人工 review gate**：chunk-1 完成后必须暂停，等待人工 review / Slack 验证通过，才能进入 chunk-2。

---

## Chunk 2: SessionRunQueue + AbortRegistry

### Task 2.1: AbortRegistry

**Files:**
- Create: `src/orchestrator/AbortRegistry.ts`
- Create: `src/orchestrator/AbortRegistry.test.ts`

**语义**：
- `create(key)`：新建 `AbortController`，存入 map，返回 controller；若 key 已存在 throw（不应发生）
- `abort(key, reason?)`：调用对应 controller.abort(reason)；key 不存在时静默 no-op（用户可能对历史消息加 🛑）
- `delete(key)`：从 map 删除（orchestrator 在 finally 调用）
- `abortAll(reason)`：graceful shutdown 用

- [ ] **Step 1: 测试**

```ts
import { describe, expect, it } from 'vitest'
import { createAbortRegistry } from './AbortRegistry.ts'

describe('AbortRegistry', () => {
  it('create 返回 AbortController', () => {
    const reg = createAbortRegistry()
    const ctrl = reg.create('k1')
    expect(ctrl.signal.aborted).toBe(false)
  })

  it('abort 触发 signal', () => {
    const reg = createAbortRegistry()
    const ctrl = reg.create('k1')
    reg.abort('k1', 'user')
    expect(ctrl.signal.aborted).toBe(true)
  })

  it('abort 未知 key 静默', () => {
    const reg = createAbortRegistry()
    expect(() => reg.abort('unknown')).not.toThrow()
  })

  it('delete 后重复 create 可用', () => {
    const reg = createAbortRegistry()
    reg.create('k')
    reg.delete('k')
    expect(() => reg.create('k')).not.toThrow()
  })

  it('abortAll', () => {
    const reg = createAbortRegistry()
    const c1 = reg.create('a')
    const c2 = reg.create('b')
    reg.abortAll('shutdown')
    expect(c1.signal.aborted).toBe(true)
    expect(c2.signal.aborted).toBe(true)
  })
})
```

- [ ] **Step 2: 实现**

```ts
export interface AbortRegistry {
  create(key: string): AbortController
  abort(key: string, reason?: string): void
  delete(key: string): void
  abortAll(reason?: string): void
}

export function createAbortRegistry(): AbortRegistry {
  const map = new Map<string, AbortController>()
  return {
    create(key) {
      if (map.has(key)) throw new Error(`abort key already exists: ${key}`)
      const ctrl = new AbortController()
      map.set(key, ctrl)
      return ctrl
    },
    abort(key, reason) {
      map.get(key)?.abort(reason ?? 'aborted')
    },
    delete(key) {
      map.delete(key)
    },
    abortAll(reason) {
      for (const c of map.values()) c.abort(reason ?? 'aborted')
      map.clear()
    },
  }
}
```

- [ ] **Step 3: Commit**

```bash
git add src/orchestrator/AbortRegistry.ts src/orchestrator/AbortRegistry.test.ts
git commit -m "阶段 5: AbortRegistry"
```

### Task 2.2: SessionRunQueue

**Files:**
- Create: `src/orchestrator/SessionRunQueue.ts`
- Create: `src/orchestrator/SessionRunQueue.test.ts`

**语义**：
- `enqueue(sessionId, runner: () => Promise<void>)`：同 sessionId 的 runner 严格按顺序执行；不同 sessionId 并行
- `queueDepth(sessionId)`：返回排队深度（含正在执行的那个）
- 实现方式：每个 sessionId 一个"promise 链"——`chain = chain.then(runner).catch(swallow)`
- 空闲队列自动 GC（链彻底完成后删除 key，避免 map 无限增长）

- [ ] **Step 1: 测试**

```ts
import { describe, expect, it } from 'vitest'
import { createSessionRunQueue } from './SessionRunQueue.ts'

describe('SessionRunQueue', () => {
  it('同 session 串行', async () => {
    const queue = createSessionRunQueue()
    const order: number[] = []
    const d = (n: number, ms: number): Promise<void> =>
      new Promise((r) => setTimeout(() => { order.push(n); r() }, ms))
    const a = queue.enqueue('s', () => d(1, 30))
    const b = queue.enqueue('s', () => d(2, 5))
    await Promise.all([a, b])
    expect(order).toEqual([1, 2])
  })

  it('不同 session 并行', async () => {
    const queue = createSessionRunQueue()
    const starts: number[] = []
    await Promise.all([
      queue.enqueue('s1', async () => { starts.push(Date.now()); await new Promise((r) => setTimeout(r, 20)) }),
      queue.enqueue('s2', async () => { starts.push(Date.now()); await new Promise((r) => setTimeout(r, 20)) }),
    ])
    expect(Math.abs(starts[0]! - starts[1]!)).toBeLessThan(10)
  })

  it('runner 抛出不破坏后续', async () => {
    const queue = createSessionRunQueue()
    const a = queue.enqueue('s', async () => { throw new Error('x') })
    const b = queue.enqueue('s', async () => 1)
    await expect(a).rejects.toThrow('x')
    await expect(b).resolves.toBeUndefined()
  })

  it('queueDepth 报告排队', async () => {
    const queue = createSessionRunQueue()
    let release: () => void = () => {}
    const blocked = new Promise<void>((r) => { release = r })
    void queue.enqueue('s', () => blocked)
    void queue.enqueue('s', async () => {})
    expect(queue.queueDepth('s')).toBe(2)
    release()
    await new Promise((r) => setTimeout(r, 10))
    expect(queue.queueDepth('s')).toBe(0)
  })
})
```

- [ ] **Step 2: 实现**

```ts
export interface SessionRunQueue {
  enqueue(sessionId: string, runner: () => Promise<void>): Promise<void>
  queueDepth(sessionId: string): number
}

export function createSessionRunQueue(): SessionRunQueue {
  const tails = new Map<string, Promise<unknown>>()
  const depths = new Map<string, number>()

  return {
    enqueue(sessionId, runner) {
      const prev = tails.get(sessionId) ?? Promise.resolve()
      depths.set(sessionId, (depths.get(sessionId) ?? 0) + 1)
      const next = prev.catch(() => {}).then(runner)
      const cleanup = next.finally(() => {
        depths.set(sessionId, (depths.get(sessionId) ?? 1) - 1)
        if (depths.get(sessionId) === 0) {
          tails.delete(sessionId)
          depths.delete(sessionId)
        }
      })
      tails.set(sessionId, cleanup)
      return next
    },
    queueDepth(sessionId) {
      return depths.get(sessionId) ?? 0
    },
  }
}
```

- [ ] **Step 3: Commit**

```bash
git add src/orchestrator/SessionRunQueue.ts src/orchestrator/SessionRunQueue.test.ts
git commit -m "阶段 5: SessionRunQueue"
```

### Chunk 2 Slack UI 可验证观测性任务：基础接线无回归

- **目标文件**：`src/orchestrator/AbortRegistry.ts`、`src/orchestrator/SessionRunQueue.ts`；手工 smoke 验收关联 `src/orchestrator/ConversationOrchestrator.ts`、`src/im/slack/SlackAdapter.ts` 当前接线路径。
- **Slack 上的操作 / 触发方式**：在一个已有 thread 中发送单条普通请求，例如 `@bot 请回复“chunk2 smoke”`，观察从收到消息到最终回复的完整链路。
- **Slack UI 中可直接看到的预期结果**：Slack 里仍能看到正常的占位更新与最终回复，不出现额外错误文案、重复消息或异常 reaction；本 chunk 先验证 queue / abort 基础能力接入没有破坏 UI 基线，`⏳` / `🛑` 的主验证放到 chunk-3。
- **人工 review gate**：chunk-2 完成后必须暂停，等待人工 review / Slack 验证通过，才能进入 chunk-3。

---

## Chunk 3: Orchestrator 集成 + Adapter abort handler

### Task 3.1: Orchestrator 接入 queue + registry

**Files:**
- Modify: `src/orchestrator/ConversationOrchestrator.ts`
- Modify: `src/orchestrator/ConversationOrchestrator.test.ts`

**改动**：
- 构造参数新增 `runQueue: SessionRunQueue` 和 `abortRegistry: AbortRegistry`
- `handle(input, sink)`：外层调 `runQueue.enqueue(sessionId, runner)`
- `runner` 内部：`abortRegistry.create(input.messageTs)` → 传 `abortSignal` 给 executor → finally 里 `registry.delete(messageTs)`
- `abort`（signal 已触发）时：持久化 `{ role: 'assistant', content: '[stopped]' }`、status=idle、sink.fail(new Error('stopped by user'))——**但实际希望 UX 显示"已停止"而不是"错误"**，所以新增 `sink.abort?()` 可选回调；或者直接 fail 但 error message 改为中文"已停止"。

> 为避免 EventSink 接口扩容，一期简化为 `sink.fail(new Error('用户已停止'))`——Renderer 的 error 分支里判断 message 做特殊 UX（M2 已有 error 分支，M3 不改 Renderer，只是错误消息中文化）。

- [ ] **Step 1: 更新测试**

新增 case：
- `handle` 通过 queue：连发两条同 session 消息，第二条必须等第一条 `done` 才开始（观察 `executor.execute` 被调用的时间戳）
- abort：handle 期间 `abortRegistry.abort(messageTs)`，observe executor 收到 signal.aborted=true

- [ ] **Step 2: 实现**

```ts
import type { SessionRunQueue } from './SessionRunQueue.ts'
import type { AbortRegistry } from './AbortRegistry.ts'
// ...既有 imports

export interface ConversationOrchestratorDeps {
  executor: AgentExecutor
  sessionStore: SessionStore
  systemPrompt: string
  logger: Logger
  runQueue: SessionRunQueue
  abortRegistry: AbortRegistry
}

export function createConversationOrchestrator(
  deps: ConversationOrchestratorDeps,
): ConversationOrchestrator {
  const log = deps.logger.withTag('orchestrator')

  return {
    async handle(input, sink) {
      const session = await deps.sessionStore.getOrCreate({
        imProvider: input.imProvider,
        channelId: input.channelId,
        channelName: input.channelName,
        threadTs: input.threadTs,
        imUserId: input.userId,
      })

      await deps.runQueue.enqueue(session.id, async () => {
        await deps.sessionStore.setStatus(session.id, 'running')
        const history = await deps.sessionStore.loadMessages(session.id)
        const userMsg = { role: 'user' as const, content: input.text }
        await deps.sessionStore.appendMessage(session.id, userMsg)

        const ctrl = deps.abortRegistry.create(input.messageTs)
        try {
          let finalText = ''
          for await (const event of deps.executor.execute({
            systemPrompt: deps.systemPrompt,
            messages: [...history, userMsg],
            abortSignal: ctrl.signal,
          })) {
            sink.emit(event)
            if (event.type === 'step_finish' && event.usage) {
              await deps.sessionStore.accumulateUsage(session.id, event.usage)
            }
            if (event.type === 'done') {
              finalText = event.finalText
              await deps.sessionStore.appendMessage(session.id, {
                role: 'assistant', content: finalText,
              })
            }
            if (event.type === 'error') throw event.error
          }
          await deps.sessionStore.setStatus(session.id, 'idle')
          await sink.done()
        } catch (err) {
          const isAbort = ctrl.signal.aborted
          const error = isAbort
            ? new Error('用户已停止')
            : err instanceof Error ? err : new Error(String(err))
          log.warn('handle terminated', { isAbort, message: error.message })
          if (isAbort) {
            await deps.sessionStore.appendMessage(session.id, {
              role: 'assistant', content: '[stopped]',
            })
          }
          await deps.sessionStore.setStatus(session.id, isAbort ? 'idle' : 'error')
          await sink.fail(error)
        } finally {
          deps.abortRegistry.delete(input.messageTs)
        }
      })
    },
  }
}
```

- [ ] **Step 3: 更新 createApplication 注入新依赖**

```ts
import { createSessionRunQueue } from '@/orchestrator/SessionRunQueue.ts'
import { createAbortRegistry } from '@/orchestrator/AbortRegistry.ts'

// 在 createApplication 内：
const runQueue = createSessionRunQueue()
const abortRegistry = createAbortRegistry()

const orchestrator = createConversationOrchestrator({
  executor, sessionStore, systemPrompt: ctx.systemPrompt, logger,
  runQueue, abortRegistry,
})
```

注意返回的 `app` 对象要暴露 `abortRegistry` 给 SlackAdapter 的 reaction handler（见 Task 3.2）。

- [ ] **Step 4: Run tests → PASS，Commit**

```bash
git add src/orchestrator/ConversationOrchestrator.ts src/orchestrator/ConversationOrchestrator.test.ts src/application/createApplication.ts
git commit -m "阶段 5: Orchestrator 集成 queue + registry"
```

### Task 3.2: SlackAdapter reaction_added + ⏳ queued

**Files:**
- Modify: `src/im/slack/SlackAdapter.ts`
- Modify: `src/im/slack/SlackAdapter.test.ts`

**改动**：
- `createSlackAdapter` 新增参数 `abortRegistry: AbortRegistry` 和 `runQueue: SessionRunQueue`
- 新 handler：`app.event('reaction_added')` → 若 `reaction === 'stop_sign'`（🛑） → `abortRegistry.abort(item.ts)`
- `app_mention` handler 内：调 `orchestrator.handle` 之前，判断 `runQueue.queueDepth(sessionId) > 0` → `reactions.add(⏳)`；实际入队后 depth 必然 ≥ 1，所以判断点应在 adapter 内部构造 sessionId 后（sessionId 构造方式要和 SessionStore 一致：`slack:${channelId}:${threadTs}`）

- [ ] **Step 1: 测试（mock bolt app）**

- reaction_added 'stop_sign' → abortRegistry.abort 被调一次（key = event.item.ts）
- reaction_added 其他 name → 无影响
- app_mention 且同 session 已有任务 → reactions.add(hourglass_flowing_sand) 被调

- [ ] **Step 2: 实现**

```ts
app.event('reaction_added', async ({ event }) => {
  if (event.reaction !== 'stop_sign') return
  if (event.item.type !== 'message') return
  deps.logger.info(`🛑 收到 abort: ${event.item.ts}`)
  deps.abortRegistry.abort(event.item.ts, 'user_stop_reaction')
})

// 在 app_mention handler 里，构造 sessionId 后：
const sessionId = `slack:${channelId}:${threadTs}`
if (deps.runQueue.queueDepth(sessionId) > 0) {
  await swallow(client.reactions.add({
    channel: channelId, timestamp: messageTs, name: 'hourglass_flowing_sand',
  }), log)
}
```

> Slack app manifest 需新增 event subscription：`reaction_added`；scope：`reactions:read`。写入本 task Step 3 的手动验收清单。

- [ ] **Step 3: Run tests → PASS，Commit**

```bash
git add src/im/slack/SlackAdapter.ts src/im/slack/SlackAdapter.test.ts
git commit -m "阶段 5: reaction_added abort + queued ⏳"
```

### Chunk 3 Slack UI 可验证观测性任务：排队与 🛑 中断

- **目标文件**：`src/orchestrator/ConversationOrchestrator.ts`、`src/application/createApplication.ts`、`src/im/slack/SlackAdapter.ts`。
- **Slack 上的操作 / 触发方式**：同一 thread 快速连续发送两条请求（例如 `@bot A`、`@bot B`）；当第一条或第二条正在流式输出时，在 bot 占位消息上添加 `🛑` reaction。
- **Slack UI 中可直接看到的预期结果**：后进入队列的请求在原消息上出现 `⏳`；当前执行中的回复会在加 `🛑` 后停止流式输出，并落到 `⚠️ 用户已停止`（或计划约定的等价终态文案）；同一 thread 中不会出现两条回复同时流式竞争。`messages.jsonl`、`meta.json`、debug 事件只可作为补充排查。
- **人工 review gate**：chunk-3 完成后必须暂停，等待人工 review / Slack 验证通过，才能进入 chunk-4。

---

## Chunk 4: Tool 持久化 + graceful shutdown

### Task 4.1: SessionStore 支持 tool-call / tool-result 持久化

**Files:**
- Modify: `src/store/SessionStore.ts`
- Modify: `src/store/SessionStore.test.ts`
- Modify: `src/orchestrator/ConversationOrchestrator.ts`

**背景**：M1 只存 `{ role: 'user' }` + `{ role: 'assistant', content: finalText }`，丢失了中间的 tool-call 和 tool-result。这会导致下一轮 load 时 AI SDK 把历史当成纯文本对话——某些模型会困惑于"上文提到的 bash 结果"。

**改动**：
- `appendMessage` 类型放宽为 `CoreMessage`（原本就是，确认 AI SDK v4 的 `CoreMessage` 包含 `{ role: 'assistant', content: [...toolCalls] }` 和 `{ role: 'tool', content: [...toolResults] }`）
- Orchestrator 在迭代 stream 时**收集**所有 `tool_call_start` / `tool_call_end`，在 `done` 时根据 AI SDK 的 **result.response.messages** 直接写入（而不是手工拼装）——AI SDK 原生提供完整 `ModelMessage[]`

**更简洁的做法**：在 `AiSdkExecutor` 的 `done` 事件里附带 `responseMessages: ModelMessage[]`，Orchestrator 在 done 时替代手工 append。

- [ ] **Step 1: 扩展 `done` event 类型**

`src/core/events.ts`：

```ts
  | {
      type: 'done'
      finalText: string
      totalUsage: TotalUsage
      responseMessages: CoreMessage[]    // ← 新增：本轮 executor 生成的所有消息
    }
```

- [ ] **Step 2: AiSdkExecutor 填充 responseMessages**

```ts
// 在迭代完 fullStream 后、yield done 之前：
const response = await result.response
const responseMessages = (response.messages ?? []) as CoreMessage[]
yield { type: 'done', finalText, totalUsage: total, responseMessages }
```

- [ ] **Step 3: Orchestrator 替换 append 逻辑**

删掉 M1 里 `appendMessage({ role: 'assistant', content: finalText })`，改为：

```ts
if (event.type === 'done') {
  finalText = event.finalText
  for (const msg of event.responseMessages) {
    await deps.sessionStore.appendMessage(session.id, msg)
  }
}
```

- [ ] **Step 4: 更新 SessionStore 测试**

新增 case：append 一条 assistant-with-toolCalls + 一条 tool-result，loadMessages 返回原样。

- [ ] **Step 5: 更新 Orchestrator 测试**

Mock executor 的 done 带 `responseMessages: [assistantMsg, toolResultMsg]`，验证 jsonl 多了 2 行而非 1 行。

- [ ] **Step 6: Run tests → PASS，Commit**

```bash
git add src/core/events.ts src/agent/AiSdkExecutor.ts src/orchestrator/ConversationOrchestrator.ts src/store/SessionStore.test.ts src/orchestrator/ConversationOrchestrator.test.ts
git commit -m "阶段 5: tool-call / tool-result 持久化"
```

### Task 4.2: Graceful shutdown

**Files:**
- Modify: `src/application/createApplication.ts`
- Modify: `src/application/types.ts`
- Modify: `src/index.ts`

**语义**（spec §6.3）：SIGINT/SIGTERM → 停 adapter 接新事件 → drain queue 最多 30s → abortAll → flush logger → exit(0)。

- [ ] **Step 1: Application 接口加 shutdown 能力**

```ts
export interface Application {
  start(): Promise<void>
  stop(): Promise<void>
  adapters: IMAdapter[]
  abortRegistry: AbortRegistry
  runQueue: SessionRunQueue
}
```

- [ ] **Step 2: createApplication 返回这些**

- [ ] **Step 3: src/index.ts shutdown 逻辑**

```ts
const shutdown = async (signal: string): Promise<void> => {
  consola.info(`收到 ${signal}，正在关闭…`)
  await app.stop()  // 停 adapter
  // drain 最多 30s
  const start = Date.now()
  while (anyQueueBusy(app.runQueue) && Date.now() - start < 30_000) {
    await new Promise((r) => setTimeout(r, 500))
  }
  app.abortRegistry.abortAll('shutdown')
  process.exit(0)
}

function anyQueueBusy(_q: unknown): boolean {
  // 简化：一期无法枚举所有 session key，直接返回 false；M4 可扩展 runQueue 接口
  return false
}
```

> `SessionRunQueue` 一期不暴露"是否有任务正在运行"的聚合能力；第一版 drain 直接退化为等一次 500ms，足够让正在进行的 chat.update 完成。后续若需要真正 drain 再扩接口。

- [ ] **Step 4: Commit**

```bash
git add src/application src/index.ts
git commit -m "阶段 5: graceful shutdown"
```

### Chunk 4 Slack UI 可验证观测性任务：tool 延续性与重启后线程恢复

- **目标文件**：`src/store/SessionStore.ts`、`src/orchestrator/ConversationOrchestrator.ts`、`src/application/createApplication.ts`、`src/index.ts`。
- **Slack 上的操作 / 触发方式**：先在同一 thread 发送 `@bot 用 bash 跑 \`ls -la\`，然后总结`，待回复完成后继续发送 `@bot 上一步你看到了多少文件？`；另选一条较长回复，在流式输出期间由操作者触发服务 graceful shutdown / restart，再回到同一 thread 继续发送新消息。
- **Slack UI 中可直接看到的预期结果**：第二条消息的最终文案能够直接引用上一轮 tool 输出；服务重启前后的 Slack 线程不会留下重复终态或长期悬挂的异常占位消息，重启后同一 thread 仍可继续正常对话。若需排查，可补充参考 `messages.jsonl` 或 shutdown 日志，但它们不是本观测性任务的主标准。
- **人工 review gate**：chunk-4 完成后必须暂停，等待人工 review / Slack 验证通过，才能进入 chunk-5 / 最终验收。

---

## Chunk 5: 真 Slack 验收

### Task 5.1: Skills 验收

- [ ] **Step 1: 创建一个 skill**

`<cwd>/.agent-slack/skills/tone/SKILL.md`:

```markdown
---
name: tone
description: 回复语气要求
whenToUse: always
---

回复时使用正式书面中文，避免口语化词汇。
```

- [ ] **Step 2: 重启 `pnpm dev`，`@bot 你好吗`**

Expected：回复用正式书面语。若需补充排查，可再参考 `logs/...` 中是否包含 "Available Skills"，但这不是 Slack UI 主验收标准。

### Task 5.2: 并发排队验收

- [ ] **Step 1: 同 thread 连发 3 条**

`@bot A`、`@bot B`、`@bot C`（间隔 < 500ms）

Expected：
- A 立即处理
- B、C 原消息出现 ⏳ reaction
- 在 Slack thread 中可直接观察到 A 完成后才轮到 B、再轮到 C；如需补充排查，可再参考 jsonl 顺序，但不是主验收标准
- 最终三条都有 ✅

### Task 5.3: 🛑 abort 验收

- [ ] **Step 1: `@bot 写一篇 500 字关于 TypeScript 的文章`**

- [ ] **Step 2: 在 bot 占位消息上加 🛑 reaction**

Expected：
- 流式输出停止
- 占位消息变 `⚠️ 用户已停止`，原消息 ❌
- 如需补充排查，可再核对 `meta.json.status = 'idle'` 与 jsonl 追加 `[stopped]`，但这些都不是 Slack UI 主验收标准

### Task 5.4: 多轮 tool-call 延续性验收

- [ ] **Step 1: `@bot 用 bash 跑 \`ls -la\`，然后总结`**（等完成）

- [ ] **Step 2: 同 thread `@bot 上一步你看到了多少文件？`**

Expected：模型能准确引用上一轮 tool 结果（证明 tool-call/tool-result 被正确持久化并重新加载）。

- [ ] **Step 3: Commit M3 完成**

```bash
git commit --allow-empty -m "M3 完成: skills + queue + abort + tool 持久化 验收通过"
```

---

## M3 完成检查清单

- [ ] `pnpm lint && pnpm test && pnpm typecheck` 全绿
- [ ] Skills 自动加载到 system prompt
- [ ] 同 session 消息严格串行（FIFO）
- [ ] 排队期间显示 ⏳
- [ ] 🛑 reaction 能中断执行，消息变"已停止"
- [ ] Slack 多轮对话中能准确引用上一轮 tool 输出（tool 持久化主验收）
- [ ] 如需补充排查，可核对 jsonl 中的 tool-call + tool-result 持久化
- [ ] SIGINT 优雅退出，不残留僵尸 promise

**下一步**：M4 plan — CLI（commander）+ Onboard 向导（@clack/prompts）+ tsdown 打包 + `agent-slack` bin 分发到其他目录。
