/**
 * 后端 API 客户端（docs/31 §7）：薄 fetch 封装——同源 Cookie、超时、
 * 错误信封 {error:{code,message}} 解析为中文消息、网络不可达归类为
 * ApiUnavailableError（账户区据此显示「云端不可用」降级态）。
 * 仿 src/ai/client.ts 的错误分类 + AbortController 惯例。
 */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status: number,
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

/** 后端不可达（离线 / 未部署 / 超时）：与业务错误区分，调用方按降级处理 */
export class ApiUnavailableError extends Error {
  constructor() {
    super('无法连接云端服务')
    this.name = 'ApiUnavailableError'
  }
}

export interface ApiInit {
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE'
  body?: unknown
  timeoutMs?: number
}

export async function apiFetch<T>(path: string, init: ApiInit = {}): Promise<T> {
  const { method = 'GET', body, timeoutMs = 10_000 } = init
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(path, {
      method,
      headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    })
    let data: unknown = null
    try {
      data = await res.json()
    } catch {
      // 空响应体按 null 处理，走下方 ok/错误分支
    }
    if (!res.ok) {
      const err = (data as { error?: { code?: string; message?: string } } | null)?.error
      throw new ApiError(err?.message ?? `请求失败（${res.status}）`, err?.code ?? 'unknown', res.status)
    }
    return data as T
  } catch (err) {
    if (err instanceof ApiError) throw err
    throw new ApiUnavailableError()
  } finally {
    clearTimeout(timer)
  }
}
