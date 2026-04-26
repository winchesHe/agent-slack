import { describe, expect, it } from 'vitest'
import { parseChannelTasksConfig } from './config.ts'
import { matchChannelTaskRules, type SlackChannelTaskMessageEvent } from './matcher.ts'

function configWithRule(rule: Record<string, unknown> = {}) {
  return parseChannelTasksConfig({
    enabled: true,
    rules: [
      {
        id: 'rule-1',
        channelIds: ['C1'],
        source: { userIds: ['U1'] },
        task: { prompt: '处理消息' },
        ...rule,
      },
    ],
  })
}

function rootUserEvent(
  overrides: Partial<SlackChannelTaskMessageEvent> = {},
): SlackChannelTaskMessageEvent {
  return {
    channel: 'C1',
    ts: '1000.0001',
    user: 'U1',
    text: 'hello',
    ...overrides,
  }
}

function rootBotEvent(
  overrides: Partial<SlackChannelTaskMessageEvent> = {},
): SlackChannelTaskMessageEvent {
  return {
    channel: 'C1',
    ts: '1000.0001',
    subtype: 'bot_message',
    text: 'bot says hello',
    ...overrides,
  }
}

describe('matchChannelTaskRules', () => {
  it('匹配指定频道和用户的根消息', () => {
    const matches = matchChannelTaskRules(configWithRule({}), rootUserEvent())
    expect(matches).toHaveLength(1)
    expect(matches[0]).toMatchObject({
      channelId: 'C1',
      messageTs: '1000.0001',
      threadTs: '1000.0001',
      subtype: 'none',
      isThreadReply: false,
      actor: { type: 'user', id: 'U1', matchedBy: 'userId' },
    })
  })

  it('全局 disabled 或规则 disabled 时不匹配', () => {
    const disabledConfig = parseChannelTasksConfig({
      enabled: false,
      rules: [
        {
          id: 'rule-1',
          channelIds: ['C1'],
          source: { userIds: ['U1'] },
          task: { prompt: '处理消息' },
        },
      ],
    })
    expect(matchChannelTaskRules(disabledConfig, rootUserEvent())).toEqual([])
    expect(matchChannelTaskRules(configWithRule({ enabled: false }), rootUserEvent())).toEqual([])
  })

  it('频道或用户不在 allowlist 时不匹配', () => {
    expect(matchChannelTaskRules(configWithRule({}), rootUserEvent({ channel: 'C2' }))).toEqual([])
    expect(matchChannelTaskRules(configWithRule({}), rootUserEvent({ user: 'U2' }))).toEqual([])
  })

  it('默认跳过 thread 回复，显式开启后匹配并沿用原 threadTs', () => {
    const threadReply = rootUserEvent({ ts: '1000.0002', thread_ts: '1000.0001' })

    expect(matchChannelTaskRules(configWithRule({}), threadReply)).toEqual([])

    const matches = matchChannelTaskRules(
      configWithRule({ message: { includeThreadReplies: true } }),
      threadReply,
    )
    expect(matches).toHaveLength(1)
    expect(matches[0]?.threadTs).toBe('1000.0001')
    expect(matches[0]?.isThreadReply).toBe(true)
  })

  it('默认忽略包含当前 agent mention 的消息', () => {
    const event = rootUserEvent({ text: '<@U_AGENT> hello' })
    expect(matchChannelTaskRules(configWithRule({}), event, { agentUserId: 'U_AGENT' })).toEqual([])

    const matches = matchChannelTaskRules(
      configWithRule({ message: { ignoreAgentMentions: false } }),
      event,
      { agentUserId: 'U_AGENT' },
    )
    expect(matches).toHaveLength(1)
  })

  it('按 containsAny 或 regexAny 做文本过滤', () => {
    expect(
      matchChannelTaskRules(
        configWithRule({ match: { containsAny: ['日报'], regexAny: ['urgent:\\s*yes'] } }),
        rootUserEvent({ text: '今日日报' }),
      ),
    ).toHaveLength(1)

    expect(
      matchChannelTaskRules(
        configWithRule({ match: { containsAny: ['日报'], regexAny: ['urgent:\\s*yes'] } }),
        rootUserEvent({ text: 'urgent: yes' }),
      ),
    ).toHaveLength(1)

    expect(
      matchChannelTaskRules(
        configWithRule({ match: { containsAny: ['日报'], regexAny: ['urgent:\\s*yes'] } }),
        rootUserEvent({ text: '普通消息' }),
      ),
    ).toEqual([])
  })

  it('匹配 bot_message 的 bot_id 或 app_id', () => {
    const byBotId = matchChannelTaskRules(
      configWithRule({
        source: {
          includeUserMessages: false,
          includeBotMessages: true,
          botIds: ['B1'],
          appIds: [],
        },
        message: { allowSubtypes: ['bot_message'] },
      }),
      rootBotEvent({ bot_id: 'B1', app_id: 'A1' }),
    )
    expect(byBotId[0]?.actor).toEqual({ type: 'bot', id: 'B1', matchedBy: 'botId' })

    const byAppId = matchChannelTaskRules(
      configWithRule({
        source: {
          includeUserMessages: false,
          includeBotMessages: true,
          botIds: [],
          appIds: ['A1'],
        },
        message: { allowSubtypes: ['bot_message'] },
      }),
      rootBotEvent({ bot_id: 'B2', app_id: 'A1' }),
    )
    expect(byAppId[0]?.actor).toEqual({ type: 'bot', id: 'A1', matchedBy: 'appId' })
  })

  it('subtype 缺失但存在 bot_id 或 app_id 时按 bot_message 匹配', () => {
    const matches = matchChannelTaskRules(
      configWithRule({
        source: {
          includeUserMessages: false,
          includeBotMessages: true,
          botIds: ['B1'],
          appIds: [],
        },
        message: { allowSubtypes: ['bot_message'] },
      }),
      {
        channel: 'C1',
        ts: '1000.0001',
        text: 'bot says hello',
        bot_id: 'B1',
      },
    )

    expect(matches[0]).toMatchObject({
      subtype: 'bot_message',
      actor: { type: 'bot', id: 'B1', matchedBy: 'botId' },
    })
  })

  it('subtype 缺失且同时有 user 与 bot_id 时，仍可按 userIds 匹配用户来源', () => {
    const matches = matchChannelTaskRules(
      configWithRule({}),
      rootUserEvent({ bot_id: 'B1', app_id: 'A1' }),
    )

    expect(matches[0]).toMatchObject({
      subtype: 'none',
      actor: { type: 'user', id: 'U1', matchedBy: 'userId' },
    })
  })

  it('bot_message 需要显式允许 subtype 和 bot 来源', () => {
    const event = rootBotEvent({ bot_id: 'B1' })

    expect(
      matchChannelTaskRules(
        configWithRule({
          source: { includeUserMessages: false, includeBotMessages: true, botIds: ['B1'] },
        }),
        event,
      ),
    ).toEqual([])

    expect(
      matchChannelTaskRules(
        configWithRule({
          source: { includeUserMessages: false, includeBotMessages: true, botIds: ['B2'] },
          message: { allowSubtypes: ['bot_message'] },
        }),
        event,
      ),
    ).toEqual([])
  })

  it('requireText=true 时跳过空文本，关闭后可匹配', () => {
    expect(matchChannelTaskRules(configWithRule({}), rootUserEvent({ text: '' }))).toEqual([])
    expect(
      matchChannelTaskRules(
        configWithRule({ message: { requireText: false } }),
        rootUserEvent({ text: '' }),
      ),
    ).toHaveLength(1)
  })
})
