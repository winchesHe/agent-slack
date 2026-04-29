import { describe, expect, it } from 'vitest'
import YAML from 'yaml'
import { CHANNEL_TASKS_CONFIG_TEMPLATE, parseChannelTasksConfig } from './config.ts'

describe('parseChannelTasksConfig', () => {
  it('空配置默认关闭且无规则', () => {
    expect(parseChannelTasksConfig({})).toEqual({
      version: 1,
      enabled: false,
      rules: [],
    })
  })

  it('中文注释模板可解析（含 daily-watch + bot-alert-watch 两条规则）', () => {
    const parsed = parseChannelTasksConfig(YAML.parse(CHANNEL_TASKS_CONFIG_TEMPLATE))
    expect(parsed.enabled).toBe(false)
    expect(parsed.rules.map((r) => r.id)).toEqual(['daily-watch', 'bot-alert-watch'])
    expect(parsed.rules[0]).toMatchObject({
      id: 'daily-watch',
      enabled: false,
      channelIds: ['C0123456789'],
      source: {
        includeUserMessages: true,
        includeBotMessages: false,
        userIds: ['U0123456789'],
        botIds: [],
        appIds: [],
      },
      message: {
        allowSubtypes: ['none'],
        ignoreAgentMentions: true,
      },
    })
    expect(parsed.rules[1]).toMatchObject({
      id: 'bot-alert-watch',
      source: {
        includeBotMessages: true,
        botIds: ['B0123456789'],
        appIds: ['A0123456789'],
      },
      message: { allowSubtypes: ['bot_message'] },
      match: { containsAny: ['ALERT', '告警'] },
    })
  })

  it('启用规则时合并默认字段', () => {
    const parsed = parseChannelTasksConfig({
      enabled: true,
      rules: [
        {
          id: 'daily',
          channelIds: ['C1'],
          source: { userIds: ['U1'] },
          task: { prompt: '处理消息' },
        },
      ],
    })

    expect(parsed.rules[0]).toMatchObject({
      enabled: true,
      source: {
        includeUserMessages: true,
        includeBotMessages: false,
        userIds: ['U1'],
        botIds: [],
        appIds: [],
      },
      message: {
        includeRootMessages: true,
        includeThreadReplies: false,
        allowSubtypes: ['none'],
        requireText: true,
        ignoreAgentMentions: true,
      },
      match: {
        containsAny: [],
        regexAny: [],
      },
      reply: {
        inThread: true,
      },
      dedupe: {
        enabled: true,
      },
    })
  })

  it('重复规则 id 报错', () => {
    expect(() =>
      parseChannelTasksConfig({
        enabled: true,
        rules: [
          {
            id: 'dup',
            channelIds: ['C1'],
            source: { userIds: ['U1'] },
            task: { prompt: 'A' },
          },
          {
            id: 'dup',
            channelIds: ['C2'],
            source: { userIds: ['U2'] },
            task: { prompt: 'B' },
          },
        ],
      }),
    ).toThrow(/重复的规则 id/)
  })

  it('启用规则必须配置可匹配来源', () => {
    expect(() =>
      parseChannelTasksConfig({
        enabled: true,
        rules: [
          {
            id: 'no-source',
            channelIds: ['C1'],
            source: { includeUserMessages: true, userIds: [] },
            task: { prompt: '处理' },
          },
        ],
      }),
    ).toThrow(/至少配置一个可匹配/)
  })

  it('非法 regexAny 保存前报错', () => {
    expect(() =>
      parseChannelTasksConfig({
        enabled: true,
        rules: [
          {
            id: 'bad-regex',
            channelIds: ['C1'],
            source: { userIds: ['U1'] },
            match: { regexAny: ['['] },
            task: { prompt: '处理' },
          },
        ],
      }),
    ).toThrow(/非法正则表达式/)
  })

  it('reply.inThread 本阶段只能为 true', () => {
    expect(() =>
      parseChannelTasksConfig({
        enabled: true,
        rules: [
          {
            id: 'root-reply',
            channelIds: ['C1'],
            source: { userIds: ['U1'] },
            task: { prompt: '处理' },
            reply: { inThread: false },
          },
        ],
      }),
    ).toThrow()
  })
})
