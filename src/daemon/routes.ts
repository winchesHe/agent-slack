// daemon HTTP 路由：/api/daemon/state /api/daemon/stop /api/daemon/abort/:id
// 由 dashboard server 在 daemon 模式下挂载
import type http from 'node:http'
import type { Application } from '@/application/types.ts'

export interface DaemonContext {
  app: Application
  startedAt: string
  version: string
  cwd: string
}

export interface DaemonStatePayload {
  pid: number
  startedAt: string
  version: string
  cwd: string
  uptimeMs: number
  inflight: {
    count: number
    keys: string[]
  }
}

export function buildDaemonState(ctx: DaemonContext): DaemonStatePayload {
  return {
    pid: process.pid,
    startedAt: ctx.startedAt,
    version: ctx.version,
    cwd: ctx.cwd,
    uptimeMs: Date.now() - new Date(ctx.startedAt).getTime(),
    inflight: {
      count: ctx.app.abortRegistry.size(),
      keys: ctx.app.abortRegistry.keys(),
    },
  }
}

export interface DaemonRouteResult {
  status: number
  body: unknown
}

export async function handleDaemonRoute(
  req: http.IncomingMessage,
  pathname: string,
  ctx: DaemonContext,
): Promise<DaemonRouteResult | null> {
  // GET /api/daemon/state
  if (req.method === 'GET' && pathname === '/api/daemon/state') {
    return { status: 200, body: buildDaemonState(ctx) }
  }

  // POST /api/daemon/stop
  if (req.method === 'POST' && pathname === '/api/daemon/stop') {
    // 下一 tick 向自己发 SIGTERM，利用已有 entry.ts 的 shutdown 流程
    setImmediate(() => {
      try {
        process.kill(process.pid, 'SIGTERM')
      } catch {
        // ignore
      }
    })
    return { status: 202, body: { ok: true, message: 'stop scheduled' } }
  }

  // POST /api/daemon/abort/:id
  {
    const m = pathname.match(/^\/api\/daemon\/abort\/(.+)$/)
    if (m && req.method === 'POST') {
      const id = decodeURIComponent(m[1] ?? '')
      if (!id) return { status: 400, body: { error: 'missing id' } }
      ctx.app.abortRegistry.abort(id, 'aborted-via-daemon-api')
      return { status: 200, body: { ok: true, aborted: id } }
    }
  }

  return null
}
