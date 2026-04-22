// Dashboard 单页 HTML：内嵌 CSS + 纯 vanilla JS，通过 fetch /api/* 渲染各分区。
// 设计原则：零构建、零依赖；左侧 tab 分区，右侧内容面板；手动刷新 + 可选 30s 自动刷新。
// 未来加 daemon tab 时，只需在 TABS 数组和 render 函数中各加一项。

export function renderIndexHtml(): string {
  // 注意：下方模板内的 ${...} 是前端运行期 JS 模板字符串，所以此处用普通字符串拼接返回即可。
  return HTML
}

const HTML = `<!doctype html>
<html lang="zh">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>agent-slack dashboard</title>
<style>
  :root {
    --bg: #0f1117; --panel: #161a22; --panel2: #1d2230; --border: #2a3040;
    --fg: #e6e6e6; --muted: #8a93a6; --accent: #6ea8fe; --ok: #4ade80; --warn: #facc15; --err: #f87171;
    --mono: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; height: 100%; background: var(--bg); color: var(--fg); font: 13px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
  #app { display: grid; grid-template-columns: 220px 1fr; height: 100vh; }
  aside { background: var(--panel); border-right: 1px solid var(--border); display: flex; flex-direction: column; }
  aside h1 { font-size: 14px; margin: 0; padding: 14px 16px; border-bottom: 1px solid var(--border); color: var(--accent); }
  .tabs { flex: 1; overflow-y: auto; }
  .tab { display: block; width: 100%; text-align: left; background: transparent; border: 0; color: var(--fg); padding: 10px 16px; cursor: pointer; font-size: 13px; }
  .tab:hover { background: var(--panel2); }
  .tab.active { background: var(--panel2); color: var(--accent); border-left: 2px solid var(--accent); padding-left: 14px; }
  .tab .count { float: right; color: var(--muted); font-size: 11px; }
  aside footer { padding: 10px 16px; border-top: 1px solid var(--border); font-size: 11px; color: var(--muted); }
  aside footer label { display: flex; align-items: center; gap: 6px; cursor: pointer; }
  main { overflow-y: auto; padding: 20px 24px; }
  .row { display: flex; gap: 12px; flex-wrap: wrap; margin-bottom: 16px; }
  .card { background: var(--panel); border: 1px solid var(--border); border-radius: 6px; padding: 14px 16px; min-width: 160px; }
  .card .k { color: var(--muted); font-size: 11px; text-transform: uppercase; letter-spacing: 0.5px; }
  .card .v { font-size: 22px; margin-top: 4px; font-weight: 600; }
  .card .v.small { font-size: 14px; font-weight: normal; word-break: break-all; }
  section h2 { font-size: 16px; margin: 24px 0 10px; border-bottom: 1px solid var(--border); padding-bottom: 6px; }
  section h3 { font-size: 13px; margin: 14px 0 6px; color: var(--muted); }
  table { width: 100%; border-collapse: collapse; font-size: 12px; }
  th, td { text-align: left; padding: 6px 8px; border-bottom: 1px solid var(--border); }
  th { color: var(--muted); font-weight: 500; }
  tr:hover td { background: var(--panel2); }
  tr.clickable { cursor: pointer; }
  pre { background: var(--panel); border: 1px solid var(--border); border-radius: 4px; padding: 12px; overflow: auto; font-family: var(--mono); font-size: 11.5px; max-height: 70vh; white-space: pre-wrap; word-break: break-word; }
  code { font-family: var(--mono); background: var(--panel2); padding: 1px 5px; border-radius: 3px; font-size: 11.5px; }
  .pill { display: inline-block; padding: 1px 7px; border-radius: 10px; font-size: 11px; background: var(--panel2); color: var(--muted); }
  .pill.ok { background: rgba(74,222,128,0.15); color: var(--ok); }
  .pill.warn { background: rgba(250,204,21,0.15); color: var(--warn); }
  .pill.err { background: rgba(248,113,113,0.15); color: var(--err); }
  .muted { color: var(--muted); }
  .actions { margin-bottom: 12px; }
  button { background: var(--panel2); color: var(--fg); border: 1px solid var(--border); padding: 5px 12px; border-radius: 4px; cursor: pointer; font-size: 12px; }
  button:hover { border-color: var(--accent); }
  .back { margin-bottom: 12px; }
  .err-box { background: rgba(248,113,113,0.1); border: 1px solid var(--err); color: var(--err); padding: 10px; border-radius: 4px; margin: 10px 0; }
</style>
</head>
<body>
<div id="app">
  <aside>
    <h1>agent-slack</h1>
    <nav class="tabs" id="tabs"></nav>
    <footer>
      <label><input type="checkbox" id="auto-refresh" checked /> 实时刷新 (SSE)</label>
      <div style="margin-top:6px;"><button id="manual-refresh">手动刷新</button></div>
      <div id="last-refresh" style="margin-top:4px;"></div>
    </footer>
  </aside>
  <main id="main">加载中…</main>
</div>
<script>
const TABS = [
  { id: 'overview', label: 'Overview' },
  { id: 'sessions', label: 'Sessions' },
  { id: 'skills', label: 'Skills' },
  { id: 'memory', label: 'Memory' },
  { id: 'logs', label: 'Logs' },
  { id: 'config', label: 'Config' },
  { id: 'system', label: 'System Prompt' },
  { id: 'daemon', label: 'Daemon' },
]

const state = { current: 'overview', auto: true, es: null, sub: null }

function el(tag, attrs, children) {
  const e = document.createElement(tag)
  if (attrs) for (const [k, v] of Object.entries(attrs)) {
    if (v == null) continue
    if (k === 'class') e.className = v
    else if (k === 'onclick') e.addEventListener('click', v)
    else if (k === 'html') e.innerHTML = v
    else e.setAttribute(k, v)
  }
  if (children) for (const c of [].concat(children)) {
    if (c == null) continue
    e.appendChild(typeof c === 'string' ? document.createTextNode(c) : c)
  }
  return e
}

function fmtBytes(n) {
  if (n < 1024) return n + ' B'
  if (n < 1024*1024) return (n/1024).toFixed(1) + ' KB'
  return (n/1024/1024).toFixed(2) + ' MB'
}
function fmtNum(n) { return (n || 0).toLocaleString() }
function fmtTs(s) { return s ? new Date(s).toLocaleString() : '-' }

async function api(path) {
  const r = await fetch(path)
  if (!r.ok) throw new Error(path + ': HTTP ' + r.status)
  return r.json()
}

function pill(label, level) { return el('span', { class: 'pill ' + (level || '') }, label) }
function boolPill(ok, labelOk, labelErr) {
  return pill(ok ? (labelOk || 'OK') : (labelErr || 'MISSING'), ok ? 'ok' : 'err')
}

function renderTabs(counts) {
  const nav = document.getElementById('tabs')
  nav.innerHTML = ''
  for (const t of TABS) {
    const count = counts ? counts[t.id] : undefined
    const btn = el('button', {
      class: 'tab' + (state.current === t.id ? ' active' : ''),
      onclick: () => { state.current = t.id; state.sub = null; render() }
    }, [t.label, count != null ? el('span', { class: 'count' }, String(count)) : null])
    nav.appendChild(btn)
  }
}

async function render(preFetched) {
  const main = document.getElementById('main')
  const isInitial = main.children.length === 0 || main.firstElementChild == null
  // 首次渲染或切 tab 时显示 loading；SSE 静默刷新不动 UI 避免闪烁
  if (isInitial && !preFetched) main.innerHTML = '加载中…'
  const scrollY = main.scrollTop
  try {
    const view = await views[state.current](preFetched)
    main.replaceChildren(view)
    main.scrollTop = scrollY
    document.getElementById('last-refresh').textContent = '最后刷新 ' + new Date().toLocaleTimeString()
  } catch (err) {
    main.replaceChildren(el('div', { class: 'err-box' }, String(err && err.message || err)))
  }
}

const views = {
  async overview(pre) {
    const o = pre || await api('/api/overview')
    renderTabs({
      sessions: o.sessionCount, skills: o.skillCount,
    })
    const env = o.env
    const cards = [
      ['Agent', o.config.agent.name + ' / ' + o.config.agent.model, 'small'],
      ['Provider', o.config.agent.provider, 'small'],
      ['Sessions', fmtNum(o.sessionCount)],
      ['Running', fmtNum(o.runningSessionCount)],
      ['Skills', fmtNum(o.skillCount)],
      ['Total steps', fmtNum(o.usage.stepCount)],
      ['Total tokens (in/out)', fmtNum(o.usage.inputTokens) + ' / ' + fmtNum(o.usage.outputTokens), 'small'],
      ['Total cost', '$' + (o.usage.totalCostUSD || 0).toFixed(4), 'small'],
      ['Recent errors', fmtNum(o.recentErrorCount)],
    ]
    const row = el('div', { class: 'row' }, cards.map(([k, v, cls]) =>
      el('div', { class: 'card' }, [el('div', { class: 'k' }, k), el('div', { class: 'v ' + (cls||'') }, v)])
    ))

    // Health 摘要（本地可判定维度）
    const h = o.healthSummary
    const healthBox = el('div', { class: 'row' }, [
      boolPill(h.nodeOk, 'Node ' + h.nodeVersion, 'Node ' + h.nodeVersion + ' (需 >=22)'),
      boolPill(h.configExists, 'config.yaml', 'config.yaml 缺失 (用默认)'),
      boolPill(h.systemExists, 'system.md', 'system.md 缺失'),
      boolPill(h.slackEnvOk, 'Slack env', 'Slack env 不全'),
      boolPill(h.litellmEnvOk, 'LiteLLM env', 'LiteLLM env 不全'),
    ])

    const envBox = el('div', { class: 'row' }, [
      boolPill(env.hasSlackBotToken, 'SLACK_BOT_TOKEN'),
      boolPill(env.hasSlackSigningSecret, 'SLACK_SIGNING_SECRET'),
      boolPill(env.hasSlackAppToken, 'SLACK_APP_TOKEN'),
      boolPill(env.hasLitellmBaseUrl, 'LITELLM_BASE_URL'),
      boolPill(env.hasLitellmApiKey, 'LITELLM_API_KEY'),
      boolPill(env.hasAnthropicApiKey, 'ANTHROPIC_API_KEY'),
      pill('LOG_LEVEL=' + (env.logLevel || 'default'), ''),
    ])

    // 最近活跃 Session Top 5
    const rs = o.recentSessions || []
    const recentSessionsBox = rs.length === 0
      ? el('div', { class: 'muted' }, '暂无 session')
      : el('table', {}, [
          el('thead', {}, el('tr', {}, ['channel','threadTs','status','msgs','steps','updatedAt'].map(h => el('th', {}, h)))),
          el('tbody', {}, rs.map(s => el('tr', {
            class: 'clickable',
            onclick: () => { state.current = 'sessions'; state.sub = s.id; render() }
          }, [
            el('td', {}, '#' + s.channelName),
            el('td', {}, s.threadTs),
            el('td', {}, pill(s.status, s.status === 'running' ? 'ok' : s.status === 'error' ? 'err' : '')),
            el('td', {}, String(s.messageCount)),
            el('td', {}, String(s.usage.stepCount)),
            el('td', {}, fmtTs(s.updatedAt)),
          ])))
        ])

    // 最近事件 Timeline
    const re = o.recentEvents || []
    const timelineBox = re.length === 0
      ? el('div', { class: 'muted' }, '暂无事件')
      : el('div', {}, re.map(ev => el('div', {
          class: 'card',
          style: 'margin-bottom:6px;padding:6px 10px;border-left:3px solid ' + (ev.kind === 'error' ? 'var(--err)' : 'var(--accent)') + ';',
          onclick: ev.sessionId ? (() => { state.current = 'sessions'; state.sub = ev.sessionId; render() }) : undefined,
        }, [
          el('div', { class: 'muted', style: 'font-size:11px;' }, fmtTs(ev.ts) + ' · ' + ev.kind),
          el('div', { style: 'font-family:var(--mono);font-size:11.5px;word-break:break-all;' }, ev.text),
        ])))

    // Memory 概况
    const mem = o.memorySummary
    const memoryBox = el('div', { class: 'row' }, [
      el('div', { class: 'card' }, [el('div', { class: 'k' }, 'Memory files'), el('div', { class: 'v' }, fmtNum(mem.count))]),
      el('div', { class: 'card' }, [el('div', { class: 'k' }, 'Total size'), el('div', { class: 'v small' }, fmtBytes(mem.totalSize))]),
      el('div', { class: 'card' }, [el('div', { class: 'k' }, 'Latest'), el('div', { class: 'v small' }, mem.latestFile ? (mem.latestFile + ' · ' + fmtTs(mem.latestMtime)) : '-')]),
    ])

    return el('section', {}, [
      el('h2', {}, 'Overview'),
      row,
      el('h3', {}, 'Health'),
      healthBox,
      el('h3', {}, 'Recent Sessions (Top 5)'),
      recentSessionsBox,
      el('h3', {}, 'Recent Events'),
      timelineBox,
      el('h3', {}, 'Memory'),
      memoryBox,
      el('h3', {}, 'Env'),
      envBox,
      el('h3', {}, 'Workspace'),
      el('pre', {}, o.cwd + '\\n' + JSON.stringify(o.paths, null, 2)),
      el('div', { class: 'muted' }, 'generated at ' + fmtTs(o.generatedAt)),
    ])
  },

  async context() {
    // 已移除 context tab，保留空函数以防老 state 引用；生产路径不会触达
    return el('div', {}, '')
  },

  async sessions() {
    const list = await api('/api/sessions')
    renderTabs({ sessions: list.length })
    if (state.sub) return renderSessionDetail(state.sub)
    const tbody = el('tbody', {}, list.map(s => {
      const tr = el('tr', { class: 'clickable', onclick: () => { state.sub = s.id; render() } }, [
        el('td', {}, '#' + s.channelName),
        el('td', {}, s.threadTs),
        el('td', {}, pill(s.status, s.status === 'running' ? 'ok' : s.status === 'error' ? 'err' : '')),
        el('td', {}, String(s.messageCount)),
        el('td', {}, String(s.usage.stepCount)),
        el('td', {}, '$' + (s.usage.totalCostUSD || 0).toFixed(4)),
        el('td', {}, fmtTs(s.updatedAt)),
      ])
      return tr
    }))
    const table = el('table', {}, [
      el('thead', {}, el('tr', {}, ['channel','threadTs','status','msgs','steps','cost','updatedAt'].map(h => el('th', {}, h)))),
      tbody,
    ])
    return el('section', {}, [
      el('h2', {}, 'Sessions (' + list.length + ')'),
      list.length === 0 ? el('div', { class: 'muted' }, '暂无 session') : table,
    ])
  },

  async skills() {
    const list = await api('/api/skills')
    renderTabs({ skills: list.length })
    if (state.sub) {
      const s = await api('/api/skills/' + encodeURIComponent(state.sub))
      return el('section', {}, [
        el('button', { class: 'back', onclick: () => { state.sub = null; render() } }, '← 返回'),
        el('h2', {}, 'Skill: ' + s.name),
        el('p', {}, s.description),
        s.whenToUse ? el('p', {}, [el('strong', {}, 'When to use: '), s.whenToUse]) : null,
        el('div', { class: 'muted' }, s.source),
        el('h3', {}, 'Content'),
        el('pre', {}, s.content),
      ])
    }
    const tbody = el('tbody', {}, list.map(s => el('tr', {
      class: 'clickable', onclick: () => { state.sub = s.name; render() }
    }, [
      el('td', {}, s.name),
      el('td', {}, s.description),
      el('td', { class: 'muted' }, s.whenToUse || '-'),
    ])))
    return el('section', {}, [
      el('h2', {}, 'Skills (' + list.length + ')'),
      list.length === 0 ? el('div', { class: 'muted' }, '暂无 skill') : el('table', {}, [
        el('thead', {}, el('tr', {}, ['name','description','whenToUse'].map(h => el('th', {}, h)))),
        tbody,
      ]),
    ])
  },

  async memory() {
    const list = await api('/api/memory')
    renderTabs()
    if (state.sub) {
      const m = await api('/api/memory/' + encodeURIComponent(state.sub))
      return el('section', {}, [
        el('button', { class: 'back', onclick: () => { state.sub = null; render() } }, '← 返回'),
        el('h2', {}, 'Memory: ' + m.file),
        el('pre', {}, m.content),
      ])
    }
    const tbody = el('tbody', {}, list.map(m => el('tr', {
      class: 'clickable', onclick: () => { state.sub = m.file; render() }
    }, [
      el('td', {}, m.file), el('td', {}, fmtBytes(m.size)), el('td', {}, fmtTs(m.mtime)),
    ])))
    return el('section', {}, [
      el('h2', {}, 'Memory (' + list.length + ')'),
      list.length === 0 ? el('div', { class: 'muted' }, '暂无 memory 文件') : el('table', {}, [
        el('thead', {}, el('tr', {}, ['file','size','mtime'].map(h => el('th', {}, h)))),
        tbody,
      ]),
    ])
  },

  async logs() {
    const list = await api('/api/logs')
    renderTabs()
    if (state.sub) {
      const r = await api('/api/logs/' + encodeURIComponent(state.sub) + '?tail=1000')
      return el('section', {}, [
        el('button', { class: 'back', onclick: () => { state.sub = null; render() } }, '← 返回'),
        el('h2', {}, 'Log: ' + r.file),
        el('pre', {}, r.lines.join('\\n')),
      ])
    }
    const tbody = el('tbody', {}, list.map(m => el('tr', {
      class: 'clickable', onclick: () => { state.sub = m.file; render() }
    }, [
      el('td', {}, m.file), el('td', {}, fmtBytes(m.size)), el('td', {}, fmtTs(m.mtime)),
    ])))
    return el('section', {}, [
      el('h2', {}, 'Logs (' + list.length + ')'),
      list.length === 0
        ? el('div', { class: 'muted' }, '无日志文件。当前 logger 只写 stdout，如需文件日志请配置后端 transport。')
        : el('table', {}, [
          el('thead', {}, el('tr', {}, ['file','size','mtime'].map(h => el('th', {}, h)))),
          tbody,
        ]),
    ])
  },

  async config() {
    const c = await api('/api/config')
    renderTabs()
    const ta = el('textarea', {
      id: 'config-editor',
      style: 'width:100%;min-height:360px;background:var(--panel);color:var(--fg);border:1px solid var(--border);border-radius:4px;padding:10px;font-family:var(--mono);font-size:12px;'
    })
    ta.value = c.raw || '# config.yaml 不存在，保存此内容将创建文件\\n'
    const msg = el('div', { id: 'config-msg', style: 'margin-top:8px;' })
    const save = el('button', { onclick: async () => {
      msg.textContent = '保存中…'; msg.className = 'muted'
      try {
        const r = await fetch('/api/config', { method: 'PUT', headers: { 'content-type': 'text/plain' }, body: ta.value })
        if (!r.ok) { const e = await r.json(); throw new Error(e.error || ('HTTP ' + r.status)) }
        msg.textContent = '已保存'; msg.className = 'pill ok'
      } catch (err) { msg.textContent = '保存失败：' + (err.message || err); msg.className = 'err-box' }
    }}, '保存')
    const del = el('button', { style: 'margin-left:8px;', onclick: async () => {
      if (!confirm('确认删除 config.yaml？（主程序将回退到默认配置）')) return
      try {
        const r = await fetch('/api/config', { method: 'DELETE' })
        if (!r.ok) throw new Error('HTTP ' + r.status)
        msg.textContent = '已删除'; msg.className = 'pill ok'
        setTimeout(render, 300)
      } catch (err) { msg.textContent = '删除失败：' + (err.message || err); msg.className = 'err-box' }
    }}, '删除 config.yaml')
    return el('section', {}, [
      el('h2', {}, 'Config'),
      el('div', { class: 'muted', style: 'margin-bottom:6px;' }, c.exists ? '已存在：' + '.agent-slack/config.yaml' : 'config.yaml 不存在，当前使用默认配置'),
      ta,
      el('div', { class: 'actions', style: 'margin-top:8px;' }, [save, del]),
      msg,
      el('h3', {}, 'Parsed (只读)'),
      el('pre', {}, JSON.stringify(c.parsed, null, 2)),
    ])
  },

  async system() {
    const s = await api('/api/system-prompt')
    renderTabs()
    const ta = el('textarea', {
      id: 'sys-editor',
      style: 'width:100%;min-height:480px;background:var(--panel);color:var(--fg);border:1px solid var(--border);border-radius:4px;padding:10px;font-family:var(--mono);font-size:12px;'
    })
    ta.value = s.content || ''
    const msg = el('div', { style: 'margin-top:8px;' })
    const save = el('button', { onclick: async () => {
      msg.textContent = '保存中…'; msg.className = 'muted'
      try {
        const r = await fetch('/api/system-prompt', { method: 'PUT', headers: { 'content-type': 'text/plain' }, body: ta.value })
        if (!r.ok) throw new Error('HTTP ' + r.status)
        msg.textContent = '已保存'; msg.className = 'pill ok'
      } catch (err) { msg.textContent = '保存失败：' + (err.message || err); msg.className = 'err-box' }
    }}, '保存')
    const del = el('button', { style: 'margin-left:8px;', onclick: async () => {
      if (!confirm('确认删除 system.md？')) return
      try {
        const r = await fetch('/api/system-prompt', { method: 'DELETE' })
        if (!r.ok) throw new Error('HTTP ' + r.status)
        msg.textContent = '已删除'; msg.className = 'pill ok'
        setTimeout(render, 300)
      } catch (err) { msg.textContent = '删除失败：' + (err.message || err); msg.className = 'err-box' }
    }}, '删除 system.md')
    return el('section', {}, [
      el('h2', {}, 'System Prompt'),
      el('div', { class: 'muted', style: 'margin-bottom:6px;' }, s.exists ? '.agent-slack/system.md' : 'system.md 不存在，保存此内容将创建文件'),
      ta,
      el('div', { class: 'actions', style: 'margin-top:8px;' }, [save, del]),
      msg,
    ])
  },

  async health() {
    // 已移除 health tab，保留空实现仅防御 state.current 残留
    return el('div', {}, '')
  },

  async daemon() {
    const d = await api('/api/daemon')
    renderTabs()
    return el('section', {}, [
      el('h2', {}, 'Daemon'),
      el('div', {}, pill('status: ' + d.status, 'warn')),
      el('p', { class: 'muted' }, d.note),
    ])
  },
}

async function renderSessionDetail(id) {
  const r = await api('/api/sessions/' + encodeURIComponent(id) + '/messages?limit=200')
  const list = await api('/api/sessions')
  const meta = list.find(x => x.id === id)
  const msgs = r.messages.map((m, i) => {
    const role = (m && m.role) || '?'
    const content = m && typeof m.content === 'string' ? m.content
      : el('pre', {}, JSON.stringify(m && m.content, null, 2))
    return el('div', { class: 'card', style: 'margin-bottom:8px;width:100%;' }, [
      el('div', { class: 'k' }, '#' + (r.offset + i) + ' · ' + role),
      typeof content === 'string' ? el('pre', {}, content) : content,
    ])
  })
  return el('section', {}, [
    el('button', { class: 'back', onclick: () => { state.sub = null; render() } }, '← 返回 sessions'),
    el('h2', {}, meta ? ('#' + meta.channelName + ' · ' + meta.threadTs) : id),
    meta ? el('pre', {}, JSON.stringify(meta, null, 2)) : null,
    el('h3', {}, 'Messages (' + r.total + ', 显示前 ' + r.messages.length + ')'),
    el('div', {}, msgs),
  ])
}

document.getElementById('manual-refresh').addEventListener('click', () => render())

document.getElementById('auto-refresh').addEventListener('change', (e) => {
  state.auto = e.target.checked
  if (state.auto) openStream()
  else closeStream()
})

function openStream() {
  if (state.es) return
  try {
    const es = new EventSource('/api/stream')
    es.addEventListener('tick', (ev) => {
      // 只在 overview tab 时用 SSE payload 做原子替换（无闪烁、保留 scroll）
      if (state.current === 'overview' && !state.sub) {
        try {
          const data = JSON.parse(ev.data)
          render(data)
        } catch {
          // payload 坏了就忽略；下次 tick 再试
        }
      } else {
        document.getElementById('last-refresh').textContent = '最后 tick ' + new Date().toLocaleTimeString()
      }
    })
    es.addEventListener('error', () => {
      // 连接断开时浏览器会按 retry 自动重连；此处无需额外处理
    })
    state.es = es
  } catch (err) {
    console.warn('SSE 启动失败', err)
  }
}
function closeStream() {
  if (state.es) { state.es.close(); state.es = null }
}

renderTabs()
render()
openStream()
</script>
</body>
</html>`
