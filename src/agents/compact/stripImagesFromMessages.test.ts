import { describe, expect, it } from 'vitest'
import type { CoreMessage } from 'ai'
import { stripImagesFromMessages } from './stripImagesFromMessages.ts'

describe('stripImagesFromMessages', () => {
  it('user content 中的 image part 被替换为占位文本', () => {
    const msgs: CoreMessage[] = [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'check this' },
          { type: 'image', image: 'base64data' },
        ],
      },
    ]
    const out = stripImagesFromMessages(msgs)
    expect(out[0]?.content).toEqual([
      { type: 'text', text: 'check this' },
      { type: 'text', text: '[image]' },
    ])
  })

  it('user content 中的 file part 被替换为占位文本', () => {
    const msgs: CoreMessage[] = [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'review' },
          { type: 'file', data: 'pdfdata', mimeType: 'application/pdf' },
        ],
      },
    ]
    const out = stripImagesFromMessages(msgs)
    expect(out[0]?.content).toEqual([
      { type: 'text', text: 'review' },
      { type: 'text', text: '[document]' },
    ])
  })

  it('tool_result.experimental_content 中的 image 被替换为占位文本', () => {
    const msgs: CoreMessage[] = [
      {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: 't1',
            toolName: 'bash',
            result: 'output',
            experimental_content: [
              { type: 'text', text: 'output' },
              { type: 'image', data: 'imgdata' },
            ],
          },
        ],
      },
    ]
    const out = stripImagesFromMessages(msgs)
    const part = (out[0]?.content as Array<{ experimental_content?: unknown }>)[0]
    expect(part?.experimental_content).toEqual([
      { type: 'text', text: 'output' },
      { type: 'text', text: '[image]' },
    ])
  })

  it('tool_result.result 为数组且含 image/file 时同样剥离', () => {
    const msgs: CoreMessage[] = [
      {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: 't1',
            toolName: 'bash',
            result: [
              { type: 'text', text: 'output' },
              { type: 'image', image: 'imgdata' },
              { type: 'file', data: 'filedata', mimeType: 'application/pdf' },
            ] as unknown,
          },
        ],
      },
    ]
    const out = stripImagesFromMessages(msgs)
    const part = (out[0]?.content as Array<{ result: unknown }>)[0]
    expect(part?.result).toEqual([
      { type: 'text', text: 'output' },
      { type: 'text', text: '[image]' },
      { type: 'text', text: '[document]' },
    ])
  })

  it('纯文本消息原样返回（同一引用）', () => {
    const msgs: CoreMessage[] = [{ role: 'user', content: 'plain text' }]
    expect(stripImagesFromMessages(msgs)).toEqual(msgs)
  })

  it('空数组返回空数组', () => {
    expect(stripImagesFromMessages([])).toEqual([])
  })
})
