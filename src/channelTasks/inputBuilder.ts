import type { ChannelTaskMatch } from './matcher.ts'

export interface BuildChannelTaskInputArgs {
  match: ChannelTaskMatch
  permalink?: string
}

export function buildChannelTaskInput(args: BuildChannelTaskInputArgs): string {
  const { match } = args
  const lines = [
    `[频道任务触发: ${match.rule.id}]`,
    '',
    '任务说明：',
    match.rule.task.prompt.trim(),
    '',
    '触发信息：',
    `- channelId: ${match.channelId}`,
    `- messageTs: ${match.messageTs}`,
    `- threadTs: ${match.threadTs}`,
    `- actorType: ${match.actor.type}`,
    `- actorId: ${match.actor.id}`,
    `- matchedBy: ${match.actor.matchedBy}`,
  ]

  if (match.rule.task.includePermalink && args.permalink) {
    lines.push(`- permalink: ${args.permalink}`)
  }

  if (match.rule.task.includeOriginalMessage) {
    lines.push(
      '',
      '原始 Slack 消息：',
      match.text.trim().length > 0 ? match.text : '（无文本内容）',
    )
  }

  return lines.join('\n')
}
