import { describe, it, expect } from 'vitest'
import {
  createTelegramRenderer,
  escapeHtml,
  markdownToHtml,
  splitText,
  tableToHtmlList,
} from './TelegramRenderer.ts'
import type { AgentExecutionEvent } from '@/core/events.ts'

const fakeLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  withTag: () => fakeLogger,
} as never

describe('escapeHtml', () => {
  it('转义 < > &', () => {
    expect(escapeHtml('a<b>c&d')).toBe('a&lt;b&gt;c&amp;d')
  })
  it('& 必须先转，避免重复转义', () => {
    expect(escapeHtml('&lt;')).toBe('&amp;lt;')
  })
})

describe('markdownToHtml', () => {
  it('# title → <b>', () => {
    expect(markdownToHtml('# hello')).toBe('<b>hello</b>')
  })
  it('## title → <b>', () => {
    expect(markdownToHtml('## hi')).toBe('<b>hi</b>')
  })
  it('[text](url) → <a>', () => {
    expect(markdownToHtml('see [Foo](https://example.com/x)')).toBe(
      'see <a href="https://example.com/x">Foo</a>',
    )
  })
  it('链接 url 与 text 内 < > & 都被 escape', () => {
    expect(markdownToHtml('[a&b](https://x.com/?q=1&r=2)')).toContain(
      '<a href="https://x.com/?q=1&amp;r=2">a&amp;b</a>',
    )
  })
  it('表格转结构化列表：单元格 → <b> + 描述 + 链接', () => {
    const md = '| # | 标题 | 简述 | 链接 |\n|---|---|---|---|\n| 1 | Foo | bar | https://x.com/a |\n\n后续段落'
    const html = markdownToHtml(md)
    // 不再用 <pre>
    expect(html).not.toContain('<pre>')
    // 编号 + 标题加粗
    expect(html).toContain('<b>1. Foo</b>')
    // 描述独立成行
    expect(html).toContain('bar')
    // 链接可点击
    expect(html).toContain('🔗 <a href="https://x.com/a">https://x.com/a</a>')
    // 后续段落保留
    expect(html).toContain('后续段落')
  })

  it('两列表格：第一列加粗 + 第二列', () => {
    const md = '| 仓库 | 状态 |\n|---|---|\n| moego | ✅ pulled +3 |'
    const html = markdownToHtml(md)
    expect(html).toContain('<b>moego</b>')
    expect(html).toContain('✅ pulled +3')
  })

  it('表格无分隔符 → 回退 <pre>（防御性）', () => {
    const md = '| a | b |\n| 1 | 2 |'  // 缺 |---|---|
    const html = markdownToHtml(md)
    expect(html).toContain('<pre>')
  })

  it('表格 URL 列为 "-" 不加链接', () => {
    const md = '| 标题 | 链接 |\n|---|---|\n| Foo | - |'
    const html = markdownToHtml(md)
    expect(html).not.toContain('href')
  })
  it('``` 代码块包成 <pre>', () => {
    const md = '```\nconst x = 1\n```'
    expect(markdownToHtml(md)).toBe('<pre>const x = 1</pre>')
  })
  it('普通行字符 escape', () => {
    expect(markdownToHtml('a < b > c & d')).toBe('a &lt; b &gt; c &amp; d')
  })
  it('混合：标题 + 链接 + 表格 一起', () => {
    const md = '# 标题\n\n[L](https://x.com/a)\n\n| col |\n|---|\n| v |'
    const html = markdownToHtml(md)
    expect(html).toContain('<b>标题</b>')
    expect(html).toContain('<a href="https://x.com/a">L</a>')
    // 单列单行 → <b>v</b>
    expect(html).toContain('<b>v</b>')
  })

  // ── 行内强调 / 斜体 / inline code ────────────────────
  it('**bold** → <b>', () => {
    expect(markdownToHtml('say **hello**')).toBe('say <b>hello</b>')
  })
  it('__bold__ → <b>', () => {
    expect(markdownToHtml('say __hi__')).toBe('say <b>hi</b>')
  })
  it('*italic* → <i>', () => {
    expect(markdownToHtml('a *yes* b')).toBe('a <i>yes</i> b')
  })
  it('_italic_ → <i>', () => {
    expect(markdownToHtml('a _yes_ b')).toBe('a <i>yes</i> b')
  })
  it('`code` → <code>', () => {
    expect(markdownToHtml('try `npm install`')).toBe('try <code>npm install</code>')
  })
  it('混合 **bold** + *italic* + `code` 同行', () => {
    const html = markdownToHtml('**title** with *emph* and `code`')
    expect(html).toBe('<b>title</b> with <i>emph</i> and <code>code</code>')
  })
  it('snake_case 中的 _ 不被识别为斜体', () => {
    expect(markdownToHtml('var snake_case_name = 1')).toBe('var snake_case_name = 1')
  })
  it('数字相邻的 * 不被识别为斜体（如 2*3=6）', () => {
    expect(markdownToHtml('compute 2*3=6')).toBe('compute 2*3=6')
  })
  it('代码块内的 ** 不被强调（先 code 后 emphasis）', () => {
    expect(markdownToHtml('see `**raw**` here')).toBe('see <code>**raw**</code> here')
  })
  it('链接内的 ** 不被强调', () => {
    const html = markdownToHtml('[**txt**](https://x.com/a)')
    expect(html).toBe('<a href="https://x.com/a">**txt**</a>')
  })

  // ── 行级 markdown：引用 / 列表 ────────────────────
  it('> blockquote → <blockquote>', () => {
    expect(markdownToHtml('> quoted text')).toBe('<blockquote>quoted text</blockquote>')
  })
  it('blockquote 内可含 **bold**', () => {
    expect(markdownToHtml('> **important**')).toBe(
      '<blockquote><b>important</b></blockquote>',
    )
  })
  it('无序列表 - x → • x', () => {
    expect(markdownToHtml('- item one\n- item two')).toBe('• item one\n• item two')
  })
  it('无序列表 * x → • x', () => {
    expect(markdownToHtml('* a')).toBe('• a')
  })
  it('无序列表 + x → • x', () => {
    expect(markdownToHtml('+ a')).toBe('• a')
  })
  it('无序列表保留缩进', () => {
    expect(markdownToHtml('  - nested')).toBe('  • nested')
  })
  it('有序列表 1. x → 1. x（保留）', () => {
    expect(markdownToHtml('1. first\n2. second')).toBe('1. first\n2. second')
  })
  it('有序列表内含 **bold**', () => {
    expect(markdownToHtml('1. **first**')).toBe('1. <b>first</b>')
  })
  it('普通数字句子 不被识别为有序列表（缺空格）', () => {
    expect(markdownToHtml('版本 1.2.3 发布')).toBe('版本 1.2.3 发布')
  })
})

