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
  { id: 'channelTasks', label: 'Channel Tasks' },
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

    const devBox = await renderDevPanel()

    return el('section', {}, [
      el('h2', {}, 'Overview'),
      devBox,
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

    // 局部小工具：按 path 数组从 parsed 配置里取当前值
    function getIn(obj, path) {
      let cur = obj
      for (const k of path) {
        if (cur == null || typeof cur !== 'object') return undefined
        cur = cur[k]
      }
      return cur
    }

    // 默认表单视图；点击切换可降到 raw YAML（兜底）
    const view = { mode: 'form' }

    // 容器：左 form / 右 raw textarea；切换时重新挂载内容
    const container = el('div')
    const msg = el('div', { id: 'config-msg', style: 'margin-top:8px;' })

    function buildFormView() {
      // 字段 inputs，按需收集 path -> input 引用
      const inputs = []
      const fieldsWrap = el('div', { class: 'config-form', style: 'display:grid;grid-template-columns:240px 1fr;gap:8px 14px;align-items:center;margin-top:6px;' })

      for (const f of c.fields) {
        const cur = getIn(c.parsed, f.path)
        const labelText = f.label
        const label = el('label', { class: 'muted', style: 'font-family:var(--mono);' }, labelText)
        let input
        if (f.type === 'select') {
          input = el('select', { style: 'background:var(--panel2);color:var(--fg);border:1px solid var(--border);border-radius:4px;padding:4px 6px;font-size:12px;min-width:220px;' },
            (f.options || []).map(opt => {
              const o = el('option', { value: opt }, opt)
              if (opt === cur) o.setAttribute('selected', 'selected')
              return o
            }),
          )
        } else if (f.type === 'boolean') {
          input = el('input', { type: 'checkbox' })
          if (cur) input.setAttribute('checked', 'checked')
        } else if (f.type === 'array-of-strings') {
          input = el('textarea', { rows: '2', style: 'background:var(--panel2);color:var(--fg);border:1px solid var(--border);border-radius:4px;padding:6px 8px;font-family:var(--mono);font-size:12px;width:100%;' })
          input.value = Array.isArray(cur) ? cur.join('\\n') : ''
        } else {
          // text / number 都用 input
          input = el('input', { type: f.type === 'number' ? 'number' : 'text', style: 'background:var(--panel2);color:var(--fg);border:1px solid var(--border);border-radius:4px;padding:4px 6px;font-size:12px;width:260px;' })
          input.value = cur == null ? '' : String(cur)
        }

        // help 行（小字提示）
        const cell = el('div', {}, [input, f.help ? el('div', { class: 'muted', style: 'font-size:11px;margin-top:2px;' }, f.help) : null])

        fieldsWrap.appendChild(label)
        fieldsWrap.appendChild(cell)
        inputs.push({ field: f, input })
      }

      const save = el('button', { onclick: async () => {
        // 收集每个字段的当前 form value，按 path 全量提交（局部覆盖式 PATCH）
        const updates = []
        for (const { field, input } of inputs) {
          let val
          if (field.type === 'boolean') val = input.checked
          else if (field.type === 'number') val = input.value === '' ? undefined : Number(input.value)
          else if (field.type === 'array-of-strings') {
            val = input.value.split(/[\\r\\n,]+/).map(s => s.trim()).filter(Boolean)
          } else {
            val = input.value
          }
          if (val === undefined) continue
          updates.push({ path: field.path, value: val })
        }
        msg.textContent = '保存中…'; msg.className = 'muted'
        try {
          const r = await fetch('/api/config/fields', {
            method: 'PATCH',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(updates),
          })
          if (!r.ok) { const e = await r.json(); throw new Error(e.error || ('HTTP ' + r.status)) }
          msg.textContent = '已保存（保留中文注释，重启 agent/daemon 后生效）'; msg.className = 'pill ok'
          setTimeout(render, 400)
        } catch (err) { msg.textContent = '保存失败：' + (err.message || err); msg.className = 'err-box' }
      }}, '保存常用字段')

      const toRaw = el('button', { style: 'margin-left:8px;', onclick: () => { view.mode = 'raw'; mount() } }, '切到 Raw YAML 编辑')

      const del = el('button', { style: 'margin-left:8px;', onclick: async () => {
        if (!confirm('确认删除 config.yaml？（主程序将回退到默认配置）')) return
        try {
          const r = await fetch('/api/config', { method: 'DELETE' })
          if (!r.ok) throw new Error('HTTP ' + r.status)
          msg.textContent = '已删除'; msg.className = 'pill ok'
          setTimeout(render, 300)
        } catch (err) { msg.textContent = '删除失败：' + (err.message || err); msg.className = 'err-box' }
      }}, '删除 config.yaml')

      return el('div', {}, [
        el('div', { class: 'muted', style: 'margin-bottom:6px;' }, '常用字段表单：保存为局部覆盖（保留 raw YAML 里的中文注释）。其余字段需要切到 Raw YAML 编辑。'),
        fieldsWrap,
        el('div', { class: 'actions', style: 'margin-top:12px;' }, [save, toRaw, del]),
      ])
    }

    function buildRawView() {
      const ta = el('textarea', {
        id: 'config-editor',
        style: 'width:100%;min-height:360px;background:var(--panel);color:var(--fg);border:1px solid var(--border);border-radius:4px;padding:10px;font-family:var(--mono);font-size:12px;'
      })
      ta.value = c.raw || '# config.yaml 不存在，保存此内容将创建文件\\n'
      const save = el('button', { onclick: async () => {
        msg.textContent = '保存中…'; msg.className = 'muted'
        try {
          const r = await fetch('/api/config', { method: 'PUT', headers: { 'content-type': 'text/plain' }, body: ta.value })
          if (!r.ok) { const e = await r.json(); throw new Error(e.error || ('HTTP ' + r.status)) }
          msg.textContent = '已保存（整文件覆盖）'; msg.className = 'pill ok'
        } catch (err) { msg.textContent = '保存失败：' + (err.message || err); msg.className = 'err-box' }
      }}, '保存整文件')
      const toForm = el('button', { style: 'margin-left:8px;', onclick: () => { view.mode = 'form'; mount() } }, '切回表单')
      return el('div', {}, [
        el('div', { class: 'muted', style: 'margin-bottom:6px;' }, 'Raw YAML 模式：直接编辑整个 config.yaml，覆盖式保存。'),
        ta,
        el('div', { class: 'actions', style: 'margin-top:8px;' }, [save, toForm]),
      ])
    }

    function mount() {
      container.replaceChildren(view.mode === 'form' ? buildFormView() : buildRawView())
    }
    mount()

    return el('section', {}, [
      el('h2', {}, 'Config'),
      el('div', { class: 'muted', style: 'margin-bottom:6px;' }, c.exists ? '已存在：.agent-slack/config.yaml' : 'config.yaml 不存在，当前使用默认配置（保存任意字段会按 generator 模板初始化）'),
      container,
      msg,
      el('h3', {}, 'Parsed (只读)'),
      el('pre', {}, JSON.stringify(c.parsed, null, 2)),
    ])
  },

  async channelTasks() {
    const c = await api('/api/channel-tasks')
    renderTabs()
    const ta = el('textarea', {
      id: 'channel-tasks-editor',
      style: 'width:100%;min-height:460px;background:var(--panel);color:var(--fg);border:1px solid var(--border);border-radius:4px;padding:10px;font-family:var(--mono);font-size:12px;'
    })
    ta.value = c.raw || '# channel-tasks.yaml 不存在；点击“生成模板”创建带中文注释的配置\\n'
    const msg = el('div', { id: 'channel-tasks-msg', style: 'margin-top:8px;' })
    const save = el('button', { onclick: async () => {
      msg.textContent = '保存中…'; msg.className = 'muted'
      try {
        const r = await fetch('/api/channel-tasks', { method: 'PUT', headers: { 'content-type': 'text/plain' }, body: ta.value })
        if (!r.ok) { const e = await r.json(); throw new Error(e.error || ('HTTP ' + r.status)) }
        msg.textContent = '已保存；重启 agent/daemon 后生效'; msg.className = 'pill ok'
        setTimeout(render, 300)
      } catch (err) { msg.textContent = '保存失败：' + (err.message || err); msg.className = 'err-box' }
    }}, '保存 channel-tasks.yaml')
    const gen = el('button', { style: 'margin-left:8px;', onclick: async () => {
      msg.textContent = '生成模板中…'; msg.className = 'muted'
      try {
        const r = await fetch('/api/channel-tasks/template', { method: 'POST' })
        const js = await r.json()
        if (!r.ok) throw new Error(js.error || ('HTTP ' + r.status))
        ta.value = js.raw
        msg.textContent = '模板已生成；请编辑后保存并重启 agent/daemon'; msg.className = 'pill ok'
        setTimeout(render, 300)
      } catch (err) { msg.textContent = '生成失败：' + (err.message || err); msg.className = 'err-box' }
    }}, '生成中文注释模板')
    const del = el('button', { style: 'margin-left:8px;', onclick: async () => {
      if (!confirm('确认删除 channel-tasks.yaml？（频道任务监听将关闭）')) return
      try {
        const r = await fetch('/api/channel-tasks', { method: 'DELETE' })
        if (!r.ok) throw new Error('HTTP ' + r.status)
        msg.textContent = '已删除；重启 agent/daemon 后生效'; msg.className = 'pill ok'
        setTimeout(render, 300)
      } catch (err) { msg.textContent = '删除失败：' + (err.message || err); msg.className = 'err-box' }
    }}, '删除 channel-tasks.yaml')
    const validation = c.validation && c.validation.ok
      ? el('div', { class: 'pill ok' }, 'schema 校验通过')
      : el('div', { class: 'err-box' }, 'schema 校验失败：' + (c.validation && c.validation.error || 'unknown'))
    const summary = c.parsed
      ? JSON.stringify({
          enabled: c.parsed.enabled,
          ruleCount: c.parsed.rules.length,
          rules: c.parsed.rules.map(r => ({
            id: r.id,
            enabled: r.enabled,
            channelIds: r.channelIds,
            userIds: r.source.userIds,
            botIds: r.source.botIds,
            appIds: r.source.appIds,
          })),
        }, null, 2)
      : '配置无法解析，请修复 YAML 后保存。'
    return el('section', {}, [
      el('h2', {}, 'Channel Tasks'),
      el('div', { class: 'muted', style: 'margin-bottom:6px;' }, c.exists ? '已存在：.agent-slack/channel-tasks.yaml' : 'channel-tasks.yaml 不存在，频道任务监听关闭'),
      el('p', { class: 'muted' }, '保存后需要重启 agent-slack start 或 daemon 才会生效。Dashboard 会原样保存 raw YAML，不会重排或删除中文注释。'),
      validation,
      ta,
      el('div', { class: 'actions', style: 'margin-top:8px;' }, [save, gen, del]),
      msg,
      el('h3', {}, 'Parsed Summary (只读)'),
      el('pre', {}, summary),
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

    // offline / stale 状态
    if (d.state === 'offline') {
      const startMsg = el('div', { style: 'margin-top:8px;' })
      const startBtn = el('button', { onclick: async () => {
        startBtn.disabled = true
        startMsg.textContent = '正在启动 daemon…'; startMsg.className = 'muted'
        try {
          const r = await fetch('/api/daemon/start', { method: 'POST' })
          const js = await r.json()
          if (!r.ok || !js.ok) throw new Error(js.error || 'HTTP ' + r.status)
          startMsg.textContent = '已启动 pid=' + js.pid; startMsg.className = 'pill ok'
          setTimeout(render, 1000)
        } catch (err) {
          startMsg.textContent = '启动失败：' + (err.message || err); startMsg.className = 'err-box'
          startBtn.disabled = false
        }
      }}, '启动 Daemon')
      return el('section', {}, [
        el('h2', {}, 'Daemon'),
        el('div', {}, pill('offline', 'warn')),
        el('p', { class: 'muted', style: 'margin-top:10px;' }, d.note || '未启动'),
        el('div', { class: 'actions' }, [startBtn]),
        startMsg,
      ])
    }
    if (d.state === 'stale') {
      const staleMsg = el('div', { style: 'margin-top:8px;' })
      const cleanBtn = el('button', { onclick: async () => {
        cleanBtn.disabled = true
        staleMsg.textContent = '正在清理并启动…'; staleMsg.className = 'muted'
        try {
          // 先停止清理 stale
          await fetch('/api/daemon/stop', { method: 'POST' })
          // 再启动
          const r = await fetch('/api/daemon/start', { method: 'POST' })
          const js = await r.json()
          if (!r.ok || !js.ok) throw new Error(js.error || 'HTTP ' + r.status)
          staleMsg.textContent = '已启动 pid=' + js.pid; staleMsg.className = 'pill ok'
          setTimeout(render, 1000)
        } catch (err) {
          staleMsg.textContent = '操作失败：' + (err.message || err); staleMsg.className = 'err-box'
          cleanBtn.disabled = false
        }
      }}, '清理并启动 Daemon')
      return el('section', {}, [
        el('h2', {}, 'Daemon'),
        el('div', {}, pill('stale', 'err')),
        el('p', { class: 'muted' }, d.note || ''),
        el('pre', {}, JSON.stringify(d.meta, null, 2)),
        el('div', { class: 'actions' }, [cleanBtn]),
        staleMsg,
      ])
    }

    // running
    const meta = d.meta
    const live = d.live
    const uptimeSec = live ? Math.floor(live.uptimeMs / 1000) : 0
    const uptimeStr = uptimeSec < 60
      ? (uptimeSec + 's')
      : uptimeSec < 3600
        ? (Math.floor(uptimeSec / 60) + 'm' + (uptimeSec % 60) + 's')
        : (Math.floor(uptimeSec / 3600) + 'h' + Math.floor((uptimeSec % 3600) / 60) + 'm')

    const metaRow = el('div', { class: 'row' }, [
      el('div', { class: 'card' }, [el('div', { class: 'k' }, 'Status'), el('div', { class: 'v' }, pill('running', 'ok'))]),
      el('div', { class: 'card' }, [el('div', { class: 'k' }, 'Mode'), el('div', { class: 'v small' }, meta.mode || 'embedded')]),
      el('div', { class: 'card' }, [el('div', { class: 'k' }, 'PID'), el('div', { class: 'v' }, String(meta.pid))]),
      el('div', { class: 'card' }, [el('div', { class: 'k' }, 'Uptime'), el('div', { class: 'v' }, live ? uptimeStr : '-')]),
      el('div', { class: 'card' }, [el('div', { class: 'k' }, 'Inflight'), el('div', { class: 'v' }, live ? String(live.inflight.count) : '-')]),
    ])

    const infoRow = el('div', { class: 'row' }, [
      el('div', { class: 'card' }, [el('div', { class: 'k' }, 'URL'), el('div', { class: 'v small' }, meta.url)]),
      el('div', { class: 'card' }, [el('div', { class: 'k' }, 'Version'), el('div', { class: 'v small' }, meta.version)]),
      el('div', { class: 'card' }, [el('div', { class: 'k' }, 'Started'), el('div', { class: 'v small' }, fmtTs(meta.startedAt))]),
      el('div', { class: 'card' }, [el('div', { class: 'k' }, 'CWD'), el('div', { class: 'v small' }, meta.cwd)]),
    ])

    const actionMsg = el('div', { style: 'margin-top:8px;' })
    const postDaemon = async (sub, confirmMsg) => {
      if (confirmMsg && !confirm(confirmMsg)) return
      actionMsg.textContent = '执行中…'; actionMsg.className = 'muted'
      try {
        const r = await fetch('/api/daemon/' + sub, { method: 'POST' })
        if (!r.ok) throw new Error('HTTP ' + r.status)
        const js = await r.json()
        actionMsg.textContent = '已发送：' + JSON.stringify(js); actionMsg.className = 'pill ok'
        setTimeout(render, 1200)
      } catch (err) {
        actionMsg.textContent = '失败：' + (err.message || err); actionMsg.className = 'err-box'
      }
    }

    const actions = el('div', { class: 'actions' }, [
      el('button', { onclick: () => postDaemon('stop', '确认停止 daemon？\\n（所有活跃 session 会被中止）') }, 'Stop'),
    ])

    // inflight session 列表 + Abort
    const inflightBox = live && live.inflight.count > 0
      ? el('table', {}, [
          el('thead', {}, el('tr', {}, ['Session Key', 'Action'].map(h => el('th', {}, h)))),
          el('tbody', {}, live.inflight.keys.map(k => el('tr', {}, [
            el('td', {}, el('code', {}, k)),
            el('td', {}, el('button', {
              onclick: async () => {
                if (!confirm('确认中止此 session？\\n' + k)) return
                try {
                  const r = await fetch('/api/daemon/abort/' + encodeURIComponent(k), { method: 'POST' })
                  if (!r.ok) throw new Error('HTTP ' + r.status)
                  actionMsg.textContent = '已 abort ' + k; actionMsg.className = 'pill ok'
                  setTimeout(render, 800)
                } catch (err) {
                  actionMsg.textContent = 'abort 失败：' + (err.message || err); actionMsg.className = 'err-box'
                }
              }
            }, 'Abort')),
          ])))
        ])
      : el('div', { class: 'muted' }, '当前无 inflight session')

    return el('section', {}, [
      el('h2', {}, 'Daemon'),
      metaRow,
      infoRow,
      actions,
      actionMsg,
      el('h3', {}, 'Inflight Sessions'),
      inflightBox,
    ])
  },
}

async function renderDevPanel() {
  const d = await api('/api/dev')
  const isRunning = d.state === 'running'
  const msg = el('div', { style: 'margin-top:8px;' })

  const startBtn = el('button', {
    style: 'background:' + (isRunning ? 'var(--panel2)' : 'rgba(74,222,128,0.15)') + ';border-color:' + (isRunning ? 'var(--border)' : 'var(--ok)') + ';color:' + (isRunning ? 'var(--muted)' : 'var(--ok)') + ';',
    onclick: async () => {
      startBtn.disabled = true
      msg.textContent = '启动中…'; msg.className = 'muted'
      try {
        const r = await fetch('/api/dev/launch', { method: 'POST' })
        const js = await r.json()
        if (!r.ok || !js.ok) throw new Error(js.error || ('HTTP ' + r.status))
        msg.textContent = '已启动 pid=' + js.pid; msg.className = 'pill ok'
        setTimeout(render, 400)
      } catch (err) {
        msg.textContent = '启动失败：' + (err.message || err); msg.className = 'err-box'
        startBtn.disabled = false
      }
    }
  }, '▶ 启动 pnpm dev')
  if (isRunning) startBtn.disabled = true

  const stopBtn = el('button', {
    style: 'margin-left:8px;background:' + (isRunning ? 'rgba(248,113,113,0.15)' : 'var(--panel2)') + ';border-color:' + (isRunning ? 'var(--err)' : 'var(--border)') + ';color:' + (isRunning ? 'var(--err)' : 'var(--muted)') + ';',
    onclick: async () => {
      if (!confirm('确认停止 pnpm dev？')) return
      stopBtn.disabled = true
      msg.textContent = '停止中…'; msg.className = 'muted'
      try {
        const r = await fetch('/api/dev/stop', { method: 'POST' })
        if (!r.ok) throw new Error('HTTP ' + r.status)
        msg.textContent = '已停止'; msg.className = 'pill ok'
        setTimeout(render, 400)
      } catch (err) {
        msg.textContent = '停止失败：' + (err.message || err); msg.className = 'err-box'
        stopBtn.disabled = false
      }
    }
  }, '■ 停止')
  if (!isRunning) stopBtn.disabled = true

  const startedTs = isRunning && d.startedAt ? new Date(d.startedAt).getTime() : 0
  const uptimeStr = startedTs ? (() => {
    const s = Math.floor((Date.now() - startedTs) / 1000)
    if (s < 60) return s + 's'
    if (s < 3600) return Math.floor(s/60) + 'm' + (s%60) + 's'
    return Math.floor(s/3600) + 'h' + Math.floor((s%3600)/60) + 'm'
  })() : '-'

  const cards = el('div', { class: 'row', style: 'margin:0 0 8px 0;' }, [
    el('div', { class: 'card' }, [
      el('div', { class: 'k' }, 'Status'),
      el('div', { class: 'v' }, pill(isRunning ? 'running' : 'offline', isRunning ? 'ok' : 'warn'))
    ]),
    isRunning ? el('div', { class: 'card' }, [el('div', { class: 'k' }, 'PID'), el('div', { class: 'v' }, String(d.pid))]) : null,
    isRunning ? el('div', { class: 'card' }, [el('div', { class: 'k' }, 'Uptime'), el('div', { class: 'v' }, uptimeStr)]) : null,
    !isRunning && d.lastExitCode != null ? el('div', { class: 'card' }, [
      el('div', { class: 'k' }, 'Last Exit'),
      el('div', { class: 'v small' }, 'code=' + d.lastExitCode + (d.lastExitedAt ? ' · ' + fmtTs(d.lastExitedAt) : ''))
    ]) : null,
  ])

  const logs = (d.recentLogs || [])
  const logsBox = logs.length === 0
    ? el('div', { class: 'muted', style: 'font-size:11.5px;' }, '暂无输出')
    : el('pre', { style: 'max-height:220px;font-size:11.5px;margin:6px 0 0 0;' }, logs.join('\\n'))

  // 折叠面板：默认收起，避免占用太多首屏空间
  const details = el('details', { style: 'margin-top:8px;' }, [
    el('summary', { style: 'cursor:pointer;color:var(--muted);font-size:12px;' }, '最近输出 (' + logs.length + ' 行)'),
    logsBox,
  ])

  return el('div', {
    style: 'background:var(--panel);border:1px solid var(--border);border-left:3px solid var(--accent);border-radius:6px;padding:14px 16px;margin-bottom:16px;'
  }, [
    el('div', { style: 'display:flex;align-items:center;justify-content:space-between;margin-bottom:8px;' }, [
      el('div', { style: 'font-size:14px;font-weight:600;color:var(--accent);' }, '⚡ Dev'),
      el('div', { class: 'muted', style: 'font-size:11.5px;' }, 'pnpm dev · ' + (isRunning ? '运行中' : '未启动')),
    ]),
    cards,
    el('div', { class: 'actions', style: 'margin:0;' }, [startBtn, stopBtn]),
    msg,
    details,
  ])
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
