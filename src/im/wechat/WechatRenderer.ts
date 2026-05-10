import type { AgentExecutionEvent } from '@/core/events.ts'
import type { Logger } from '@/logger/logger.ts'

export interface WechatRendererDeps {
  logger: Logger
}

export interface WechatRenderer {
  /** 累积一个事件到 renderer 内部状态 */
  onEvent(event: AgentExecutionEvent): void
  /** finalize 时取出所有待发送的文本段 */
  flush(): string[]
  /** 起始消息文本（首段） */
  readonly STARTING_MESSAGE: string
}

const TEXT_CHUNK_LIMIT = 4000
const STARTING_MESSAGE = '开始处理...'

export function createWechatRenderer(deps: WechatRendererDeps): WechatRenderer {
  const log = deps.logger.withTag('wechat:renderer')
  // 累积态
  const assistantTexts: string[] = []
  const toolNamesUsed = new Set<string>()
  let terminalPhase: 'completed' | 'stopped' | 'failed' | undefined
  let failedError: string | undefined

  return {
    STARTING_MESSAGE,

    onEvent(event) {
      switch (event.type) {
        case 'assistant-message':
          if (event.text.trim()) assistantTexts.push(event.text)
          break
        case 'activity-state':
          // 注意：clear / newToolCalls 在 event.state 上（src/core/events.ts ActivityState union），不在 event 顶层
          if (event.state.clear !== true && event.state.newToolCalls?.length) {
            for (const name of event.state.newToolCalls) toolNamesUsed.add(name)
          }
          break
        case 'lifecycle':
          if (
            event.phase === 'completed' ||
            event.phase === 'stopped' ||
            event.phase === 'failed'
          ) {
            terminalPhase = event.phase
            if (event.phase === 'failed') failedError = event.error.message
          }
          break
        case 'usage-info':
          // wechat 不展示 usage
          break
      }
    },

    flush() {
      const segments: string[] = []

      // 工具调用摘要
      if (toolNamesUsed.size > 0) {
        const sorted = [...toolNamesUsed].sort()
        segments.push(`🔧 使用了工具: ${sorted.join(', ')}`)
      }

      // assistant 文本拼接 + 分段
      const fullText = assistantTexts.join('\n\n').trim()
      if (fullText) {
        segments.push(...splitText(fullText, TEXT_CHUNK_LIMIT))
      }

      // 失败态追加错误提示
      if (terminalPhase === 'failed' && failedError) {
        const safeError = failedError.split('\n')[0]?.slice(0, 200) ?? '未知错误'
        segments.push(`⚠️ 处理失败：${safeError}`)
      }

      // 没任何输出时，至少回复一条占位文本，避免静默
      if (segments.length === 0) {
        log.warn('flush 时无任何 segment（assistant text 与 tool 调用都为空）')
        segments.push('（本轮无输出）')
      }

      return segments
    },
  }
}

/** 按 \n\n / \n / 硬切 三级策略把超长文本分段 */
export function splitText(text: string, limit: number): string[] {
  if (text.length <= limit) return [text]
  const chunks: string[] = []
  let rest = text
  while (rest.length > 0) {
    if (rest.length <= limit) {
      chunks.push(rest)
      break
    }
    // 优先在 limit 以内的 \n\n 切
    let cut = rest.lastIndexOf('\n\n', limit)
    if (cut <= 0) cut = rest.lastIndexOf('\n', limit)
    if (cut <= 0) cut = limit
    chunks.push(rest.slice(0, cut))
    rest = rest.slice(cut).replace(/^\n+/, '')
  }
  return chunks
}