describe('tableToHtmlList (单元测试)', () => {
  it('aihot 风格：编号 + 标题 + 描述 + URL', () => {
    const out = tableToHtmlList([
      '| # | 标题 | 简述 | 链接 |',
      '|---|---|---|---|',
      '| 1 | Foo | bar | https://x.com/a |',
      '| 2 | Baz | qux | https://x.com/b |',
    ])
    expect(out).toContain('<b>1. Foo</b>')
    expect(out).toContain('<b>2. Baz</b>')
    expect(out).toContain('bar')
    expect(out).toContain('qux')
    expect(out).toContain('🔗 <a href="https://x.com/a">https://x.com/a</a>')
    // 各 item 之间空行
    expect(out!.split('\n\n')).toHaveLength(2)
  })

  it('repo 风格：仓库名 + 状态', () => {
    const out = tableToHtmlList([
      '| 仓库 | 状态 |',
      '|---|---|',
      '| moego | ✅ pulled +3 |',
      '| moego-bff | ⏭ 跳过 |',
    ])
    expect(out).toContain('<b>moego</b>\n✅ pulled +3')
    expect(out).toContain('<b>moego-bff</b>\n⏭ 跳过')
  })

  it('缺 separator → null', () => {
    expect(tableToHtmlList(['| a | b |', '| 1 | 2 |'])).toBeNull()
  })

  it('数据行 0 条 → null', () => {
    expect(tableToHtmlList(['| a | b |', '|---|---|'])).toBeNull()
  })
})

