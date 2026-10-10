/** 带 code 的 HTTP 错误：handler 抛出，入口统一转为错误信封 {error:{code,message}} */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = 'HttpError'
  }
}

export function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  })
}

export function errorJson(status: number, code: string, message: string): Response {
  return jsonResponse({ error: { code, message } }, status)
}

/**
 * 读取 JSON 请求体（docs/31 §6.5）：Content-Length 预检 + 实读字节双查上限。
 * 非法 JSON / 非对象 / 空体一律 400，超限 413。
 */
export async function readJsonBody(req: Request, maxBytes: number): Promise<Record<string, unknown>> {
  const lenHeader = req.headers.get('Content-Length')
  if (lenHeader !== null && Number(lenHeader) > maxBytes) {
    throw new HttpError(413, 'too_large', `请求体超过上限（${maxBytes} 字节）`)
  }
  const text = await req.text()
  if (text.length > maxBytes) {
    throw new HttpError(413, 'too_large', `请求体超过上限（${maxBytes} 字节）`)
  }
  if (text.length === 0) {
    throw new HttpError(400, 'bad_request', '请求体不能为空')
  }
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    throw new HttpError(400, 'bad_request', '请求体不是合法 JSON')
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new HttpError(400, 'bad_request', '请求体必须是 JSON 对象')
  }
  return value as Record<string, unknown>
}

/**
 * CSRF 防线（docs/31 §6.3）：写方法携带 Origin 时，其 host:port 必须与 Host 一致。
 * 生产同源天然通过；vite 代理开发态 Host 保留前端端口、与 Origin 一致亦通过；
 * 无 Origin 的非浏览器客户端放行（CSRF 威胁模型只针对浏览器承载的跨站请求）。
 */
export function assertSameOrigin(req: Request): void {
  const method = req.method.toUpperCase()
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return
  const origin = req.headers.get('Origin')
  if (!origin) return
  const host = req.headers.get('Host') ?? new URL(req.url).host
  let originHost: string
  try {
    originHost = new URL(origin).host
  } catch {
    throw new HttpError(403, 'bad_origin', 'Origin 头非法')
  }
  if (originHost !== host) {
    throw new HttpError(403, 'bad_origin', '跨站请求被拒绝')
  }
}
