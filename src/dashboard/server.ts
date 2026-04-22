// Dashboard HTTP server：原生 node:http，只暴露在 127.0.0.1。
// 路由规则：/api/* 返回 JSON（由 DashboardApi 提供），其余走 SPA 壳（返回 index.html）。
// 设计为"零新依赖 + 可离线"，便于未来加 daemon 面板时直接扩展 API。

import http from 'node:http'
import { URL } from 'node:url'
import type { Logger } from '@/logger/logger.ts'
import { createDashboardApi, type DashboardApi } from './api.ts'
import { renderIndexHtml } from './ui.ts'

export interface DashboardServerOptions {
  cwd: string
  host?: string
  port?: number
  logger: Logger
}

export interface DashboardServer {
  url: string
  api: DashboardApi
  stop(): Promise<void>
}

export async function startDashboardServer(opts: DashboardServerOptions): Promise<DashboardServer> {
  const host = opts.host ?? '127.0.0.1'
  const port = opts.port ?? 0 // 0 = 让 OS 挑一个空闲端口，避免端口冲突
  const log = opts.logger.withTag('dashboard-http')
  const api = createDashboardApi(opts.cwd, opts.logger)

  const server = http.createServer((req, res) => {
    void handle(req, res, api, log).catch((err) => {
      log.error('handler 异常', err)
      if (!res.headersSent) {
        res.statusCode = 500
        res.setHeader('content-type', 'application/json; charset=utf-8')
        res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }))
      } else {
        res.end()
      }
    })
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, host, () => resolve())
  })

  const addr = server.address()
  const actualPort = typeof addr === 'object' && addr ? addr.port : port
  const url = `http://${host}:${actualPort}`

  return {
    url,
    api,
    async stop() {
      await new Promise<void>((resolve) => {
        server.close(() => resolve())
      })
    },
  }
}

async function handle(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  api: DashboardApi,
  log: Logger,
): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost')
  const pathname = url.pathname

  const json = (body: unknown, status = 200): void => {
    res.statusCode = status
    res.setHeader('content-type', 'application/json; charset=utf-8')
    res.setHeader('cache-control', 'no-store')
    res.end(JSON.stringify(body))
  }

  const notFound = (): void => json({ error: 'not_found' }, 404)

  log.debug(`${req.method} ${pathname}`)

  // --- 写操作（PUT / DELETE）：先处理，命中直接 return ---
  // 限制 body 最大 1 MB，避免占用大量内存
  const readBody = async (): Promise<string> => {
    return new Promise<string>((resolve, reject) => {
      const chunks: Buffer[] = []
      let size = 0
      req.on('data', (c: Buffer) => {
        size += c.length
        if (size > 1024 * 1024) {
          reject(new Error('body too large (max 1MB)'))
          return
        }
        chunks.push(c)
      })
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
      req.on('error', reject)
    })
  }

  if (req.method === 'PUT' && pathname === '/api/config') {
    try {
      const body = await readBody()
      const result = await api.updateConfig(body)
      return json(result)
    } catch (err) {
      return json({ error: err instanceof Error ? err.message : String(err) }, 400)
    }
  }
  if (req.method === 'DELETE' && pathname === '/api/config') {
    return json(await api.deleteConfig())
  }
  if (req.method === 'PUT' && pathname === '/api/system-prompt') {
    try {
      const body = await readBody()
      const result = await api.updateSystemPrompt(body)
      return json(result)
    } catch (err) {
      return json({ error: err instanceof Error ? err.message : String(err) }, 400)
    }
  }
  if (req.method === 'DELETE' && pathname === '/api/system-prompt') {
    return json(await api.deleteSystemPrompt())
  }

  if (req.method !== 'GET') {
    json({ error: 'method_not_allowed' }, 405)
    return
  }

  if (pathname === '/' || pathname === '/index.html') {
    res.statusCode = 200
    res.setHeader('content-type', 'text/html; charset=utf-8')
    res.setHeader('cache-control', 'no-store')
    res.end(renderIndexHtml())
    return
  }

  // SSE：每 5s 推一次 overview（轻量聚合），前端收到就重渲染当前 tab
  if (pathname === '/api/stream') {
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    })
    res.write('retry: 5000\n\n')
    let closed = false
    const push = async (): Promise<void> => {
      if (closed) return
      try {
        const data = await api.overview()
        res.write(`event: tick\ndata: ${JSON.stringify(data)}\n\n`)
      } catch (err) {
        log.debug('stream tick 失败', err)
      }
    }
    void push()
    const timer = setInterval(() => {
      void push()
    }, 5000)
    req.on('close', () => {
      closed = true
      clearInterval(timer)
    })
    return
  }

  // API 路由
  if (pathname === '/api/overview') return json(await api.overview())
  if (pathname === '/api/config') return json(await api.config())
  if (pathname === '/api/system-prompt') return json(await api.systemPrompt())
  if (pathname === '/api/skills') return json(await api.skills())
  if (pathname === '/api/sessions') return json(await api.sessions())
  if (pathname === '/api/memory') return json(await api.memory())
  if (pathname === '/api/logs') return json(await api.logs())
  if (pathname === '/api/health') return json(await api.health())
  if (pathname === '/api/daemon') return json(await api.daemon())

  // /api/skills/:name
  {
    const m = pathname.match(/^\/api\/skills\/(.+)$/)
    if (m) {
      const name = decodeURIComponent(m[1] ?? '')
      const s = await api.skillDetail(name)
      return s ? json(s) : notFound()
    }
  }

  // /api/sessions/:id/messages
  {
    const m = pathname.match(/^\/api\/sessions\/([^/]+)\/messages$/)
    if (m) {
      const id = decodeURIComponent(m[1] ?? '')
      const offset = Math.max(0, Number(url.searchParams.get('offset') ?? '0') | 0)
      const limit = Math.max(1, Math.min(500, Number(url.searchParams.get('limit') ?? '100') | 0))
      const r = await api.sessionMessages(id, offset, limit)
      return r ? json(r) : notFound()
    }
  }

  // /api/memory/:file
  {
    const m = pathname.match(/^\/api\/memory\/(.+)$/)
    if (m) {
      const file = decodeURIComponent(m[1] ?? '')
      const r = await api.memoryDetail(file)
      return r ? json(r) : notFound()
    }
  }

  // /api/logs/:file
  {
    const m = pathname.match(/^\/api\/logs\/(.+)$/)
    if (m) {
      const file = decodeURIComponent(m[1] ?? '')
      const tail = Math.max(1, Math.min(5000, Number(url.searchParams.get('tail') ?? '500') | 0))
      const r = await api.logTail(file, tail)
      return r ? json(r) : notFound()
    }
  }

  notFound()
}
