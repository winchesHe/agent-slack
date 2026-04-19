import type { WebClient } from '@slack/web-api'
import type {
  ActivityState,
  AgentExecutionEvent,
  SessionUsageInfo,
  StopReason,
} from '@/core/events.ts'
import type { Logger } from '@/logger/logger.ts'
import type { EventSink } from '@/im/types.ts'
import { STATUS, getShuffledLoadingMessages } from './thinking-messages.ts'
import type { SlackRenderer } from './SlackRenderer.ts'

export interface SlackEventSinkDeps {
  web: WebClient
  channelId: string
  threadTs: string
  sourceMessageTs: string
  workspaceLabel?: string
  renderer: SlackRenderer
  logger: Logger
}

export interface SlackEventSink extends EventSink {
  readonly terminalPhase: 'completed' | 'stopped' | 'failed' | undefined
}

interface SinkLocalState {
  // 这些字段会在状态机运行过程中被显式“写成 undefined”来表示清空，
  // 因此不能只写成可选属性；在 `exactOptionalPropertyTypes` 下，
  // `foo?: string` 不等价于“允许后续赋值 undefined”。
  progressMessageTs: string | undefined
  toolHistory: Map<string, number>
  // 每个 base tool name 的最新 display label（如 bash → bash(cat config.yaml)）。
  toolLatestLabel: Map<string, string>
  lastStateKey: string | undefined
  hasSentToolbarInTurn: boolean
  terminalPhase: 'completed' | 'stopped' | 'failed' | undefined
  terminalStopReason: StopReason | undefined
  terminalErrorMessage: string | undefined
  pendingUsage: SessionUsageInfo | undefined
}

function makeStateKey(state: ActivityState): string {
  // key diff 只比较真正会改变“当前状态快照”的字段。
  // `newToolCalls` 代表“这一次新出现了哪些工具调用”，它是增量信号，不是静态快照；
  // 如果把它算进 key，相同的 `read_file` 第二次出现时就会被错误视为“同一状态”，
  // 从而跳过 progress 刷新，`toolHistory` 也就无法累计出 `read_file x2`。
  const { newToolCalls: _ignoredNewToolCalls, ...rest } = state

  return JSON.stringify(rest)
}

function isMeaningful(state: ActivityState): boolean {
  // progress 只在“对用户有额外信息量”的状态下激活。
  // 默认的 thinking 态只需要刷新状态条，不值得单独占一条 progress message。
  if (state.clear) {
    return false
  }

  // 进入 composing / reasoning / 非默认状态 / 出现新工具时，说明用户能看到新的阶段信息，
  // 这时才值得从状态条升级成独立 progress。
  if (state.composing) {
    return true
  }
  if (state.reasoningTail) {
    return true
  }
  if (state.status !== STATUS.thinking) {
    return true
  }
  if (state.newToolCalls && state.newToolCalls.length > 0) {
    return true
  }

  return false
}

// 从 display label 中提取 base tool name：bash(cat config.yaml) → bash，edit_file → edit_file。
function extractBaseToolName(label: string): string {
  const parenIdx = label.indexOf('(')

  return parenIdx >= 0 ? label.slice(0, parenIdx) : label
}

// 将 base name 的 toolHistory 转为 display label 版本，供渲染层直接使用。
function toDisplayToolHistory(toolHistory: Map<string, number>, toolLatestLabel: Map<string, string>): Map<string, number> {
  const display = new Map<string, number>()

  for (const [base, count] of toolHistory) {
    const label = toolLatestLabel.get(base) ?? base
    display.set(label, count)
  }

  return display
}

function toProgressUiState(state: Exclude<ActivityState, { clear: true }>, toolHistory: Map<string, number>, toolLatestLabel: Map<string, string>) {
  return {
    status: state.status,
    activities: state.activities,
    toolHistory: toDisplayToolHistory(toolHistory, toolLatestLabel),
    ...(state.composing ? { composing: true } : {}),
    ...(state.reasoningTail ? { reasoningTail: state.reasoningTail } : {}),
  }
}

