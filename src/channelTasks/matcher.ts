import type { ChannelTaskMessageSubtype, ChannelTaskRule, ChannelTasksConfig } from './config.ts'

export interface SlackChannelTaskMessageEvent {
  channel: string
  ts: string
  text?: string
  user?: string
  subtype?: string
  thread_ts?: string
  bot_id?: string
  app_id?: string
  username?: string
}

export type ChannelTaskActor =
  | { type: 'user'; id: string; matchedBy: 'userId' }
  | { type: 'bot'; id: string; matchedBy: 'botId' | 'appId' }

export interface ChannelTaskMatch {
  rule: ChannelTaskRule
  channelId: string
  messageTs: string
  threadTs: string
  text: string
  subtype: ChannelTaskMessageSubtype
  isThreadReply: boolean
  actor: ChannelTaskActor
}

export interface MatchChannelTaskRulesOptions {
  agentUserId?: string
}

export function matchChannelTaskRules(
  config: ChannelTasksConfig,
  event: SlackChannelTaskMessageEvent,
  options: MatchChannelTaskRulesOptions = {},
): ChannelTaskMatch[] {
  if (!config.enabled) return []

  const subtype = normalizeSubtype(event.subtype)
  if (!subtype) return []

  const text = event.text ?? ''
  const isThreadReply = Boolean(event.thread_ts && event.thread_ts !== event.ts)
  const threadTs = event.thread_ts ?? event.ts
  const matches: ChannelTaskMatch[] = []

  for (const rule of config.rules) {
    if (!rule.enabled) continue
    if (!rule.channelIds.includes(event.channel)) continue
    if (!rule.message.allowSubtypes.includes(subtype)) continue
    if (!matchesMessageScope(rule, isThreadReply)) continue
    if (rule.message.requireText && text.trim().length === 0) continue
    if (rule.message.ignoreAgentMentions && includesAgentMention(text, options.agentUserId)) {
      continue
    }

    const actor = resolveActor(rule, event, subtype)
    if (!actor) continue
    if (!matchesText(rule, text)) continue

    matches.push({
      rule,
      channelId: event.channel,
      messageTs: event.ts,
      threadTs,
      text,
      subtype,
      isThreadReply,
      actor,
    })
  }

  return matches
}

function normalizeSubtype(subtype: string | undefined): ChannelTaskMessageSubtype | undefined {
  if (subtype === undefined) return 'none'
  if (subtype === 'bot_message') return 'bot_message'
  return undefined
}

function matchesMessageScope(rule: ChannelTaskRule, isThreadReply: boolean): boolean {
  if (isThreadReply) return rule.message.includeThreadReplies
  return rule.message.includeRootMessages
}

function resolveActor(
  rule: ChannelTaskRule,
  event: SlackChannelTaskMessageEvent,
  subtype: ChannelTaskMessageSubtype,
): ChannelTaskActor | undefined {
  if (subtype === 'bot_message') {
    if (!rule.source.includeBotMessages) return undefined
    if (event.bot_id && rule.source.botIds.includes(event.bot_id)) {
      return { type: 'bot', id: event.bot_id, matchedBy: 'botId' }
    }
    if (event.app_id && rule.source.appIds.includes(event.app_id)) {
      return { type: 'bot', id: event.app_id, matchedBy: 'appId' }
    }
    return undefined
  }

  if (!rule.source.includeUserMessages || !event.user) return undefined
  if (!rule.source.userIds.includes(event.user)) return undefined
  return { type: 'user', id: event.user, matchedBy: 'userId' }
}

function matchesText(rule: ChannelTaskRule, text: string): boolean {
  const containsMatches =
    rule.match.containsAny.length > 0 &&
    rule.match.containsAny.some((needle) => text.includes(needle))
  const regexMatches =
    rule.match.regexAny.length > 0 &&
    rule.match.regexAny.some((pattern) => new RegExp(pattern).test(text))

  if (rule.match.containsAny.length === 0 && rule.match.regexAny.length === 0) {
    return true
  }
  return containsMatches || regexMatches
}

function includesAgentMention(text: string, agentUserId: string | undefined): boolean {
  if (!agentUserId) return false
  return new RegExp(`<@${escapeRegExp(agentUserId)}(?:\\|[^>]+)?>`).test(text)
}

function escapeRegExp(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
