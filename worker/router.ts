import type { Env } from './types'

export interface RouteContext {
  req: Request
  env: Env
  /** 路径参数（`:id` 段捕获） */
  params: Record<string, string>
}

export type RouteHandler = (ctx: RouteContext) => Promise<Response> | Response

interface Route {
  method: string
  segments: string[]
  handler: RouteHandler
}

/** 极简路由：'GET /api/auth/me'、'DELETE /api/cloud/levels/:id' 形态的静态段 + 参数段 */
export class Router {
  private routes: Route[] = []

  add(method: string, pattern: string, handler: RouteHandler): this {
    this.routes.push({
      method: method.toUpperCase(),
      segments: pattern.split('/').filter(Boolean),
      handler,
    })
    return this
  }

  /** 匹配并执行；无匹配返回 null（调用方决定 API 404 还是回落静态资产） */
  async handle(req: Request, env: Env): Promise<Response | null> {
    const url = new URL(req.url)
    const parts = url.pathname.split('/').filter(Boolean)
    for (const route of this.routes) {
      if (route.method !== req.method.toUpperCase()) continue
      if (route.segments.length !== parts.length) continue
      const params: Record<string, string> = {}
      let matched = true
      for (let i = 0; i < route.segments.length; i++) {
        const seg = route.segments[i]
        if (seg.startsWith(':')) {
          params[seg.slice(1)] = decodeURIComponent(parts[i])
        } else if (seg !== parts[i]) {
          matched = false
          break
        }
      }
      if (!matched) continue
      return route.handler({ req, env, params })
    }
    return null
  }
}
