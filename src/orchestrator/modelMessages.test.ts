import { describe, expect, it } from 'vitest'
import type { CoreMessage } from 'ai'
import {
  MODEL_CONTEXT_PRUNED_NOTICE_TITLE,
  TOOL_RESULT_COMPACTED_NOTICE_TITLE,
  buildModelMessages,
  type ModelMessageBudget,
} from './modelMessages.ts'

const messagesJsonlPath = '/workspace/.agent-slack/sessions/slack/c.C.t/messages.jsonl'
const defaultBudget: ModelMessageBudget = {
  maxApproxChars: 10_000,
  keepRecentMessages: 10,
  keepRecentToolResults: 20,
}

function budget(overrides: Partial<ModelMessageBudget>): ModelMessageBudget {
  return { ...defaultBudget, ...overrides }
}

function user(content: string): CoreMessage {
  return { role: 'user', content }
}

function assistant(content: string): CoreMessage {
  return { role: 'assistant', content }
}

function toolPair(toolCallId: string): CoreMessage[] {
  return [
    {
      role: 'assistant',
      content: [
        {
          type: 'tool-call',
          toolCallId,
          toolName: 'bash',
          args: { cmd: 'echo hello' },
        },
      ],
    },
    {
      role: 'tool',
      content: [
        {
          type: 'tool-result',
          toolCallId,
          toolName: 'bash',
          result: 'hello',
        },
      ],
    },
  ]
}

describe('buildModelMessages', () => {
  it('历史未超过预算时返回完整 history + 当前 user', () => {
    const history = [user('hi'), assistant('hello')]
    const current = user('next')

    const messages = buildModelMessages({
      history,
      userMessage: current,
      budget: defaultBudget,
      messagesJsonlPath,
    })

    expect(messages).toEqual([...history, current])
  })

  it('超过消息数预算时裁剪旧历史并插入真实 messages.jsonl 路径提示', () => {
    const history = [user('old-1'), assistant('old-2'), user('recent-1'), assistant('recent-2')]
    const current = user('current')

    const messages = buildModelMessages({
      history,
      userMessage: current,
      budget: budget({ keepRecentMessages: 3 }),
      messagesJsonlPath,
    })

    expect(messages).toEqual([
      {
        role: 'user',
        content: `${MODEL_CONTEXT_PRUNED_NOTICE_TITLE}\n本次仅加载最近对话片段；完整会话记录仍保存在：${messagesJsonlPath}`,
      },
      user('recent-1'),
      assistant('recent-2'),
      current,
    ])
  })

  it('当前 user message 即使超过字符预算也会保留', () => {
    const current = user('x'.repeat(100))

    const messages = buildModelMessages({
      history: [user('old')],
      userMessage: current,
      budget: budget({ maxApproxChars: 10 }),
      messagesJsonlPath,
    })

    expect(messages).toEqual([
      {
        role: 'user',
        content: `${MODEL_CONTEXT_PRUNED_NOTICE_TITLE}\n本次仅加载最近对话片段；完整会话记录仍保存在：${messagesJsonlPath}`,
      },
      current,
    ])
  })

  it('裁剪边界命中 tool-result 时向前扩展保留匹配 tool-call', () => {
    const pair = toolPair('call_1')
    const toolCall = pair[0]!
    const toolResult = pair[1]!
    const history = [user('old'), toolCall, toolResult, assistant('done')]
    const current = user('current')

    const messages = buildModelMessages({
      history,
      userMessage: current,
      budget: budget({ keepRecentMessages: 3 }),
      messagesJsonlPath,
    })

    expect(messages).toEqual([
      {
        role: 'user',
        content: `${MODEL_CONTEXT_PRUNED_NOTICE_TITLE}\n本次仅加载最近对话片段；完整会话记录仍保存在：${messagesJsonlPath}`,
      },
      toolCall,
      toolResult,
      assistant('done'),
      current,
    ])
  })

  it('tool pair 扩展到历史开头时不插入裁剪提示', () => {
    const pair = toolPair('call_1')
    const history = [pair[0]!, pair[1]!]
    const current = user('current')

    const messages = buildModelMessages({
      history,
      userMessage: current,
      budget: budget({ keepRecentMessages: 2 }),
      messagesJsonlPath,
    })

    expect(messages).toEqual([...history, current])
  })

  it('可按字符预算裁剪长历史', () => {
    const history = [user('a'.repeat(80)), assistant('b'), user('c')]
    const current = user('current')

    const messages = buildModelMessages({
      history,
      userMessage: current,
      budget: budget({ maxApproxChars: 120 }),
      messagesJsonlPath,
    })

    expect(messages[0]?.role).toBe('user')
    expect(messages[0]?.content).toContain(MODEL_CONTEXT_PRUNED_NOTICE_TITLE)
    expect(messages).toContainEqual(user('c'))
    expect(messages).toContainEqual(current)
    expect(messages).not.toContainEqual(user('a'.repeat(80)))
  })

  it('仅在模型视图中压缩旧 tool-result，保留最近 N 个完整结果', () => {
    const oldPair = toolPair('call_old')
    const recentPair = toolPair('call_recent')
    const history = [oldPair[0]!, oldPair[1]!, recentPair[0]!, recentPair[1]!]
    const current = user('current')

    const messages = buildModelMessages({
      history,
      userMessage: current,
      budget: budget({ keepRecentToolResults: 1 }),
      messagesJsonlPath,
    })

    expect(messages).toHaveLength(5)
    expect(messages[0]).toEqual(oldPair[0])
    expect(messages[1]).toMatchObject({
      role: 'tool',
      content: [
        {
          type: 'tool-result',
          toolCallId: 'call_old',
          toolName: 'bash',
          result: `${TOOL_RESULT_COMPACTED_NOTICE_TITLE}；完整内容保存在：${messagesJsonlPath}`,
        },
      ],
    })
    expect(messages[2]).toEqual(recentPair[0])
    expect(messages[3]).toEqual(recentPair[1])
    expect(history[1]).toEqual(oldPair[1])
  })

  it('压缩旧 tool-result 时仍保留 tool-call / tool-result 配对结构', () => {
    const pair = toolPair('call_1')
    const messages = buildModelMessages({
      history: [pair[0]!, pair[1]!],
      userMessage: user('current'),
      budget: budget({ keepRecentToolResults: 1 }),
      messagesJsonlPath,
    })

    expect(messages).toEqual([pair[0], pair[1], user('current')])
  })
})
