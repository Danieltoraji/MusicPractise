/**
 * MusicPractise Worker 入口（docs/31）：/api/* 进路由分发，其余路径回落静态资产。
 * 错误统一收口：HttpError → 对应状态码信封；未知错误 → 500 信封（不泄漏内部细节）。
 * 会话/认证路由在 handlers/auth.ts 注册（本文件只保留骨架与兜底）。
 */
import { errorJson, jsonResponse, HttpError } from './http'
import { Router } from './router'
import { changePassword, login, logout, me, register, updateNickname } from './handlers/auth'
import type { Env, ExecutionContext } from './types'

const api = new Router()

api.add('GET', '/api/health', () => jsonResponse({ ok: true, time: Date.now() }))

api.add('POST', '/api/auth/register', register)
api.add('POST', '/api/auth/login', login)
api.add('POST', '/api/auth/logout', logout)
api.add('GET', '/api/auth/me', me)
api.add('PATCH', '/api/auth/nickname', updateNickname)
api.add('POST', '/api/auth/password', changePassword)

export default {
  async fetch(req: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    try {
      const url = new URL(req.url)
      if (url.pathname === '/api' || url.pathname.startsWith('/api/')) {
        const res = await api.handle(req, env)
        return res ?? errorJson(404, 'not_found', '接口不存在')
      }
      return env.ASSETS.fetch(req)
    } catch (err) {
      if (err instanceof HttpError) return errorJson(err.status, err.code, err.message)
      console.error('[api] 未处理错误:', err)
      return errorJson(500, 'internal', '服务内部错误，请稍后再试')
    }
  },
}
