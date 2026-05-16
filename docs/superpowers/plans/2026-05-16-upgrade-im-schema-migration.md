# agent-slack upgrade 命令 schema 迁移实现 Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 `agent-slack upgrade` 命令能持久化迁移 v0.1.8→v0.1.9 引入的 `im.provider` → `im.enabled` 字段改名，同时检测 scheduled-tasks 与 config.im.enabled 跨文件不一致，并把嵌套字段的缺失警告升级为可直接复制的 generator 片段。

**Architecture:** 在 `src/workspace/upgrade.ts` 的 `planUpgradeYaml` 之前增加一个 "rename migrations" 预处理阶段，用 yaml AST（`yaml` 包的 Document API）就地改写已知旧字段；在 `src/cli/commands/upgrade.ts` 增加一段跨文件校验，扫 scheduled-tasks.yaml 的 `target.im` 对照 config.im.enabled 输出 mismatch 警告；最后把 `missingNested` 警告升级为附带 generator 中对应子节点 yaml 片段。运行时的 `migrateLegacyImProvider()` 保留不动，作为旧 yaml 在用户没跑 upgrade 时的兜底。

**Tech Stack:** TypeScript / vitest / [yaml](https://eemeli.org/yaml/) 包（Document AST API，已是项目依赖）/ consola。

---

## 背景

### 当前问题（用户实测）

用户 v0.1.8 时代写的 [.agent-slack/config.yaml](../../../.agent-slack/config.yaml) 里仍是 `im.provider: slack`。v0.1.9 把字段改名为 `im.enabled: ['slack']`，运行时由 [`migrateLegacyImProvider()`](../../../src/workspace/WorkspaceContext.ts#L32) in-memory 兜底，但磁盘上一直是旧字段。用户跟着 commit `417452c` 把 scheduled-tasks 改到 telegram 后，daemon 启动报 `定时任务 "repo-pull-daily" 的目标 IM "telegram" 未在 config.im.enabled 中启用` 退出。`agent-slack upgrade` 跑完没任何迁移动作。

### 范围（P0 + P1）

**P0**（必做，破坏性变更）：

1. `im.provider: <s>` → `im.enabled: [<s>]` 持久化迁移（写盘删除旧字段）。
2. scheduled-tasks.yaml 跨文件校验：扫所有 `enabled:true` 任务的 `target.im`，对照 config.im.enabled，列出 mismatch，输出修复建议（不自动改 enabled，避免擅动用户语义）。

**P1**（举一反三，新嵌套字段提示）：

3. `planUpgradeYaml` 的 `missingNested` 不再只列字段路径，附带 generator 中对应子节点的 yaml 片段（含中文注释），用户能直接复制粘贴。

### 不做（YAGNI）

- 自动写嵌套字段到用户 yaml（AST 嵌套追加有副作用：注释位置、空行、字段顺序难保持，风险大于收益）。
- 把跨文件 mismatch 自动改进 enabled（语义性改动，必须用户确认）。
- 通用 schema versioning / migration 链（先把当前两个具体迁移做掉；如果后续 release 又有 rename，再抽象 P2）。

---

## 文件影响

**修改：**

- `src/workspace/upgrade.ts` — 新增 `applyRenameMigrations()` + `extractNestedSnippet()`，扩展 `UpgradeYamlPlan` 接口。
- `src/cli/commands/upgrade.ts` — 主流程接入 rename 报告、嵌套 snippet 输出、跨文件 IM 校验。

**新增：**

- `tests/upgrade.test.ts` — vitest 用例（rename 迁移 + 跨文件校验 + 嵌套 snippet 三组）。

**不动：**

- `src/workspace/WorkspaceContext.ts:32-43` `migrateLegacyImProvider()` — 保留作为没跑 upgrade 的用户的运行时兜底。
- `src/workspace/config.ts` — schema 已经是新形态，不需要动。
- `src/scheduledTasks/config.ts` — schema 已支持 telegram，不需要动。

---

## Chunk 1: P0-1 字段 rename 迁移

### Task 1: 在 upgrade.ts 中扩展 `UpgradeYamlPlan` 接口和增加 `RENAME_MIGRATIONS` 常量

**Files:**

- Modify: `src/workspace/upgrade.ts:14-23`（接口）和文件顶部（常量）

- [ ] **Step 1: 修改 `UpgradeYamlPlan` 接口**

在 `src/workspace/upgrade.ts:14-23` 把接口扩展为：

```typescript
export interface UpgradeYamlPlan {
  missingTopLevel: string[]
  missingNested: string[]
  // 每个嵌套缺失附带的 generator 片段；key=点分路径，value=可直接粘贴的 yaml 片段（含上方紧贴的注释）。Chunk 3 才填充。
  nestedSnippets: Record<string, string>
  plannedAppend: string
  // 已应用的字段改名（from → to）。每项含改名前后 path 和说明，便于上层输出"已迁移"日志。
  appliedRenames: RenameRecord[]
  upgraded: string
}

export interface RenameRecord {
  from: string
  to: string
  reason: string
}
```

- [ ] **Step 2: 在文件顶部新增常量和迁移函数声明**

紧跟 `import` 块之后（约 `src/workspace/upgrade.ts:13`）插入：

```typescript
// 已知的 yaml 字段 rename 迁移清单（写盘改写）。
// 每项描述："旧路径在 → 新路径不在" 的条件下，把 oldPath 重命名为 newPath，
// 值若为 scalar 且 newPath 是 array，则包成单元素数组。
// 新增 rename 时在这里追加，不要散布在多个 if-else。
export interface RenameMigration {
  oldPath: string[]
  newPath: string[]
  /** 把 scalar 值包成数组（用于 provider: 'slack' → enabled: ['slack'] 这种 single → array 改名）。 */
  scalarToArray?: boolean
  reason: string
}

export const RENAME_MIGRATIONS: RenameMigration[] = [
  {
    oldPath: ['im', 'provider'],
    newPath: ['im', 'enabled'],
    scalarToArray: true,
    reason: 'v0.1.9: im.provider (single) → im.enabled (array)',
  },
]
```

- [ ] **Step 3: 跑 tsc / build 确认没有编译错误**

Run: `cd /Users/moego-winches/Desktop/Company/AI-Agent/agent-slack && pnpm tsc --noEmit`
Expected: 0 errors（接口被引用方还没改，会有 missing property `nestedSnippets/appliedRenames` 的错——预期，下面 Step 4 修）。

- [ ] **Step 4: 修复 `planUpgradeYaml` 返回值**

在 `src/workspace/upgrade.ts:111-118` 和 `:128-135` 两处 return 语句，给返回对象补上：

```typescript
nestedSnippets: {},
appliedRenames: [],
```

- [ ] **Step 5: 跑 tsc 确认编译通过**

Run: `cd /Users/moego-winches/Desktop/Company/AI-Agent/agent-slack && pnpm tsc --noEmit`
Expected: 0 errors。

- [ ] **Step 6: Commit**

```bash
cd /Users/moego-winches/Desktop/Company/AI-Agent/agent-slack
git add src/workspace/upgrade.ts
git commit -m "feat(upgrade): 扩展 UpgradeYamlPlan 接口，引入 RENAME_MIGRATIONS 骨架"
```

---

### Task 2: 写失败测试 — `im.provider: slack` 应被改写为 `im.enabled: ['slack']`

**Files:**

- Create: `tests/upgrade.test.ts`

- [ ] **Step 1: 创建测试文件**

写入下面内容到 `tests/upgrade.test.ts`：

```typescript
import { describe, expect, it } from 'vitest'
import YAML from 'yaml'
import { planUpgradeYaml } from '@/workspace/upgrade.ts'
import { generateConfigYaml } from '@/workspace/templates/index.ts'

const template = generateConfigYaml({ mode: 'workspace' })

describe('planUpgradeYaml — rename migrations', () => {
  it('把旧 im.provider: slack 改写为 im.enabled: [slack]，并记录到 appliedRenames', () => {
    const userYaml = `
agent:
  name: default
  model: gpt-5.5
im:
  provider: slack
  slack:
    resolveChannelName: true
`.trimStart()

    const plan = planUpgradeYaml(userYaml, template)

    expect(plan.appliedRenames).toHaveLength(1)
    expect(plan.appliedRenames[0]).toMatchObject({
      from: 'im.provider',
      to: 'im.enabled',
    })

    const upgradedObj = YAML.parse(plan.upgraded) as Record<string, any>
    expect(upgradedObj.im.enabled).toEqual(['slack'])
    expect(upgradedObj.im.provider).toBeUndefined()
  })

  it('若 im.enabled 已存在则不动 provider（避免覆盖用户已迁移的配置）', () => {
    const userYaml = `
im:
  provider: slack
  enabled: ['slack', 'wechat']
`.trimStart()

    const plan = planUpgradeYaml(userYaml, template)

    // enabled 已存在 → 不触发改名；provider 字段保留（运行时 migrateLegacyImProvider 也是这个语义）
    expect(plan.appliedRenames).toHaveLength(0)
    const upgradedObj = YAML.parse(plan.upgraded) as Record<string, any>
    expect(upgradedObj.im.enabled).toEqual(['slack', 'wechat'])
    expect(upgradedObj.im.provider).toBe('slack')
  })

  it('完全没有 im.provider 时不影响其它字段', () => {
    const userYaml = `
agent:
  name: default
im:
  enabled: ['slack']
`.trimStart()

    const plan = planUpgradeYaml(userYaml, template)
    expect(plan.appliedRenames).toHaveLength(0)
  })
})
```

- [ ] **Step 2: 跑测试验证失败**

Run: `cd /Users/moego-winches/Desktop/Company/AI-Agent/agent-slack && pnpm vitest run tests/upgrade.test.ts`
Expected: 第 1、2 个 test 失败（`appliedRenames` 是空数组，`upgraded` 还保留 `provider`）；第 3 个 test 通过。

---

### Task 3: 实现 rename 迁移逻辑（用 yaml Document AST）

**Files:**

- Modify: `src/workspace/upgrade.ts`

- [ ] **Step 1: 新增 `applyRenameMigrations` 函数**

在 `src/workspace/upgrade.ts` 中 `extractTopLevelBlock` 函数之前（约第 30 行）插入：

```typescript
import { Document, Scalar, YAMLMap, YAMLSeq, isMap, isScalar, parseDocument } from 'yaml'

// 用 Document AST 就地改写 yaml 文本，保留注释和原始格式。
// 返回：改写后的 yaml 字符串 + 已应用的 rename 列表。
// 设计：只处理 oldPath 存在且 newPath 不存在的情况；newPath 已存在视为用户已手动迁移，跳过。
function applyRenameMigrations(
  userYaml: string,
  migrations: RenameMigration[],
): { yaml: string; applied: RenameRecord[] } {
  const doc: Document.Parsed = parseDocument(userYaml)
  const applied: RenameRecord[] = []
  // 解析失败（doc.errors 非空）时直接跳过迁移；planUpgradeYaml 后续会按"整体缺失"处理。
  if (doc.errors.length > 0) {
    return { yaml: userYaml, applied: [] }
  }

  for (const mig of migrations) {
    const oldNode = doc.getIn(mig.oldPath, true)
    if (oldNode === undefined) continue
    const newNode = doc.getIn(mig.newPath, true)
    if (newNode !== undefined) continue

    // 取 scalar 值
    let value: unknown
    if (isScalar(oldNode)) {
      value = oldNode.value
    } else {
      // 非 scalar 暂不支持，跳过
      continue
    }

    // 包成数组
    if (mig.scalarToArray) {
      const seq = new YAMLSeq()
      seq.add(value)
      doc.setIn(mig.newPath, seq)
    } else {
      doc.setIn(mig.newPath, value)
    }

    doc.deleteIn(mig.oldPath)
    applied.push({
      from: mig.oldPath.join('.'),
      to: mig.newPath.join('.'),
      reason: mig.reason,
    })
  }

  if (applied.length === 0) {
    return { yaml: userYaml, applied: [] }
  }

  return { yaml: String(doc), applied }
}
```

注：`isMap` / `Scalar` / `YAMLMap` 实际本步未必都用到，但保留 import 给后续 Task 用；如果 eslint 报 unused，删未用的。

- [ ] **Step 2: 在 `planUpgradeYaml` 开头调用 rename 迁移**

修改 `src/workspace/upgrade.ts:98-148` 的 `planUpgradeYaml` 函数。

把函数签名下原本的 `let userObj` 起始段：

```typescript
export function planUpgradeYaml(userYaml: string, templateYaml: string): UpgradeYamlPlan {
  let userObj: unknown = {}
  try {
    userObj = YAML.parse(userYaml) ?? {}
```

改成：

```typescript
export function planUpgradeYaml(userYaml: string, templateYaml: string): UpgradeYamlPlan {
  // Phase 0: rename migrations（用 yaml Document AST 改写源文本，保留注释/格式）
  // 之后所有阶段都用 effectiveYaml，否则刚迁移完的字段会再被当作"缺失"重新追加。
  const { yaml: effectiveYaml, applied: appliedRenames } = applyRenameMigrations(
    userYaml,
    RENAME_MIGRATIONS,
  )

  let userObj: unknown = {}
  try {
    userObj = YAML.parse(effectiveYaml) ?? {}
```

然后把函数体里**所有** `userYaml` 引用换成 `effectiveYaml`（包括 `userTrim` 构造和三处 return 里的 `upgraded` 字段）。建议用 IDE 的 "rename symbol" 或在函数体内全文替换，确保不遗漏。

- [ ] **Step 3: 在所有 return 语句中带上 `appliedRenames`**

把函数内三处 return 都改成包含 `appliedRenames`：

第一处（约 `:111-117`，无缺失分支）：
```typescript
return {
  missingTopLevel: [],
  missingNested: [],
  nestedSnippets: {},
  plannedAppend: '',
  appliedRenames,
  upgraded: userYaml,  // 注意：这里是 renamedYaml
}
```

第二处（约 `:128-134`，extractTopLevelBlock 未抽出块时）：
```typescript
return {
  missingTopLevel: out.topLevel,
  missingNested: out.nested,
  nestedSnippets: {},
  plannedAppend: '',
  appliedRenames,
  upgraded: userYaml,
}
```

第三处（约 `:142-147`，正常追加分支）：
```typescript
return {
  missingTopLevel: out.topLevel,
  missingNested: out.nested,
  nestedSnippets: {},
  plannedAppend: appendText,
  appliedRenames,
  upgraded: `${userTrim}${appendText}`,
}
```

- [ ] **Step 4: 跑测试验证通过**

Run: `cd /Users/moego-winches/Desktop/Company/AI-Agent/agent-slack && pnpm vitest run tests/upgrade.test.ts`
Expected: 3 个 test 全过。

- [ ] **Step 5: 跑全量测试验证没坏其它**

Run: `cd /Users/moego-winches/Desktop/Company/AI-Agent/agent-slack && pnpm test`
Expected: 全部通过（注意 `tests/examples.test.ts` 用的是 examples 目录的模板，应该不受影响；如有断言失败，重新评估）。

- [ ] **Step 6: Commit**

```bash
cd /Users/moego-winches/Desktop/Company/AI-Agent/agent-slack
git add src/workspace/upgrade.ts tests/upgrade.test.ts
git commit -m "feat(upgrade): im.provider → im.enabled 持久化字段改名迁移"
```

---

### Task 4: 在 upgrade 命令中输出 rename 报告

**Files:**

- Modify: `src/cli/commands/upgrade.ts:76-89`

- [ ] **Step 1: 在 `for (const target of targets)` 循环里增加 rename 输出**

修改 `src/cli/commands/upgrade.ts:69-89`，在 `reportPlan(target.label, plan)` 调用之前（也就是 `:75` 之前）插入：

```typescript
    // 优先输出 rename 报告（改写已落盘后才显示）
    if (plan.appliedRenames.length > 0) {
      for (const r of plan.appliedRenames) {
        consola.info(`${target.label}: ${r.from} → ${r.to}（${r.reason}）`)
      }
    }
```

同时，由于 rename 也会改 `plan.upgraded`，原本只在 `plan.plannedAppend` 非空时写文件的逻辑要扩展为：

修改 `src/cli/commands/upgrade.ts:82-88`（原 `if (plan.plannedAppend)` 块）为：

```typescript
    const hasChanges = plan.plannedAppend.length > 0 || plan.appliedRenames.length > 0
    if (hasChanges) {
      const backupPath = `${target.filePath}.bak.${backupSuffix()}`
      await copyFile(target.filePath, backupPath)
      await writeFile(target.filePath, plan.upgraded, 'utf8')
      const parts: string[] = []
      if (plan.appliedRenames.length > 0) parts.push(`迁移 ${plan.appliedRenames.length} 个字段改名`)
      if (plan.plannedAppend) parts.push('追加缺失顶层字段')
      consola.success(`${target.label}: 已备份 ${path.basename(backupPath)} 并 ${parts.join('、')}`)
      touched += 1
    }
```

- [ ] **Step 2: 手测 dry-run 输出**

准备一个临时 workspace：

```bash
mkdir -p /tmp/asl-upgrade-test/.agent-slack
cat > /tmp/asl-upgrade-test/.agent-slack/config.yaml <<'EOF'
agent:
  name: default
  model: gpt-5.5
im:
  provider: slack
  slack:
    resolveChannelName: true
EOF
```

Run（在 agent-slack 仓库执行 dev cli）:
```bash
cd /Users/moego-winches/Desktop/Company/AI-Agent/agent-slack
pnpm cli upgrade --cwd /tmp/asl-upgrade-test --dry-run
```

Expected: stdout 出现 `config.yaml: im.provider → im.enabled（v0.1.9: im.provider (single) → im.enabled (array)）`。`--dry-run` 模式下文件不变。

- [ ] **Step 3: 手测正式执行写盘**

Run: `pnpm cli upgrade --cwd /tmp/asl-upgrade-test`
Expected: stdout 出现 `已备份 config.yaml.bak.<时间戳> 并 迁移 1 个字段改名`。

验证文件内容：

```bash
cat /tmp/asl-upgrade-test/.agent-slack/config.yaml
```

Expected: `im.provider` 消失，`im.enabled: [slack]` 或 `im.enabled:\n  - slack` 出现（具体格式取决于 yaml lib 默认 flow style；两种都合法）。注释保留。

- [ ] **Step 4: Commit**

```bash
cd /Users/moego-winches/Desktop/Company/AI-Agent/agent-slack
git add src/cli/commands/upgrade.ts
git commit -m "feat(upgrade): 在命令输出中报告字段改名迁移并落盘"
```

---

## Chunk 2: P0-2 scheduled-tasks 跨文件 IM 校验

### Task 5: 写失败测试 — scheduled-tasks 用了未启用的 IM 时输出 warning

**Files:**

- Modify: `tests/upgrade.test.ts`

- [ ] **Step 1: 在 `tests/upgrade.test.ts` 文件末尾追加新 describe 块**

```typescript
import { collectImMismatch } from '@/workspace/upgrade.ts'

describe('collectImMismatch — scheduled-tasks 跨文件校验', () => {
  const baseScheduled = `
version: 1
enabled: true
tasks:
  - id: aihot-daily
    enabled: true
    cron: '0 8 * * *'
    prompt: 'foo'
    target:
      im: telegram
      to: '123'
  - id: slack-only
    enabled: true
    cron: '0 9 * * *'
    prompt: 'bar'
    target:
      im: slack
      channelId: C12345
  - id: disabled-task
    enabled: false
    cron: '0 10 * * *'
    prompt: 'baz'
    target:
      im: wechat
      to: 'someid'
`.trimStart()

  it('当 config.im.enabled=[slack] 时报告 telegram 未启用', () => {
    const mismatches = collectImMismatch(baseScheduled, ['slack'])
    expect(mismatches).toEqual([
      { taskId: 'aihot-daily', targetIm: 'telegram', enabledIms: ['slack'] },
    ])
  })

  it('忽略 enabled:false 的任务（不应报告）', () => {
    const mismatches = collectImMismatch(baseScheduled, ['slack', 'telegram'])
    // wechat 任务是 enabled:false，跳过；telegram 已在 enabled 列表里；剩 slack 任务匹配
    expect(mismatches).toEqual([])
  })

  it('scheduled-tasks.yaml 为空或顶层 enabled:false 时返回空数组', () => {
    expect(collectImMismatch('version: 1\nenabled: false\ntasks: []', ['slack'])).toEqual([])
  })

  it('scheduled-tasks.yaml 内容解析失败时返回空数组（不抛错）', () => {
    expect(collectImMismatch('not: yaml: at: all:', ['slack'])).toEqual([])
  })
})
```

- [ ] **Step 2: 跑测试验证失败**

Run: `cd /Users/moego-winches/Desktop/Company/AI-Agent/agent-slack && pnpm vitest run tests/upgrade.test.ts`
Expected: 4 个新 test 全部失败（`collectImMismatch is not exported`）。

---

### Task 6: 实现 `collectImMismatch`

**Files:**

- Modify: `src/workspace/upgrade.ts`

- [ ] **Step 1: 在 `src/workspace/upgrade.ts` 末尾追加函数**

```typescript
export interface ImMismatch {
  taskId: string
  targetIm: string
  enabledIms: string[]
}

/**
 * 扫 scheduled-tasks.yaml 中所有 enabled:true 任务的 target.im，
 * 列出不在 config.im.enabled 集合里的（mismatch）。
 *
 * 设计：故意不重用 ScheduledTasksConfigSchema.parse —— upgrade 阶段的 yaml 可能因为
 * 历史 schema / 未补字段而 zod parse 不过，但我们仍希望尽量给出 IM 校验提示。
 * 用 YAML.parse 拿松散对象，按字段名访问；类型不对就跳过这一项（不抛错）。
 */
export function collectImMismatch(scheduledYaml: string, enabledIms: string[]): ImMismatch[] {
  let parsed: unknown
  try {
    parsed = YAML.parse(scheduledYaml)
  } catch {
    return []
  }
  if (!isPlainObject(parsed)) return []
  if (parsed.enabled === false) return []
  const tasks = parsed.tasks
  if (!Array.isArray(tasks)) return []

  const enabledSet = new Set(enabledIms)
  const out: ImMismatch[] = []
  for (const task of tasks) {
    if (!isPlainObject(task)) continue
    if (task.enabled === false) continue
    const target = task.target
    if (!isPlainObject(target)) continue
    const taskId = typeof task.id === 'string' ? task.id : '(no-id)'
    const targetIm = target.im
    if (typeof targetIm !== 'string') continue
    if (enabledSet.has(targetIm)) continue
    out.push({ taskId, targetIm, enabledIms: [...enabledIms] })
  }
  return out
}
```

- [ ] **Step 2: 跑测试验证通过**

Run: `cd /Users/moego-winches/Desktop/Company/AI-Agent/agent-slack && pnpm vitest run tests/upgrade.test.ts`
Expected: 7 个 test 全部通过（3 个 rename + 4 个 mismatch）。

- [ ] **Step 3: Commit**

```bash
cd /Users/moego-winches/Desktop/Company/AI-Agent/agent-slack
git add src/workspace/upgrade.ts tests/upgrade.test.ts
git commit -m "feat(upgrade): collectImMismatch — 扫 scheduled-tasks 与 config.im.enabled 不一致"
```

---

### Task 7: 在 upgrade 命令中接入 IM 跨文件校验

**Files:**

- Modify: `src/cli/commands/upgrade.ts`

- [ ] **Step 1: 在 upgrade.ts import 处加入 collectImMismatch 和 parse helper**

修改 `src/cli/commands/upgrade.ts:22` 把 `planUpgradeYaml` 那一行的 import 改成：

```typescript
import {
  backupSuffix,
  collectImMismatch,
  planUpgradeYaml,
  type UpgradeYamlPlan,
} from '@/workspace/upgrade.ts'
```

并在文件顶部 import 中加入 `YAML`：

```typescript
import YAML from 'yaml'
```

- [ ] **Step 2: 在 `upgradeCommand` 主循环结束之后增加跨文件校验段**

在 `src/cli/commands/upgrade.ts` 的 `system.md` 处理块**之前**（约 `:91` 之前）插入：

```typescript
  // 跨文件校验：scheduled-tasks.target.im ⊆ config.im.enabled
  if (existsSync(paths.configFile) && existsSync(paths.scheduledTasksFile)) {
    const configYaml = await readFile(paths.configFile, 'utf8')
    const scheduledYaml = await readFile(paths.scheduledTasksFile, 'utf8')
    const configParsed = (YAML.parse(configYaml) ?? {}) as Record<string, unknown>
    const imObj = configParsed.im as Record<string, unknown> | undefined
    // 兼容刚被 Chunk1 改写的 enabled 数组，以及历史 provider 单值（理论上 Chunk1 已迁移；这里防御）
    const enabledIms = Array.isArray(imObj?.enabled)
      ? (imObj.enabled as string[])
      : typeof imObj?.provider === 'string'
        ? [imObj.provider as string]
        : ['slack']
    const mismatches = collectImMismatch(scheduledYaml, enabledIms)
    if (mismatches.length > 0) {
      for (const m of mismatches) {
        consola.warn(
          `scheduled-tasks "${m.taskId}" 的 target.im="${m.targetIm}" 不在 config.im.enabled=[${m.enabledIms.join(', ')}] 中`,
        )
      }
      consola.info(
        `修复办法：在 config.yaml 的 im.enabled 数组里加入缺失的 IM（${[
          ...new Set(mismatches.map((m) => m.targetIm)),
        ].join(', ')}），或把对应任务的 enabled 改为 false。upgrade 不会自动修改 enabled 列表（避免擅自启用 IM 适配器）。`,
      )
    }
  }
```

- [ ] **Step 3: 手测 dry-run**

复用 `/tmp/asl-upgrade-test`，追加 scheduled-tasks.yaml：

```bash
cat > /tmp/asl-upgrade-test/.agent-slack/scheduled-tasks.yaml <<'EOF'
version: 1
enabled: true
tasks:
  - id: tg-task
    enabled: true
    cron: '0 8 * * *'
    prompt: 'test'
    target:
      im: telegram
      to: '12345'
EOF
```

Run: `cd /Users/moego-winches/Desktop/Company/AI-Agent/agent-slack && pnpm cli upgrade --cwd /tmp/asl-upgrade-test --dry-run`

Expected stdout 包含：
- `scheduled-tasks "tg-task" 的 target.im="telegram" 不在 config.im.enabled=[slack] 中`
- `修复办法：在 config.yaml 的 im.enabled 数组里加入缺失的 IM（telegram）...`

- [ ] **Step 4: Commit**

```bash
cd /Users/moego-winches/Desktop/Company/AI-Agent/agent-slack
git add src/cli/commands/upgrade.ts
git commit -m "feat(upgrade): scheduled-tasks 跨 config.im.enabled mismatch 校验"
```

---

## Chunk 3: P1 嵌套缺失 snippet 提示

### Task 8: 写失败测试 — `nestedSnippets` 应该包含 generator 中对应字段的代码片段

**Files:**

- Modify: `tests/upgrade.test.ts`

- [ ] **Step 1: 在 `tests/upgrade.test.ts` 末尾追加 describe**

```typescript
describe('planUpgradeYaml — nestedSnippets', () => {
  it('agent.responses 嵌套缺失时返回 generator 片段供用户复制', () => {
    const userYaml = `
agent:
  name: default
  model: gpt-5.5
  maxSteps: 50
  provider: openai-responses
  context:
    maxApproxChars: 900000
im:
  enabled: ['slack']
`.trimStart()

    const plan = planUpgradeYaml(userYaml, template)

    expect(plan.missingNested).toEqual(
      expect.arrayContaining(['agent.responses']),
    )
    expect(plan.nestedSnippets['agent.responses']).toMatch(/reasoningEffort/)
    expect(plan.nestedSnippets['agent.responses']).toMatch(/reasoningSummary/)
    // 片段应包含 generator 里的中文注释（这是 P1 的核心价值）
    expect(plan.nestedSnippets['agent.responses']).toMatch(/OpenAI 推理预算档位/)
  })

  it('没有嵌套缺失时 nestedSnippets 为空对象', () => {
    const userYaml = template
    const plan = planUpgradeYaml(userYaml, template)
    expect(plan.nestedSnippets).toEqual({})
  })
})
```

- [ ] **Step 2: 跑测试验证失败**

Run: `cd /Users/moego-winches/Desktop/Company/AI-Agent/agent-slack && pnpm vitest run tests/upgrade.test.ts`
Expected: 第一个新 test 失败（`nestedSnippets['agent.responses']` 为 undefined）；第二个通过。

---

### Task 9: 实现 `extractNestedSnippet` 和接入 `planUpgradeYaml`

**Files:**

- Modify: `src/workspace/upgrade.ts`

- [ ] **Step 1: 增加 `extractNestedSnippet` 函数**

在 `src/workspace/upgrade.ts` 中 `extractTopLevelBlock` 函数之后插入：

```typescript
// 从 generator yaml 文本里抽出指定嵌套 key path 的子节点（含上方紧贴注释）。
// 返回去掉公共缩进的纯净片段，便于用户复制后再手动缩进。
// 路径示例 ['agent', 'responses'] → 抽 agent.responses 整个子块。
function extractNestedSnippet(templateYaml: string, keyPath: string[]): string | undefined {
  if (keyPath.length < 2) return undefined
  const lines = templateYaml.split('\n')

  // 先逐层定位 keyPath，记录起始行 + 该层的缩进
  let currentIndent = 0
  let scanFrom = 0
  let scanTo = lines.length
  let targetStart = -1
  let targetIndent = -1

  for (let depth = 0; depth < keyPath.length; depth++) {
    const key = keyPath[depth]
    const indentRe = new RegExp(`^(\\s{${currentIndent}})${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:`)
    let found = -1
    for (let i = scanFrom; i < scanTo; i++) {
      if (indentRe.test(lines[i] ?? '')) {
        found = i
        break
      }
      // 跨过同层另一个 key 的子块也算合法（regex 只匹配 currentIndent 缩进）
    }
    if (found === -1) return undefined

    if (depth === keyPath.length - 1) {
      targetStart = found
      targetIndent = currentIndent
    } else {
      // 子层缩进默认 +2（项目模板用 2 空格缩进）
      scanFrom = found + 1
      // scanTo: 下一行与 currentIndent 同缩进且非空非注释 → 限制 scanTo
      for (let j = found + 1; j < scanTo; j++) {
        const line = lines[j] ?? ''
        if (line.trim() === '' || line.trimStart().startsWith('#')) continue
        const matchIndent = line.match(/^(\s*)/)?.[1].length ?? 0
        if (matchIndent <= currentIndent) {
          scanTo = j
          break
        }
      }
      currentIndent += 2
    }
  }
  if (targetStart === -1) return undefined

  // 上吞紧贴注释
  let startIdx = targetStart
  while (startIdx > 0) {
    const prev = lines[startIdx - 1] ?? ''
    if (prev.trim() === '') break
    const prevIndent = prev.match(/^(\s*)/)?.[1].length ?? 0
    if (prev.trimStart().startsWith('#') && prevIndent >= targetIndent) {
      startIdx -= 1
      continue
    }
    break
  }

  // 下扩到同级或更低缩进
  let endIdx = targetStart
  for (let i = targetStart + 1; i < lines.length; i++) {
    const line = lines[i] ?? ''
    if (line.trim() === '') {
      endIdx = i
      continue
    }
    const indent = line.match(/^(\s*)/)?.[1].length ?? 0
    if (indent <= targetIndent && !line.trimStart().startsWith('#')) {
      break
    }
    endIdx = i
  }

  // 去公共缩进
  const slice = lines.slice(startIdx, endIdx + 1)
  const stripped = slice.map((l) => (l.length >= targetIndent ? l.slice(targetIndent) : l))
  return stripped.join('\n')
}
```

- [ ] **Step 2: 在 `planUpgradeYaml` 里填 `nestedSnippets`**

修改 `src/workspace/upgrade.ts` 的 `planUpgradeYaml`。找到现有的"如果只有 nested 缺失" 分支（约 :111-117 那个 return）和"正常追加"分支（:142-147），都把 `nestedSnippets: {}` 替换为：

```typescript
nestedSnippets: buildNestedSnippets(templateYaml, out.nested),
```

在 `planUpgradeYaml` 函数下方追加 helper：

```typescript
function buildNestedSnippets(templateYaml: string, nestedKeys: string[]): Record<string, string> {
  const result: Record<string, string> = {}
  for (const key of nestedKeys) {
    const snippet = extractNestedSnippet(templateYaml, key.split('.'))
    if (snippet) {
      result[key] = snippet
    }
  }
  return result
}
```

- [ ] **Step 3: 跑测试验证通过**

Run: `cd /Users/moego-winches/Desktop/Company/AI-Agent/agent-slack && pnpm vitest run tests/upgrade.test.ts`
Expected: 全部 test 通过。

- [ ] **Step 4: Commit**

```bash
cd /Users/moego-winches/Desktop/Company/AI-Agent/agent-slack
git add src/workspace/upgrade.ts tests/upgrade.test.ts
git commit -m "feat(upgrade): nestedSnippets — 嵌套缺失附 generator 片段供用户复制"
```

---

### Task 10: 在 upgrade 命令中输出 snippet

**Files:**

- Modify: `src/cli/commands/upgrade.ts:117-123`（`reportPlan` 函数）

- [ ] **Step 1: 修改 `reportPlan` 函数**

把 `src/cli/commands/upgrade.ts` 末尾的 `reportPlan` 函数（约 :110-124）整体替换为：

```typescript
function reportPlan(label: string, plan: UpgradeYamlPlan): void {
  if (plan.missingTopLevel.length > 0) {
    consola.warn(`${label} 缺失顶层字段：${plan.missingTopLevel.join(', ')}`)
    consola.log('--- 计划追加 ---')
    consola.log(plan.plannedAppend.trim())
    consola.log('---')
  }
  if (plan.missingNested.length > 0) {
    consola.warn(
      `${label} 缺失嵌套字段（不自动追加，请手动补到对应父节点下）：${plan.missingNested.join(', ')}`,
    )
    for (const key of plan.missingNested) {
      const snippet = plan.nestedSnippets[key]
      if (!snippet) continue
      consola.log(`--- ${key} 模板片段 ---`)
      consola.log(snippet.trim())
      consola.log('---')
    }
  }
}
```

- [ ] **Step 2: 手测**

复用 `/tmp/asl-upgrade-test`，重置 config.yaml 故意缺一个嵌套字段：

```bash
cat > /tmp/asl-upgrade-test/.agent-slack/config.yaml <<'EOF'
agent:
  name: default
  model: gpt-5.5
  maxSteps: 50
  provider: openai-responses
  context:
    maxApproxChars: 900000
im:
  enabled: ['slack']
EOF
```

Run: `cd /Users/moego-winches/Desktop/Company/AI-Agent/agent-slack && pnpm cli upgrade --cwd /tmp/asl-upgrade-test --dry-run`

Expected: 输出含 `缺失嵌套字段...agent.responses` 之后跟着 `--- agent.responses 模板片段 ---` 块，里面有 `reasoningEffort: medium` 注释行等。

- [ ] **Step 3: Commit**

```bash
cd /Users/moego-winches/Desktop/Company/AI-Agent/agent-slack
git add src/cli/commands/upgrade.ts
git commit -m "feat(upgrade): 嵌套缺失警告附 generator 模板片段"
```

---

## Chunk 4: 端到端验证 + 文档同步

### Task 11: 在用户实际 workspace 上跑 dry-run

**Files:** （无文件改动）

- [ ] **Step 1: 在用户 agent-workspace 仓库上 dry-run**

Run:
```bash
cd /Users/moego-winches/Desktop/Company/AI-Agent/agent-slack
pnpm cli upgrade --cwd /Users/moego-winches/Desktop/Company/person/agent-workspace --dry-run
```

Expected stdout 至少包含：

- `config.yaml: im.provider → im.enabled（v0.1.9: ...）`
- `scheduled-tasks "..." 的 target.im="telegram" 不在 config.im.enabled=[slack] 中`（如果用户当前仍是 slack-only）

注意：这是 `--dry-run`，不会改用户文件。

- [ ] **Step 2: 把输出贴回 plan 文档（observation 记录）**

把上述输出 paste 到本 plan 文档底部 "## 实测记录" 段，作为完成验证依据。

---

### Task 12: 更新 README 和 CHANGELOG

**Files:**

- Modify: `README.md`（upgrade 命令章节）
- Modify: `CHANGELOG.md`（追加 v0.1.10 unreleased 段）

- [ ] **Step 1: 在 `README.md` 找 upgrade 命令章节**

Run: `cd /Users/moego-winches/Desktop/Company/AI-Agent/agent-slack && grep -n "upgrade" README.md | head -10`

如果有相关章节，更新描述：从 "对比模板补齐顶层缺失字段" 改为 "对比模板补齐顶层缺失字段 + 持久化字段改名迁移（如 im.provider → im.enabled）+ 扫 scheduled-tasks 跨 config.im.enabled mismatch 警告"。

如果没有相关章节，跳过。

- [ ] **Step 2: 在 `CHANGELOG.md` 顶部追加**

在文件最上方（紧跟标题之后）追加：

```markdown
## [Unreleased]

### Added
- `agent-slack upgrade` 增加 `im.provider` → `im.enabled` 字段改名持久化迁移（v0.1.9 schema 升级的补漏）。
- `agent-slack upgrade` 增加 scheduled-tasks 跨文件校验：扫所有启用任务的 `target.im`，不在 `config.im.enabled` 集合里时输出 warning 和修复建议。
- `agent-slack upgrade` 嵌套字段缺失警告升级：附带 generator 中对应子节点的 yaml 片段，便于用户直接复制。

### Notes
- 历史的 `migrateLegacyImProvider()` 仍作为 runtime 兜底保留（用户没跑 upgrade 时不影响 daemon 启动）。
```

- [ ] **Step 3: Commit**

```bash
cd /Users/moego-winches/Desktop/Company/AI-Agent/agent-slack
git add README.md CHANGELOG.md
git commit -m "docs: 同步 upgrade 命令的字段改名迁移 / 跨文件校验 / nested snippet"
```

---

### Task 13: 更新 memory/process.md

**Files:**

- Modify: `memory/process.md`

- [ ] **Step 1: 把当前任务记录写入 process.md**

在 `memory/process.md` 顶部 "当前执行进度" 段下面（替换"当前无进行中的 process 事项"那行）写入：

```markdown
**最近完成（2026-05-16）：**

- agent-slack upgrade 命令补强 v0.1.9 schema 迁移漏洞
  - P0-1: `im.provider` → `im.enabled` 持久化迁移（runtime `migrateLegacyImProvider` 不变，仍作兜底）
  - P0-2: scheduled-tasks 跨 `config.im.enabled` mismatch 警告
  - P1: 嵌套缺失警告附 generator 模板片段（agent.responses / agent.context.effectiveContextTokens / im.wechat 等）
- 触发问题：用户跑 `daemon start` 报"未在 config.im.enabled 中启用"，根因是 config.yaml 旧 provider 字段未迁移
```

- [ ] **Step 2: Commit**

```bash
cd /Users/moego-winches/Desktop/Company/AI-Agent/agent-slack
git add memory/process.md
git commit -m "docs(process): 同步 upgrade 命令迁移补强"
```

---

## 实测记录

**在用户真实 workspace 上的 dry-run（2026-05-16）：**

```
$ pnpm cli upgrade --cwd /Users/moego-winches/Desktop/Company/person/agent-workspace --dry-run

ℹ config.yaml: im.provider → im.enabled（v0.1.9: im.provider (single) → im.enabled (array)）
✔ channel-tasks.yaml: 无缺失字段
✔ scheduled-tasks.yaml: 无缺失字段

 WARN  scheduled-tasks "repo-pull-daily" 的 target.im="telegram" 不在 config.im.enabled=[slack] 中

ℹ 修复办法：在 config.yaml 的 im.enabled 数组里加入缺失的 IM（telegram），或把对应任务的 enabled 改为 false。upgrade 不会自动修改 enabled 列表（避免擅自启用 IM 适配器）。
ℹ --dry-run 模式：未写任何文件
```

结论：完整复现并自动提示了用户最初 `daemon start` 启动失败的两个根因 —— im 旧字段未迁移 + telegram 任务未在 enabled 列表中。

---

## 验收标准

执行完毕后必须满足：

1. ✅ `pnpm test` 全部通过（vitest 套件 + 新增的 `tests/upgrade.test.ts` 共 9 个用例）。
2. ✅ `pnpm tsc --noEmit` 无类型错误。
3. ✅ 在用户的实际 workspace 上跑 `pnpm cli upgrade --cwd <user> --dry-run`，正确输出：
   - im.provider 迁移信息
   - scheduled-tasks mismatch warning（如果存在 telegram 任务）
   - 嵌套缺失带 snippet 输出
4. ✅ `pnpm cli upgrade --cwd <user>`（正式执行）后用户的 config.yaml `im.provider` 被改写为 `im.enabled`，原有注释与字段顺序基本保留（注释保留依赖 yaml lib AST 行为，可能有微调，验收时人工 review 一次）。
5. ✅ 在执行完 upgrade 之后跑 `agent-slack daemon start` 不再因为"目标 IM 未启用"挂掉（前提是用户已经按 mismatch warning 自己加了 telegram 到 enabled，或把 telegram 任务 disable）。
