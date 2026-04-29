// agent-slack upgrade：把当前 workspace 的 config.yaml / channel-tasks.yaml 与最新 generator 模板对比，
// 顶层缺失 key 自动追加（含中文注释 + 分隔注释）。system.md 缺失则按 workspace 模板创建；存在不动。
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
import { resolveWorkspacePaths } from '@/workspace/paths.ts'
import {
  generateChannelTasksYaml,
  generateConfigYaml,
  generateSystemMd,
} from '@/workspace/templates/index.ts'
import { backupSuffix, planUpgradeYaml, type UpgradeYamlPlan } from '@/workspace/upgrade.ts'

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
    if (plan.missingTopLevel.length === 0 && plan.missingNested.length === 0) {
      consola.success(`${target.label}: 无缺失字段`)
      continue
    }

    reportPlan(target.label, plan)

    if (opts.dryRun) {
      continue
    }

    if (plan.plannedAppend) {
      const backupPath = `${target.filePath}.bak.${backupSuffix()}`
      await copyFile(target.filePath, backupPath)
      await writeFile(target.filePath, plan.upgraded, 'utf8')
      consola.success(`${target.label}: 已备份 ${path.basename(backupPath)} 并追加缺失顶层字段`)
      touched += 1
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
