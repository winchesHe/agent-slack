import { tool } from 'ai'
import { z } from 'zod'
import type { ToolContext } from './bash.ts'

export interface CurrentThreadContextResult {
  imProvider: 'slack'
  channelId: string
  channelName: string
  threadTs: string
  messageTs: string
  messagePermalink?: string
  threadPermalink: string
  repliesCommand: string
}

function tsToPermalinkFragment(ts: string): string {
  return `p${ts.replace('.', '')}`
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`
}

function permalinkOrigin(permalink?: string): string {
  if (!permalink) return 'https://slack.com'
  try {
    const url = new URL(permalink)
    return `${url.protocol}//${url.host}`
  } catch {
    return 'https://slack.com'
  }
}

function buildSlackPermalink(channelId: string, ts: string, origin: string): string {
  return `${origin}/archives/${channelId}/${tsToPermalinkFragment(ts)}`
}

/**
 * 返回当前触发消息所在 Slack thread 的权威定位信息。
 * 该工具不读 session 目录，避免“找最新 running session”误命中过往会话。
 */
export function currentThreadContextTool(ctx: Pick<ToolContext, 'currentThread'>) {
  return tool({
    description:
      '返回当前触发本轮 @mention / channel task 的 Slack thread 定位信息（channelId/threadTs/messageTs/permalink）和可直接执行的 slack.py replies 命令。不要通过扫描 .agent-slack/sessions 猜当前会话；需要当前 thread 上下文时先调用本工具。',
    parameters: z.object({}),
    async execute(): Promise<CurrentThreadContextResult> {
      if (!ctx.currentThread) {
        throw new Error('current_thread_context 不可用：当前运行没有 IM thread 上下文')
      }

      const threadPermalink = buildSlackPermalink(
        ctx.currentThread.channelId,
        ctx.currentThread.threadTs,
        permalinkOrigin(ctx.currentThread.messagePermalink),
      )
      return {
        ...ctx.currentThread,
        threadPermalink,
        repliesCommand: `python3 .agent-slack/skills/slack/scripts/slack.py replies --url ${shellQuote(
          threadPermalink,
        )} --limit 50 --output /tmp/current_thread.json`,
      }
    },
  })
}