describe('splitText', () => {
  it('短文本不切', () => {
    expect(splitText('hello', 100)).toEqual(['hello'])
  })
  it('按 \\n\\n 切', () => {
    const text = ['aaaa', 'bbbb', 'cccc'].join('\n\n')
    const chunks = splitText(text, 10) // 10 字符
    // 每段 4 字符，应被 \n\n 切成至少 2 段
    expect(chunks.length).toBeGreaterThanOrEqual(2)
    expect(chunks.join('\n\n')).toBe(text)
  })
  it('按 \\n 切（无 \\n\\n 时）', () => {
    const text = 'aaaa\nbbbb\ncccc\ndddd'
    const chunks = splitText(text, 10)
    expect(chunks.length).toBeGreaterThanOrEqual(2)
    chunks.forEach((c) => expect(c.length).toBeLessThanOrEqual(10))
  })
  it('硬切：单行无 \\n 也无 \\n\\n', () => {
    const text = 'a'.repeat(100)
    const chunks = splitText(text, 30)
    expect(chunks.length).toBeGreaterThanOrEqual(4)
    chunks.forEach((c) => expect(c.length).toBeLessThanOrEqual(30))
    expect(chunks.join('')).toBe(text)
  })
  it('代理对（emoji）不被截断', () => {
    // 每个 emoji 是 2 个 UTF-16 code unit
    const text = '😀'.repeat(50) // 100 个 utf-16 code units
    const chunks = splitText(text, 21) // 奇数 limit，硬切若按 utf-16 会断
    chunks.forEach((c) => {
      // 每段 emoji 数量要是整数（不被截到代理对中间）
      expect([...c].length * 2).toBe(c.length)
    })
  })
})

