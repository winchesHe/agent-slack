import { describe, expect, it } from 'vitest'
import { createRedactor } from './redactor.ts'

describe('redactor', () => {
  it('脱敏已知凭证 key', () => {
    const redactor = createRedactor(['sk-secret', 'xoxb-token'])
    expect(redactor('Bearer sk-secret here')).toBe('Bearer [REDACTED] here')
    expect(redactor('token=xoxb-token&x=1')).toBe('token=[REDACTED]&x=1')
  })

  it('未注册值不脱敏', () => {
    const redactor = createRedactor(['sk-secret'])
    expect(redactor('hello world')).toBe('hello world')
  })

  it('注册空值 / 短值忽略', () => {
    const redactor = createRedactor(['', 'ab'])
    expect(redactor('ab cd')).toBe('ab cd')
  })

  it('遇到任意类型输入都安全', () => {
    const redactor = createRedactor(['sk-secret'])
    expect(redactor({ msg: 'sk-secret' })).toContain('[REDACTED]')
  })

  it('对象里嵌套 Error：序列化时展开 name/message/stack（修复 {err:{}} 黑洞）', () => {
    const redactor = createRedactor([])
    const err = new Error('HTTP 401 ilink/bot/sendmessage')
    const out = redactor({ err })
    expect(out).toContain('HTTP 401')
    expect(out).toContain('"name":"Error"')
  })

  it('对象里嵌套 Error 子类：保留 message 与额外枚举字段', () => {
    const redactor = createRedactor([])
    class MyError extends Error {
      code = 'E_CUSTOM'
    }
    const err = new MyError('boom')
    const out = redactor({ context: 'sendText', err })
    expect(out).toContain('boom')
    expect(out).toContain('E_CUSTOM')
  })
})
