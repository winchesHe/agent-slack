import { markdownToBlocks, splitBlocksWithText, type Block } from 'markdown-to-slack-blocks'
import type { WebClient } from '@slack/web-api'
import type { Logger } from '@/logger/logger.ts'
import type { SessionUsageInfo } from '@/core/events.ts'
import { isRenderDebugEnabled } from '@/workspace/config'

export interface SlackRendererDeps {
  logger: Logger
}

export interface ProgressUiState {
  // 当前 progress 主状态文案，作为 Slack fallback text。
  status: string
  // 活动文案池，renderer 只关心最后一条可见活动。
  activities: string[]
  // turn 内工具调用累计次数，由 sink 负责累加。
  toolHistory: Map<string, number>
  composing?: boolean
  reasoningTail?: string
}

export interface SessionUsageTailStats {
  memories: number
  tools: number
  skills: number
}

export interface SlackRenderer {
  addAck(client: WebClient, channelId: string, messageTs: string): Promise<void>
  removeAck(client: WebClient, channelId: string, messageTs: string): Promise<void>
  addDone(client: WebClient, channelId: string, messageTs: string): Promise<void>
  addError(client: WebClient, channelId: string, messageTs: string): Promise<void>
  addStopped(client: WebClient, channelId: string, messageTs: string): Promise<void>
  setStatus(
    client: WebClient,
    channelId: string,
    threadTs: string,
    status: string,
    loadingMessages?: string[],
  ): Promise<void>
  clearStatus(client: WebClient, channelId: string, threadTs: string): Promise<void>
  upsertProgressMessage(
    client: WebClient,
    channelId: string,
    threadTs: string,
    state: ProgressUiState,
    prevTs?: string,
  ): Promise<string | undefined>
  finalizeProgressMessageDone(
    client: WebClient,
    channelId: string,
    threadTs: string,
    prevTs: string,
    toolHistory: Map<string, number>,
  ): Promise<void>
  finalizeProgressMessageStopped(
    client: WebClient,
    channelId: string,
    threadTs: string,
    prevTs: string,
  ): Promise<void>
  finalizeProgressMessageError(
    client: WebClient,
    channelId: string,
    threadTs: string,
    prevTs: string,
    errorMessage: string,
  ): Promise<void>
  deleteProgressMessage(
    client: WebClient,
    channelId: string,
    threadTs: string,
    prevTs: string,
  ): Promise<void>
  postThreadReply(
    client: WebClient,
    channelId: string,
    threadTs: string,
    text: string,
    options?: { workspaceLabel?: string },
  ): Promise<void>
  postSessionUsage(
    client: WebClient,
    channelId: string,
    threadTs: string,
    usage: SessionUsageInfo,
    tailStats?: SessionUsageTailStats,
  ): Promise<void>
}

function formatToolHistory(toolHistory: Map<string, number>): string {
  const parts: string[] = []

  for (const [name, count] of toolHistory) {
    parts.push(`${name} x${count}`)
  }

  return parts.join(' · ')
}

// 统一生成 context block，避免各个分支重复手写 Slack block 结构。
function buildContextBlock(text: string): Block {
  return {
    type: 'context',
    elements: [{ type: 'mrkdwn', text }],
  } as Block
}

// progress message 的三行结构固定为：工具历史 / reasoning 摘要 / 最新活动。
function buildProgressBlocks(state: ProgressUiState): Block[] {
  const blocks: Block[] = []
  const toolHistoryText = formatToolHistory(state.toolHistory)

  if (toolHistoryText) {
    blocks.push(buildContextBlock(`🔧 ${toolHistoryText}`))
  }

  if (state.reasoningTail) {
    blocks.push(buildContextBlock(`🤔 ${state.reasoningTail}`))
  }

  const lastActivity = [...state.activities]
    .reverse()
    .find((activity) => activity.trim().length > 0)

  blocks.push(buildContextBlock(lastActivity ?? state.status ?? '…'))

  return blocks
}

// Slack 的 post/update 都要求提供 text fallback，优先复用当前主状态。
function fallbackText(state: ProgressUiState): string {
  return state.status || state.activities.at(-1) || '…'
}

// usage 行简洁展示：耗时 · 成本 · 模型 token 统计 · 本轮 memory/tool/skill 使用。
function formatUsageLine(usage: SessionUsageInfo, tailStats?: SessionUsageTailStats): string {
  const parts = [`:agent_time: ${(usage.durationMs / 1000).toFixed(1)}s`]

  if (usage.totalCostUSD > 0) {
    parts.push(`$${usage.totalCostUSD.toFixed(4)}`)
  }

  for (const model of usage.modelUsage) {
    const total = model.inputTokens + model.outputTokens
    let segment = `${model.model}: ${formatTokenCount(total)} tokens`

    if (model.cacheHitRate > 0) {
      segment += ` (${Math.round(model.cacheHitRate * 100)}% cache)`
    }

    parts.push(segment)
  }

  if (tailStats) {
    if (tailStats.memories > 0) {
      parts.push(`:agent_memory: ${formatCount(tailStats.memories, 'memory', 'memories')}`)
    }
    if (tailStats.tools > 0) {
      parts.push(`:agent_tool: ${formatCount(tailStats.tools, 'tool', 'tools')}`)
    }
    if (tailStats.skills > 0) {
      parts.push(`:agent_skill: ${formatCount(tailStats.skills, 'skill', 'skills')}`)
    }
  }

  return parts.join(' · ')
}

