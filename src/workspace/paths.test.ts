import { describe, expect, it } from 'vitest'
import { resolveWorkspacePaths, slackSessionDir, sanitizeFsSegment } from './paths.ts'

describe('sanitizeFsSegment', () => {
  it('替换 OS 不合法字符与空白', () => {
    expect(sanitizeFsSegment('a/b\\c:d*e?f"g<h>i|j')).toBe('a_b_c_d_e_f_g_h_i_j')
    expect(sanitizeFsSegment('x y\tz')).toBe('x_y_z')
  })

  it('保留中文 / 数字 / 点 / 连字符 / 下划线', () => {
    expect(sanitizeFsSegment('开发-频道_2026.04')).toBe('开发-频道_2026.04')
  })
})

describe('slackSessionDir', () => {
  it('中文 channelName 被保留', () => {
    const p = resolveWorkspacePaths('/tmp')
    const dir = slackSessionDir(p, '开发频道', 'C123', '17764')
    expect(dir).toMatch(/sessions\/slack\/开发频道\.C123\.17764$/)
  })

  it('含空白 / 斜杠的 channelName 被替换', () => {
    const p = resolveWorkspacePaths('/tmp')
    const dir = slackSessionDir(p, 'hello world/x', 'C', 't')
    expect(dir).toMatch(/sessions\/slack\/hello_world_x\.C\.t$/)
  })
})