describe('createTelegramRenderer', () => {
  it('累积 assistant text 后 flush 输出 chunks', () => {
    const r = createTelegramRenderer({ logger: fakeLogger })
    r.onEvent({ type: 'assistant-message', text: '# hi' } as AgentExecutionEvent)
    const segs = r.flush()
    expect(segs).toContain('<b>hi</b>')
  })
  it('无任何输出时给占位文本', () => {
    const r = createTelegramRenderer({ logger: fakeLogger })
    expect(r.flush()).toEqual(['（本轮无输出）'])
  })
  it('flush 不再输出 "🔧 使用了工具" 摘要（progress 容器已显示过）', () => {
    const r = createTelegramRenderer({ logger: fakeLogger })
    r.onEvent({
      type: 'activity-state',
      state: { clear: false, newToolCalls: ['bash', 'read'] },
    } as AgentExecutionEvent)
    r.onEvent({ type: 'assistant-message', text: 'hi' } as AgentExecutionEvent)
    const segs = r.flush()
    expect(segs.some((s) => s.includes('使用了工具'))).toBe(false)
  })

  it('newToolCalls 是 toolDisplayLabel 形式（如 bash(cmd)）→ 按 tool name 去重', () => {
    const r = createTelegramRenderer({ logger: fakeLogger })
    r.onEvent({
      type: 'activity-state',
      state: { clear: false, newToolCalls: ['bash(autocli read x)'] },
    } as AgentExecutionEvent)
    r.onEvent({
      type: 'activity-state',
      state: { clear: false, newToolCalls: ['bash(date)'] },
    } as AgentExecutionEvent)
    r.onEvent({
      type: 'activity-state',
      state: { clear: false, newToolCalls: ['read(foo)'] },
    } as AgentExecutionEvent)
    const out = r.currentProgressHtml()
    // 只显示 bash, read 各一次
    expect(out).toContain('🔧 bash, read')
    expect(out).not.toContain('autocli')
    expect(out).not.toContain('bash(')
  })
  it('terminal failed 追加 error 段', () => {
    const r = createTelegramRenderer({ logger: fakeLogger })
    r.onEvent({ type: 'assistant-message', text: 'partial' } as AgentExecutionEvent)
    r.onEvent({
      type: 'lifecycle',
      phase: 'failed',
      error: { message: 'boom' },
    } as AgentExecutionEvent)
    const segs = r.flush()
    expect(segs.some((s) => s.includes('⚠️ 处理失败：boom'))).toBe(true)
  })

  // ── currentProgressHtml 测试 ────────────────────
  it('currentProgressHtml 无任何状态 → 起始消息', () => {
    const r = createTelegramRenderer({ logger: fakeLogger })
    expect(r.currentProgressHtml()).toBe('⏳ 任务执行中...')
  })

  it('currentProgressHtml 含工具历史 + reasoning + status', () => {
    const r = createTelegramRenderer({ logger: fakeLogger })
    r.onEvent({
      type: 'activity-state',
      state: { clear: false, status: '调用工具中', reasoningTail: '思考中', newToolCalls: ['bash', 'read'] },
    } as AgentExecutionEvent)
    const out = r.currentProgressHtml()
    expect(out).toContain('🔧 bash, read')
    expect(out).toContain('💭 思考中')
    expect(out).toContain('⏳ 调用工具中')
  })

  it('currentProgressHtml status / reasoning 是覆盖语义（取最新）', () => {
    const r = createTelegramRenderer({ logger: fakeLogger })
    r.onEvent({
      type: 'activity-state',
      state: { clear: false, status: 'old', reasoningTail: 'r1' },
    } as AgentExecutionEvent)
    r.onEvent({
      type: 'activity-state',
      state: { clear: false, status: 'new', reasoningTail: 'r2' },
    } as AgentExecutionEvent)
    const out = r.currentProgressHtml()
    expect(out).toContain('⏳ new')
    expect(out).not.toContain('⏳ old')
    expect(out).toContain('💭 r2')
    expect(out).not.toContain('💭 r1')
  })

  it('currentProgressHtml 工具历史是累积语义（不被 clear）', () => {
    const r = createTelegramRenderer({ logger: fakeLogger })
    r.onEvent({
      type: 'activity-state',
      state: { clear: false, newToolCalls: ['bash'] },
    } as AgentExecutionEvent)
    r.onEvent({ type: 'activity-state', state: { clear: true } } as AgentExecutionEvent)
    r.onEvent({
      type: 'activity-state',
      state: { clear: false, newToolCalls: ['read'] },
    } as AgentExecutionEvent)
    const out = r.currentProgressHtml()
    expect(out).toContain('bash')
    expect(out).toContain('read')
  })

  it('currentProgressHtml 长 reasoning 截断尾部（保留最新内容）', () => {
    const r = createTelegramRenderer({ logger: fakeLogger })
    const longText = 'A'.repeat(1000)
    r.onEvent({
      type: 'activity-state',
      state: { clear: false, reasoningTail: longText },
    } as AgentExecutionEvent)
    const out = r.currentProgressHtml()
    expect(out).toContain('…')
    expect(out.length).toBeLessThan(700)  // 留一点 buffer 给 emoji + 标签
  })

  it('currentProgressHtml 内容做 escapeHtml', () => {
    const r = createTelegramRenderer({ logger: fakeLogger })
    r.onEvent({
      type: 'activity-state',
      state: { clear: false, status: '<script>alert(1)</script>' },
    } as AgentExecutionEvent)
    const out = r.currentProgressHtml()
    expect(out).toContain('&lt;script&gt;')
    expect(out).not.toContain('<script>')
  })
})
