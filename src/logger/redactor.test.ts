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
})