export function createSlackEventSink(deps: SlackEventSinkDeps): SlackEventSink {
  const log = deps.logger.withTag('slack:sink')
  const local: SinkLocalState = {
    progressMessageTs: undefined,
    toolHistory: new Map<string, number>(),
    toolLatestLabel: new Map<string, string>(),
    lastStateKey: undefined,
    hasSentToolbarInTurn: false,
    terminalPhase: undefined,
    terminalStopReason: undefined,
    terminalErrorMessage: undefined,
    pendingUsage: undefined,
  }

  async function handleActivity(state: ActivityState): Promise<void> {
    // 工具历史是按事件次数累加的，而不是按“是否首次见到该工具”去重。
    // 这样 progress/finalize 才能精确显示 `read_file x3` 之类的累计信息。
    if (state.newToolCalls && state.newToolCalls.length > 0) {
      for (const label of state.newToolCalls) {
        const base = extractBaseToolName(label)
        local.toolHistory.set(base, (local.toolHistory.get(base) ?? 0) + 1)
        local.toolLatestLabel.set(base, label)
      }
    }

    if (state.clear) {
      // clear 是显式清场信号：progress 和状态条都要收掉，并重置 key，
      // 避免后续同 key 状态被误判成“已经刷过”。
      if (local.progressMessageTs) {
        await deps.renderer.deleteProgressMessage(
          deps.web,
          deps.channelId,
          deps.threadTs,
          local.progressMessageTs,
        )
        local.progressMessageTs = undefined
      }

      await deps.renderer.clearStatus(deps.web, deps.channelId, deps.threadTs)
      local.lastStateKey = undefined
      return
    }

    const hasNewToolCalls = Boolean(state.newToolCalls && state.newToolCalls.length > 0)
    const nextStateKey = makeStateKey(state)

    // 去重只在“没有新的工具增量”时生效。
    // 原因：相同 status/activities 下，新的 tool call 仍然需要推动 progress 重新 upsert，
    // 否则工具累计次数虽然在本地变了，Slack 上看起来却没变。
    if (!hasNewToolCalls && local.lastStateKey === nextStateKey) {
      return
    }

    local.lastStateKey = nextStateKey

    if (local.progressMessageTs) {
      const nextProgressTs = await deps.renderer.upsertProgressMessage(
        deps.web,
        deps.channelId,
        deps.threadTs,
        toProgressUiState(state, local.toolHistory, local.toolLatestLabel),
        local.progressMessageTs,
      )

      if (nextProgressTs) {
        local.progressMessageTs = nextProgressTs
      }
      return
    }

    // progress 还没激活时，只有 meaningful 状态才升级成独立消息。
    // 默认 thinking 态继续停留在 assistant status，避免一上来就刷一条空洞 progress。
    if (isMeaningful(state)) {
      await deps.renderer.clearStatus(deps.web, deps.channelId, deps.threadTs)
      const nextProgressTs = await deps.renderer.upsertProgressMessage(
        deps.web,
        deps.channelId,
        deps.threadTs,
        toProgressUiState(state, local.toolHistory, local.toolLatestLabel),
      )

      if (nextProgressTs) {
        local.progressMessageTs = nextProgressTs
      }
      return
    }

    await deps.renderer.setStatus(
      deps.web,
      deps.channelId,
      deps.threadTs,
      state.status,
      state.activities,
    )
  }

  async function handleAssistantMessage(text: string): Promise<void> {
    const replyOptions =
      !local.hasSentToolbarInTurn && deps.workspaceLabel
        ? { workspaceLabel: deps.workspaceLabel }
        : undefined

    await deps.renderer.postThreadReply(
      deps.web,
      deps.channelId,
      deps.threadTs,
      text,
      replyOptions,
    )
    local.hasSentToolbarInTurn = true

    if (local.progressMessageTs) {
      await deps.renderer.deleteProgressMessage(
        deps.web,
        deps.channelId,
        deps.threadTs,
        local.progressMessageTs,
      )
      local.progressMessageTs = undefined
    }

    // 回复一旦发出，就允许下一轮 activity 从头判断是否需要再次激活 progress。
    local.lastStateKey = undefined

    await deps.renderer.setStatus(
      deps.web,
      deps.channelId,
      deps.threadTs,
      STATUS.thinking,
      getShuffledLoadingMessages(8),
    )
  }

  async function handleLifecycle(
    event: Extract<AgentExecutionEvent, { type: 'lifecycle' }>,
  ): Promise<void> {
    if (event.phase === 'started') {
      await deps.renderer.addAck(deps.web, deps.channelId, deps.sourceMessageTs)
      await deps.renderer.setStatus(
        deps.web,
        deps.channelId,
        deps.threadTs,
        STATUS.thinking,
        getShuffledLoadingMessages(8),
      )
      return
    }

    // terminalPhase 采用 first-write-wins：
    // 同一 turn 的终态必须以第一条落地事件为准，后来的 completed/failed/stopped
    // 往往只是并发竞态或兜底逻辑补发；如果允许覆盖，会出现先完成又被改成失败之类的错乱 UI。
    if (local.terminalPhase) {
      log.warn('terminalPhase 已设置，忽略重复终态事件', {
        existing: local.terminalPhase,
        incoming: event.phase,
      })
      return
    }

    local.terminalPhase = event.phase

    if (event.phase === 'stopped') {
      local.terminalStopReason = event.reason
    }

    if (event.phase === 'failed') {
      local.terminalErrorMessage = event.error?.message ?? 'unknown'
    }
  }

  return {
    async onEvent(event) {
      try {
        switch (event.type) {
          case 'activity-state':
            await handleActivity(event.state)
            break
          case 'assistant-message':
            await handleAssistantMessage(event.text)
            break
          case 'usage-info':
            local.pendingUsage = event.usage
            break
          case 'lifecycle':
            await handleLifecycle(event)
            break
        }
      } catch (error) {
        log.error('sink onEvent 内部异常（不冒泡）', error)
      }
    },
    async finalize() {
      try {
        await deps.renderer.clearStatus(deps.web, deps.channelId, deps.threadTs)

        if (local.progressMessageTs) {
          const previousProgressTs = local.progressMessageTs

          // finalize 的三种终态分流：
          // 1. completed: 把 progress 收束成“✅ 完成 + 工具累计”
          // 2. stopped: 普通停止显示 stopped；若 superseded，则直接删掉旧 progress 让新 turn 接管
          // 3. failed: 把 progress 收束成错误文案，保留失败原因
          if (local.terminalPhase === 'completed') {
            await deps.renderer.finalizeProgressMessageDone(
              deps.web,
              deps.channelId,
              deps.threadTs,
              previousProgressTs,
              toDisplayToolHistory(local.toolHistory, local.toolLatestLabel),
            )
          } else if (local.terminalPhase === 'stopped') {
            if (local.terminalStopReason === 'superseded') {
              await deps.renderer.deleteProgressMessage(
                deps.web,
                deps.channelId,
                deps.threadTs,
                previousProgressTs,
              )
            } else {
              await deps.renderer.finalizeProgressMessageStopped(
                deps.web,
                deps.channelId,
                deps.threadTs,
                previousProgressTs,
              )
            }
          } else if (local.terminalPhase === 'failed') {
            await deps.renderer.finalizeProgressMessageError(
              deps.web,
              deps.channelId,
              deps.threadTs,
              previousProgressTs,
              local.terminalErrorMessage ?? 'unknown',
            )
          } else {
            log.warn('finalize 时存在 progress 但没有 terminalPhase，按兜底删除 progress', {
              progressMessageTs: previousProgressTs,
            })
            await deps.renderer.deleteProgressMessage(
              deps.web,
              deps.channelId,
              deps.threadTs,
              previousProgressTs,
            )
          }

          local.progressMessageTs = undefined
        }

        if (local.terminalPhase === 'completed' && local.pendingUsage) {
          await deps.renderer.postSessionUsage(
            deps.web,
            deps.channelId,
            deps.threadTs,
            local.pendingUsage,
          )
        }

        if (local.terminalPhase === 'completed') {
          await deps.renderer.addDone(deps.web, deps.channelId, deps.sourceMessageTs)
        } else if (local.terminalPhase === 'stopped') {
          await deps.renderer.addStopped(deps.web, deps.channelId, deps.sourceMessageTs)
        } else if (local.terminalPhase === 'failed') {
          await deps.renderer.addError(deps.web, deps.channelId, deps.sourceMessageTs)
        }
      } catch (error) {
        log.error('sink finalize 内部异常（不冒泡）', error)
      }
    },
    get terminalPhase() {
      return local.terminalPhase
    },
  }
}
