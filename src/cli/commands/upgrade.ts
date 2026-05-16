// agent-slack upgrade：把当前 workspace 的 config.yaml / channel-tasks.yaml / scheduled-tasks.yaml
// 与最新 generator 模板对比，顶层缺失 key 自动追加（含中文注释 + 分隔注释）。
// system.md 缺失则按 workspace 模板创建；存在不动。
// .env.local 不参与（凭证类，用户自管）。
//
// 行为约定：
// - --dry-run：不写文件，仅打印将要追加的内容与告警
// - 正式执行：先备份原文件 → 写入新文件；备份路径 .agent-slack/<file>.bak.<ISO>
// - 嵌套缺失（父存在子缺失）：第一版仅打印告警，提示用户手补；不自动追加，避免破坏 yaml 嵌套结构。

import { existsSync } from 'node:fs'
import { copyFile, readFile, writeFile, mkdir } from 'node:fs/promises'
import path from 'node:path'
import { consola } from 'consola'
import YAML from 'yaml'
import { resolveWorkspacePaths } from '@/workspace/paths.ts'
import {
  generateChannelTasksYaml,
  generateConfigYaml,
  generateScheduledTasksYaml,
  generateSystemMd,
} from '@/workspace/templates/index.ts'
import {
  backupSuffix,
  collectImMismatch,
  planUpgradeYaml,
  type UpgradeYamlPlan,
} from '@/workspace/upgrade.ts'

export interface UpgradeOpts {
  cwd: string
  dryRun: boolean
}

interface FileTarget {
  label: string
  filePath: string
  template: string
}

export async function upgradeCommand(opts: UpgradeOpts): Promise<void> {
  const paths = resolveWorkspacePaths(opts.cwd)

  if (!existsSync(paths.root)) {
    consola.warn(`workspace 不存在：${paths.root}（先跑 agent-slack onboard）`)
    return
  }

  const targets: FileTarget[] = [
    {
      label: 'config.yaml',
      filePath: paths.configFile,
      template: generateConfigYaml({ mode: 'workspace' }),
    },
    {
      label: 'channel-tasks.yaml',
      filePath: paths.channelTasksFile,
      template: generateChannelTasksYaml({ mode: 'workspace' }),
    },
    {
      label: 'scheduled-tasks.yaml',
      filePath: paths.scheduledTasksFile,
      template: generateScheduledTasksYaml({ mode: 'workspace' }),
    },
  ]

  let touched = 0

  for (const target of targets) {
    if (!existsSync(target.filePath)) {
      // 文件缺失视为可选；upgrade 不主动创建，避免无意启用 channel-tasks（其默认 enabled=false 但仍属"激活"）。
      consola.info(`跳过 ${target.label}：文件不存在（可手动创建）`)
      continue
    }
    const userYaml = await readFile(target.filePath, 'utf8')
    const plan = planUpgradeYaml(userYaml, target.template)
    if (
      plan.missingTopLevel.length === 0 &&
      plan.missingNested.length === 0 &&
      plan.appliedRenames.length === 0
    ) {
      consola.success(`${target.label}: 无缺失字段`)
      continue
    }

    // rename 先报告（即便没有缺失字段也必须报）
    for (const r of plan.appliedRenames) {
      consola.info(`${target.label}: ${r.from} → ${r.to}（${r.reason}）`)
    }

    reportPlan(target.label, plan)

    if (opts.dryRun) {
      continue
    }

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
  }

  // 跨文件校验：scheduled-tasks.target.im ⊆ config.im.enabled
  // upgrade 跑过之后再读一遍 config.yaml（可能刚刚被改名/追加），保证校验基于"最终态"。
  if (existsSync(paths.configFile) && existsSync(paths.scheduledTasksFile)) {
    const configYaml = await readFile(paths.configFile, 'utf8')
    const scheduledYaml = await readFile(paths.scheduledTasksFile, 'utf8')
    const configParsed = (YAML.parse(configYaml) ?? {}) as Record<string, unknown>
    const imObj = configParsed.im as Record<string, unknown> | undefined
    // 兼容刚被 rename 改写后的 enabled 数组，以及历史 provider 单值（dry-run 时磁盘上还是旧字段）
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
      const uniqueMissing = [...new Set(mismatches.map((m) => m.targetIm))]
      consola.info(
        `修复办法：在 config.yaml 的 im.enabled 数组里加入缺失的 IM（${uniqueMissing.join(', ')}），或把对应任务的 enabled 改为 false。upgrade 不会自动修改 enabled 列表（避免擅自启用 IM 适配器）。`,
      )
    }
  }

  // system.md：不存在则创建（用户内容文件，存在则不动）
  if (!existsSync(paths.systemFile)) {
    if (opts.dryRun) {
      consola.info('system.md 不存在；正式 upgrade 将按 workspace 模板创建')
    } else {
      await mkdir(paths.root, { recursive: true })
      await writeFile(paths.systemFile, generateSystemMd({ mode: 'workspace' }), 'utf8')
      consola.success('system.md: 已按模板创建')
      touched += 1
    }
  }

  if (opts.dryRun) {
    consola.info('--dry-run 模式：未写任何文件')
  } else if (touched === 0) {
    consola.info('无文件被修改')
  }
}

function reportPlan(label: string, plan: UpgradeYamlPlan): void {
  if (plan.missingTopLevel.length > 0) {
    consola.warn(`${label} 缺失顶层字段：${plan.missingTopLevel.join(', ')}`)
    consola.log('--- 计划追加 ---')
    consola.log(plan.plannedAppend.trim())
    consola.log('---')
  }
  if (plan.missingNested.length > 0) {
    consola.warn(
      `${label} 缺失嵌套字段（不自动追加，请手动补到对应父节点下，参考 generator 输出）：\n  ${plan.missingNested.join(
        '\n  ',
      )}`,
    )
  }
}
