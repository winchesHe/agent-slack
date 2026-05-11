// agent-slack scheduled-tasks run <id>
//
// 独立进程手动触发一个定时任务（不依赖 daemon）。
// 行为契约（spec §5.3）：
// - 加载 .agent-slack/scheduled-tasks.yaml → 找 rule by id
//   yaml 不存在 / schema 错 → exit 5
//   rule id 不存在 → exit 2
// - 与 config.im.enabled 做交叉校验
//   未启用 → exit 4
// - 若 target.im=wechat：wechatHandle.loadCredentialsOnly(file)
//   缺失 → exit 3（MissingWechatCredentialsError）
//   存在 → 同步 api.baseUrl + setToken
// - 调 app.scheduledTasks.runner.runOnce(rule, 'manual')
//   runner 内部完成 history 写入（与 daemon 同一份 jsonl）

import { consola } from 'consola'
import { loadScheduledTasksConfigFile } from '@/scheduledTasks/index.ts'
import { resolveWorkspacePaths } from '@/workspace/paths.ts'
import { loadWorkspaceContext } from '@/workspace/WorkspaceContext.ts'
import { loadWorkspaceEnv } from '@/workspace/loadEnv.ts'
import { createApplication } from '@/application/createApplication.ts'
import { MissingWechatCredentialsError } from '@/im/wechat/WechatAdapter.ts'

export interface RunScheduledTaskCliOpts {
  cwd: string
  id: string
}

export async function runScheduledTaskCli(opts: RunScheduledTaskCliOpts): Promise<number> {
  const paths = resolveWorkspacePaths(opts.cwd)

  // 1. 加载 yaml（不存在 / schema 错 → exit 5）
  let stConfig: Awaited<ReturnType<typeof loadScheduledTasksConfigFile>>
  try {
    stConfig = await loadScheduledTasksConfigFile(paths.scheduledTasksFile)
  } catch (err) {
    consola.error('scheduled-tasks.yaml schema 错误：', err instanceof Error ? err.message : err)
    return 5
  }
  if (!stConfig) {
    consola.error(`未找到 ${paths.scheduledTasksFile}（先运行 agent-slack onboard 或手动创建）`)
    return 5
  }

  // 2. 找 rule
  const rule = stConfig.tasks.find((t) => t.id === opts.id)
  if (!rule) {
    const known = stConfig.tasks.map((t) => t.id).join(', ') || '(空)'
    consola.error(`未找到 id="${opts.id}" 的定时任务；已知 id: ${known}`)
    return 2
  }

  // 3. IM 启用校验：从 workspace config 读 im.enabled
  loadWorkspaceEnv({ workspaceDir: opts.cwd })
  // 用 bootstrap logger（不需要 redactor 隐藏，CLI 控制台）
  const consoleLogger = {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
    withTag: () => consoleLogger,
  } as never
  const ctx = await loadWorkspaceContext(opts.cwd, consoleLogger)
  if (!ctx.config.im.enabled.includes(rule.target.im)) {
    consola.error(
      `定时任务 "${rule.id}" 目标 IM "${rule.target.im}" 未在 config.im.enabled 中启用`,
    )
    return 4
  }

  // 4. 构造 application（不调 start：CLI 不启 Bolt socket，不进 wechat long-poll）
  let app
  try {
    app = await createApplication({ workspaceDir: opts.cwd })
  } catch (err) {
    consola.error('createApplication 失败：', err instanceof Error ? err.message : err)
    return 1
  }

  if (!app.scheduledTasks?.runner) {
    consola.error('scheduledTasks 模块未启用（顶层 enabled:false？）')
    return 1
  }

  // 5. wechat 路径 preflight：prepareForManualRun（内部 loadCredentialsOnly + 同步 baseUrl + setToken）
  if (rule.target.im === 'wechat') {
    if (!app.wechatHandle) {
      consola.error('wechat adapter 未装配（理论不会发生）')
      return 1
    }
    try {
      await app.wechatHandle.prepareForManualRun(paths.wechatCredentialsFile)
    } catch (err) {
      if (err instanceof MissingWechatCredentialsError) {
        consola.error(err.message)
        consola.info('请先运行 `agent-slack daemon start` 完成微信扫码登录')
        return 3
      }
      throw err
    }
  }

  // 6. 调 runner.runOnce(rule, 'manual')
  try {
    await app.scheduledTasks.runner.runOnce(rule, 'manual')
    return 0
  } catch (err) {
    consola.error('runOnce 异常（runner 兜底应已记录）：', err instanceof Error ? err.message : err)
    return 1
  }
}
