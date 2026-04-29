// agent-slack workspace upgrade 算法（追加式 α，schema-driven）。
//
// 设计取舍：
// - 顶层 key 缺失（generator 里有但用户文件里没有，例如 daemon: 整段）→ 自动从 generator 文本里抽出对应整块（含中文注释）
//   追加到用户文件末尾，用一个分隔注释 `# === agent-slack upgrade <ISO> 追加缺失字段 ===` 包裹。
// - 嵌套 key 缺失（父存在子不存在，例如 agent.responses 父 agent 已有但子段缺失）→ 第一版仅列出，提示手动补；
//   不自动追加（避免错乱 yaml 嵌套结构）。后续可迭代为 AST 精确插入。
// - 不破坏用户已有内容、注释、字段顺序：纯文本末尾追加。
// - dry-run：返回 { plannedAppend, missingNested }，不写文件。
// - apply：先备份 → 写入；备份路径 `<file>.bak.<ISO>`。

import YAML from 'yaml'

export interface UpgradeYamlPlan {
  // 顶层缺失 key 列表（直接追加到文件末尾）
  missingTopLevel: string[]
  // 嵌套缺失（"agent.responses" 等）：父存在但子缺失，第一版仅列出
  missingNested: string[]
  // 计划追加到用户文件末尾的文本片段（包含分隔注释 + 各顶层缺失块）；无追加时为空字符串。
  plannedAppend: string
  // 升级后的完整文件文本（用户原文 + plannedAppend）；无追加时与 userYaml 一致。
  upgraded: string
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

// 从 generator 文本里抽取以 `<key>:` 开头的顶级块。包含 key 行、其上紧贴的连续注释行、value 子树的所有缩进行。
// 顶级 key = 0 缩进；块结束 = 下一个 0 缩进非空行（同级 key）或文件末。
function extractTopLevelBlock(templateYaml: string, key: string): string | undefined {
  const lines = templateYaml.split('\n')
  const keyLineRe = new RegExp(`^${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:`)
  let keyIdx = -1
  for (let i = 0; i < lines.length; i++) {
    if (keyLineRe.test(lines[i] ?? '')) {
      keyIdx = i
      break
    }
  }
  if (keyIdx === -1) return undefined

  // 向上吞并紧贴的注释行 / 空白注释段；首个空行截止。
  let startIdx = keyIdx
  while (startIdx > 0) {
    const prev = lines[startIdx - 1] ?? ''
    if (prev.startsWith('#') || prev.startsWith('  #')) {
      startIdx -= 1
      continue
    }
    break
  }

  // 向下扩展到下一个顶层 key 或文件末。
  let endIdx = keyIdx
  for (let i = keyIdx + 1; i < lines.length; i++) {
    const line = lines[i] ?? ''
    if (line.length === 0) {
      endIdx = i
      continue
    }
    // 顶层 key（无缩进，且不是 # 注释）
    if (!line.startsWith(' ') && !line.startsWith('#') && line.includes(':')) {
      break
    }
    endIdx = i
  }

  return lines.slice(startIdx, endIdx + 1).join('\n')
}

// 计算 user object 中相对 template object 缺失的 key path。
function diffMissingKeys(
  user: unknown,
  template: unknown,
  prefix: string[],
  out: { topLevel: string[]; nested: string[] },
): void {
  if (!isPlainObject(template)) return
  if (!isPlainObject(user)) {
    // 整段缺失：所有顶级 key 都视为缺失（仅在最外层调用，不会到这里）
    return
  }
  for (const key of Object.keys(template)) {
    if (!(key in user)) {
      const path = [...prefix, key].join('.')
      if (prefix.length === 0) {
        out.topLevel.push(path)
      } else {
        out.nested.push(path)
      }
      continue
    }
    diffMissingKeys(user[key], template[key], [...prefix, key], out)
  }
}

export function planUpgradeYaml(userYaml: string, templateYaml: string): UpgradeYamlPlan {
  let userObj: unknown = {}
  try {
    userObj = YAML.parse(userYaml) ?? {}
  } catch {
    // yaml 损坏时按"整体缺失"处理：所有顶级 key 都缺失，便于用户立刻看到完整 generator 输出
    userObj = {}
  }
  const templateObj = YAML.parse(templateYaml) ?? {}

  const out: { topLevel: string[]; nested: string[] } = { topLevel: [], nested: [] }
  diffMissingKeys(userObj, templateObj, [], out)

  if (out.topLevel.length === 0 && out.nested.length === 0) {
    return {
      missingTopLevel: [],
      missingNested: [],
      plannedAppend: '',
      upgraded: userYaml,
    }
  }

  const blocks: string[] = []
  for (const key of out.topLevel) {
    const block = extractTopLevelBlock(templateYaml, key)
    if (block) {
      blocks.push(block)
    }
  }

  if (blocks.length === 0) {
    return {
      missingTopLevel: out.topLevel,
      missingNested: out.nested,
      plannedAppend: '',
      upgraded: userYaml,
    }
  }

  const iso = new Date().toISOString()
  const sep = `# === agent-slack upgrade ${iso} 追加缺失字段：${out.topLevel.join(', ')} ===`
  // 用户原文若不以换行结尾，先补一个；再插入分隔行 + 各块（块之间空一行）。
  const userTrim = userYaml.endsWith('\n') ? userYaml : `${userYaml}\n`
  const appendText = `\n${sep}\n${blocks.join('\n\n')}\n`
  return {
    missingTopLevel: out.topLevel,
    missingNested: out.nested,
    plannedAppend: appendText,
    upgraded: `${userTrim}${appendText}`,
  }
}

// ISO timestamp 中冒号在 macOS APFS 合法但部分 fs/文件名习惯里不友好；按 daemon backup 现行格式 ISO + 替换冒号。
export function backupSuffix(now: Date = new Date()): string {
  return now.toISOString().replace(/[:.]/g, '-')
}
