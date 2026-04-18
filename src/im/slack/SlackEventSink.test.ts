import { describe, expect, it } from 'vitest'
import type { WebClient } from '@slack/web-api'
import { createSlackEventSink } from './SlackEventSink.ts'
import type { Logger } from '@/logger/logger.ts'

function stubLogger(): Logger {
  const l: Logger = {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
    withTag: () => stubLogger(),
  }
  return l
}

interface UpdateCall {
  channel: string
  ts: string
  text: string
}

interface ReactionCall {
  channel: string
  timestamp: string
  name: string
}

function mockWeb(): {
  web: WebClient
  updates: UpdateCall[]
  reactions: ReactionCall[]
} {
  const updates: UpdateCall[] = []
  const reactions: ReactionCall[] = []
  const web = {
    chat: {
      update: async (args: UpdateCall) => {
        updates.push(args)
        return { ok: true }
      },
    },
    reactions: {
      add: async (args: ReactionCall) => {
        reactions.push(args)
        return { ok: true }
      },
    },
  } as unknown as WebClient
  return { web, updates, reactions }
}

describe('SlackEventSink', () => {
  it('done 用 finalText 更新并加 reaction', async () => {
    const { web, updates, reactions } = mockWeb()
    const sink = createSlackEventSink({
      web,
      channelId: 'C1',
      threadTs: 't1',
      placeholderTs: 'p1',
      logger: stubLogger(),
    })
    sink.emit({ type: 'text_delta', text: 'hello' })
    await sink.done()
    expect(updates.at(-1)?.text).toBe('hello')
    expect(reactions[0]).toMatchObject({ name: 'white_check_mark' })
  })

  it('fail 把消息改为错误并加 x reaction', async () => {
    const { web, updates, reactions } = mockWeb()
    const sink = createSlackEventSink({
      web,
      channelId: 'C1',
      threadTs: 't1',
      placeholderTs: 'p1',
      logger: stubLogger(),
    })
    await sink.fail(new Error('boom'))
    expect(updates[0]?.text).toContain('boom')
    expect(reactions[0]).toMatchObject({ name: 'x' })
  })
})
