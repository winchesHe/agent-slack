import { describe, expect, it } from 'vitest'
import { parseChannelTasksConfig } from './config.ts'
import { buildChannelTaskInput } from './inputBuilder.ts'
import { matchChannelTaskRules } from './matcher.ts'

function firstMatch(includeOriginalMessage = true, includePermalink = true) {
  const config = parseChannelTasksConfig({
    enabled: true,
    rules: [
      {
        id: 'summarize',
        channelIds: ['C1'],
        source: { userIds: ['U1'] },
        task: {
          prompt: '请总结这条消息',
          includeOriginalMessage,
          includePermalink,
        },
      },
    ],
  })
  const match = matchChannelTaskRules(config, {
    channel: 'C1',
    ts: '1000.0001',
    user: 'U1',
    text: '这是一条需要总结的 Slack 消息',
  })[0]
  if (!match) throw new Error('expected match')
  return match
}

describe('buildChannelTaskInput', () => {
  it('构造包含任务说明、触发信息和原始消息的中文输入', () => {
    const input = buildChannelTaskInput({
      match: firstMatch(),
      permalink: 'https://example.slack.com/archives/C1/p10000001',
    })

    expect(input).toContain('[频道任务触发: summarize]')
    expect(input).toContain('任务说明：\n请总结这条消息')
    expect(input).toContain('- channelId: C1')
    expect(input).toContain('- messageTs: 1000.0001')
    expect(input).toContain('- actorType: user')
    expect(input).toContain('- actorId: U1')
    expect(input).toContain('- matchedBy: userId')
    expect(input).toContain('- permalink: https://example.slack.com/archives/C1/p10000001')
    expect(input).toContain('原始 Slack 消息：\n这是一条需要总结的 Slack 消息')
  })

  it('可按配置省略原始消息和 permalink', () => {
    const input = buildChannelTaskInput({
      match: firstMatch(false, false),
      permalink: 'https://example.slack.com/archives/C1/p10000001',
    })

    expect(input).toContain('任务说明：\n请总结这条消息')
    expect(input).not.toContain('原始 Slack 消息')
    expect(input).not.toContain('permalink')
  })

  it('允许无文本消息输出占位', () => {
    const config = parseChannelTasksConfig({
      enabled: true,
      rules: [
        {
          id: 'file-signal',
          channelIds: ['C1'],
          source: { userIds: ['U1'] },
          message: { requireText: false },
          task: { prompt: '处理这个信号' },
        },
      ],
    })
    const match = matchChannelTaskRules(config, {
      channel: 'C1',
      ts: '1000.0001',
      user: 'U1',
      text: '',
    })[0]
    if (!match) throw new Error('expected match')

    expect(buildChannelTaskInput({ match })).toContain('原始 Slack 消息：\n（无文本内容）')
  })
})