function formatCount(n: number, singular: string, plural: string): string {
  return `${n} ${n === 1 ? singular : plural}`
}

// token 数量超千用 k 后缀，保持紧凑。
function formatTokenCount(n: number): string {
  if (n >= 1000) {
    return `${(n / 1000).toFixed(1)}k`
  }
  return String(n)
}

export function createSlackRenderer(deps: SlackRendererDeps): SlackRenderer {
  const log = deps.logger.withTag('slack:render')
  const renderDebug = isRenderDebugEnabled()

  function debugRender(message: string, meta?: unknown): void {
    if (!renderDebug) {
      return
    }
    log.info(`[render-debug] ${message}`, meta)
  }

  // 所有 Slack API 调用都走同一兜底，避免上层再写重复 try/catch。
  async function safeRender<T>(label: string, fn: () => Promise<T>): Promise<T | undefined> {
    const startedAt = Date.now()
    debugRender(`api start ${label}`, { startedAt })
    try {
      const result = await fn()
      debugRender(`api success ${label}`, {
        durationMs: Date.now() - startedAt,
      })
      return result
    } catch (error) {
      debugRender(`api failed ${label}`, {
        durationMs: Date.now() - startedAt,
        error: error instanceof Error ? error.message : String(error),
      })
      log.warn(`slack api failed: ${label}`, error)
      return undefined
    }
  }

  // 四种 reaction 只是名字不同，共享同一套调用与错误处理。
  async function addReaction(
    client: WebClient,
    channelId: string,
    messageTs: string,
    name: string,
  ): Promise<void> {
    await safeRender(`reactions.add(${name})`, () =>
      client.reactions.add({ channel: channelId, timestamp: messageTs, name }),
    )
  }

  // 移除 reaction，用于终态时清除 ack 的 👀。
  async function removeReaction(
    client: WebClient,
    channelId: string,
    messageTs: string,
    name: string,
  ): Promise<void> {
    await safeRender(`reactions.remove(${name})`, () =>
      client.reactions.remove({ channel: channelId, timestamp: messageTs, name }),
    )
  }

  return {
    addAck: (client, channelId, messageTs) => addReaction(client, channelId, messageTs, 'eyes'),
    removeAck: (client, channelId, messageTs) =>
      removeReaction(client, channelId, messageTs, 'eyes'),
    addDone: (client, channelId, messageTs) =>
      addReaction(client, channelId, messageTs, 'white_check_mark'),
    addError: (client, channelId, messageTs) => addReaction(client, channelId, messageTs, 'x'),
    addStopped: (client, channelId, messageTs) =>
      addReaction(client, channelId, messageTs, 'black_square_for_stop'),
    async setStatus(client, channelId, threadTs, status, loadingMessages) {
      debugRender('setStatus requested', {
        channelId,
        hasLoadingMessages: Boolean(loadingMessages && loadingMessages.length > 0),
        status,
        threadTs,
      })
      const args = {
        channel_id: channelId,
        thread_ts: threadTs,
        status,
        ...(loadingMessages && loadingMessages.length > 0
          ? { loading_messages: loadingMessages }
          : {}),
      } as Parameters<WebClient['assistant']['threads']['setStatus']>[0]

      await safeRender('assistant.threads.setStatus', () =>
        client.assistant.threads.setStatus(args),
      )
    },
    async clearStatus(client, channelId, threadTs) {
      debugRender('clearStatus requested', {
        channelId,
        threadTs,
      })
      const args = {
        channel_id: channelId,
        thread_ts: threadTs,
        status: '',
      } as Parameters<WebClient['assistant']['threads']['setStatus']>[0]

      await safeRender('assistant.threads.setStatus(clear)', () =>
        client.assistant.threads.setStatus(args),
      )
    },
    async upsertProgressMessage(client, channelId, threadTs, state, prevTs) {
      debugRender('upsertProgressMessage requested', {
        channelId,
        prevTs,
        status: state.status,
        threadTs,
        toolHistorySize: state.toolHistory.size,
      })
      const blocks = buildProgressBlocks(state)
      const text = fallbackText(state)

      if (prevTs) {
        const result = await safeRender('chat.update(progress)', () =>
          client.chat.update({
            channel: channelId,
            ts: prevTs,
            text,
            blocks,
          } as Parameters<WebClient['chat']['update']>[0]),
        )

        return result === undefined ? undefined : prevTs
      }

      // 首次激活 progress 时创建 thread reply，并把 ts 交给 sink 保存。
      const result = await safeRender('chat.postMessage(progress)', () =>
        client.chat.postMessage({
          channel: channelId,
          thread_ts: threadTs,
          text,
          blocks,
        } as Parameters<WebClient['chat']['postMessage']>[0]),
      )

      return result?.ts
    },
    async finalizeProgressMessageDone(client, channelId, threadTs, prevTs, toolHistory) {
      void threadTs
      debugRender('finalizeProgressMessageDone requested', {
        channelId,
        prevTs,
        threadTs,
        toolHistorySize: toolHistory.size,
      })
      const toolHistoryText = formatToolHistory(toolHistory)
      const line = toolHistoryText ? `✅ 完成 · ${toolHistoryText}` : '✅ 完成'

      await safeRender('chat.update(progress-done)', () =>
        client.chat.update({
          channel: channelId,
          ts: prevTs,
          text: line,
          blocks: [buildContextBlock(line)],
        } as Parameters<WebClient['chat']['update']>[0]),
      )
    },
    async finalizeProgressMessageStopped(client, channelId, threadTs, prevTs) {
      void threadTs
      debugRender('finalizeProgressMessageStopped requested', {
        channelId,
        prevTs,
        threadTs,
      })

      await safeRender('chat.update(progress-stopped)', () =>
        client.chat.update({
          channel: channelId,
          ts: prevTs,
          text: '已被用户中止',
          blocks: [buildContextBlock('⏹️ 已被用户中止')],
        } as Parameters<WebClient['chat']['update']>[0]),
      )
    },
    async finalizeProgressMessageError(client, channelId, threadTs, prevTs, errorMessage) {
      void threadTs
      debugRender('finalizeProgressMessageError requested', {
        channelId,
        errorMessage,
        prevTs,
        threadTs,
      })
      const line = `⚠️ 出错：${errorMessage}`

      await safeRender('chat.update(progress-error)', () =>
        client.chat.update({
          channel: channelId,
          ts: prevTs,
          text: line,
          blocks: [buildContextBlock(line)],
        } as Parameters<WebClient['chat']['update']>[0]),
      )
    },
    async deleteProgressMessage(client, channelId, threadTs, prevTs) {
      void threadTs
      debugRender('deleteProgressMessage requested', {
        channelId,
        prevTs,
        threadTs,
      })

      await safeRender('chat.delete(progress)', () =>
        client.chat.delete({
          channel: channelId,
          ts: prevTs,
        } as Parameters<WebClient['chat']['delete']>[0]),
      )
    },
    async postThreadReply(client, channelId, threadTs, text, options) {
      const trimmed = text.trim()

      if (!trimmed) {
        return
      }

      debugRender('postThreadReply requested', {
        channelId,
        hasWorkspaceLabel: Boolean(options?.workspaceLabel),
        textLength: trimmed.length,
        threadTs,
      })

      // markdown 先转 blocks，再按 Slack 限制自然切块。
      const blocks = markdownToBlocks(trimmed, { preferSectionBlocks: false })
      const chunks = splitBlocksWithText(blocks)

      for (const [index, chunk] of chunks.entries()) {
        debugRender('postThreadReply chunk', {
          channelId,
          chunkIndex: index,
          chunkTextLength: chunk.text.length,
          threadTs,
        })
        // workspaceLabel 只加在首块，避免后续分片重复噪音。
        const messageBlocks =
          index === 0 && options?.workspaceLabel
            ? [buildContextBlock(options.workspaceLabel), ...chunk.blocks]
            : chunk.blocks

        // 先尝试带 blocks 发送；若 Slack 返回 invalid_blocks，则降级为纯文本重发。
        const result = await safeRender('chat.postMessage(reply)', () =>
          client.chat.postMessage({
            channel: channelId,
            thread_ts: threadTs,
            text: chunk.text,
            blocks: messageBlocks,
          } as Parameters<WebClient['chat']['postMessage']>[0]),
        )

        if (result === undefined) {
          log.warn('blocks 被 Slack 拒绝，降级为纯文本重发', {
            textPreview: chunk.text.slice(0, 200),
            blocksCount: messageBlocks.length,
          })
          await safeRender('chat.postMessage(reply-fallback)', () =>
            client.chat.postMessage({
              channel: channelId,
              thread_ts: threadTs,
              text: chunk.text,
            } as Parameters<WebClient['chat']['postMessage']>[0]),
          )
        }
      }
    },
    async postSessionUsage(client, channelId, threadTs, usage, tailStats) {
      const line = formatUsageLine(usage, tailStats)

      await safeRender('chat.postMessage(usage)', () =>
        client.chat.postMessage({
          channel: channelId,
          thread_ts: threadTs,
          text: line,
          blocks: [buildContextBlock(line)],
        } as Parameters<WebClient['chat']['postMessage']>[0]),
      )
    },
  }
}
