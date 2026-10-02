/**
 * OpenAI 兼容 chat/completions 客户端（非流式）。
 *
 * 项目是纯静态站：浏览器直连供应商端点，没有后端代理。错误按类别映射成可读中文，
 * 其中网络层失败大概率是断网或供应商不允许浏览器跨域（CORS），提示里给出绕行建议。
 * 流式输出留作后续打磨，当前一次性返回全文。
 */

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
  /** assistant 消息携带的工具调用请求（OpenAI 格式原样透传） */
  toolCalls?: ToolCall[]
  /** role='tool' 时对应请求的调用 id */
  toolCallId?: string
  /** role='tool' 时对应的工具名（部分供应商要求） */
  name?: string
}

/** 工具声明（OpenAI function calling 格式，主流供应商兼容） */
export interface AiToolSpec {
  type: 'function'
  function: { name: string; description: string; parameters: Record<string, unknown> }
}

export interface ToolCall {
  id: string
  type: 'function'
  function: { name: string; arguments: string }
}

export interface AiProfileConfig {
  baseUrl: string
  model: string
  apiKey: string
}

export type AiErrorKind = 'bad-config' | 'network' | 'auth' | 'rate-limit' | 'server' | 'bad-request' | 'response'

export class AiClientError extends Error {
  readonly kind: AiErrorKind
  readonly status?: number

  constructor(kind: AiErrorKind, message: string, status?: number) {
    super(message)
    this.name = 'AiClientError'
    this.kind = kind
    this.status = status
  }
}

export interface ChatCompleteOptions {
  signal?: AbortSignal
  /** 毫秒，默认 60s；超时以 AbortError 形式归入 network 类 */
  timeoutMs?: number
  temperature?: number
  /** 限制补全长度（测试连接用小值） */
  maxTokens?: number
  /** function calling 工具声明；agent 循环使用 */
  tools?: AiToolSpec[]
}

function assertConfig(profile: AiProfileConfig): void {
  if (!profile.baseUrl.trim()) throw new AiClientError('bad-config', '请先填写 API 地址（Base URL）')
  if (!/^https?:\/\//i.test(profile.baseUrl.trim())) {
    throw new AiClientError('bad-config', 'API 地址需以 http:// 或 https:// 开头')
  }
  if (!profile.model.trim()) throw new AiClientError('bad-config', '请先填写模型名')
  if (!profile.apiKey.trim()) throw new AiClientError('bad-config', '请先填写 API Key')
}

function chatUrl(baseUrl: string): string {
  return `${baseUrl.trim().replace(/\/+$/, '')}/chat/completions`
}

interface ChatChoice {
  message?: { content?: unknown; tool_calls?: unknown }
}
interface ChatResponseShape {
  choices?: ChatChoice[]
  error?: { message?: unknown }
}

function parseToolCalls(raw: unknown): ToolCall[] | undefined {
  if (!Array.isArray(raw)) return undefined
  const calls: ToolCall[] = []
  for (const item of raw) {
    const c = item as { id?: unknown; type?: unknown; function?: { name?: unknown; arguments?: unknown } }
    if (typeof c.id === 'string' && typeof c.function?.name === 'string') {
      calls.push({
        id: c.id,
        type: 'function',
        function: { name: c.function.name, arguments: typeof c.function.arguments === 'string' ? c.function.arguments : '' },
      })
    }
  }
  return calls.length > 0 ? calls : undefined
}

/** 把 fetch/HTTP 层的失败翻译成类别 + 可读中文 */
async function raiseForResponse(res: Response): Promise<void> {
  if (res.ok) return
  let detail = ''
  try {
    const body = (await res.json()) as ChatResponseShape
    if (body && typeof body.error?.message === 'string') detail = body.error.message
  } catch {
    // 响应体不是 JSON：忽略，用状态码兜底文案
  }
  if (res.status === 401 || res.status === 403) {
    throw new AiClientError('auth', `鉴权失败（${res.status}）：请检查 API Key 是否正确。${detail}`, res.status)
  }
  if (res.status === 429) {
    throw new AiClientError('rate-limit', `请求过于频繁或额度不足（429）。${detail}`, res.status)
  }
  if (res.status >= 500) {
    throw new AiClientError('server', `供应商服务端错误（${res.status}），请稍后重试。${detail}`, res.status)
  }
  throw new AiClientError('bad-request', `请求被拒绝（${res.status}）：请检查模型名与 API 地址。${detail}`, res.status)
}

/** 把会话消息序列化成 OpenAI 兼容请求体（tool 角色附 tool_call_id） */
function serializeMessage(m: ChatMessage): Record<string, unknown> {
  const out: Record<string, unknown> = { role: m.role, content: m.content }
  if (m.toolCalls) out.tool_calls = m.toolCalls
  if (m.toolCallId) out.tool_call_id = m.toolCallId
  if (m.name) out.name = m.name
  return out
}

export interface ChatCompletionResult {
  /** 助手文本（可能为空串——纯工具调用轮） */
  content: string
  /** 非空 = 模型请求调用工具，调用方执行后以 role='tool' 消息回填继续 */
  toolCalls?: ToolCall[]
}

/** 完整版补全：保留 tool_calls 与原始结构，agent 循环使用 */
export async function chatCompleteRaw(
  profile: AiProfileConfig,
  messages: ChatMessage[],
  opts: ChatCompleteOptions = {},
): Promise<ChatCompletionResult> {
  assertConfig(profile)

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 60_000)
  const forward = () => controller.abort()
  opts.signal?.addEventListener('abort', forward)

  try {
    let res: Response
    try {
      res = await fetch(chatUrl(profile.baseUrl), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${profile.apiKey.trim()}`,
        },
        body: JSON.stringify({
          model: profile.model.trim(),
          messages: messages.map(serializeMessage),
          stream: false,
          ...(opts.temperature !== undefined ? { temperature: opts.temperature } : {}),
          ...(opts.maxTokens !== undefined ? { max_tokens: opts.maxTokens } : {}),
          ...(opts.tools && opts.tools.length > 0 ? { tools: opts.tools } : {}),
        }),
        signal: controller.signal,
      })
    } catch (err) {
      // fetch 抛 TypeError 基本是断网 / DNS / CORS 拦截——静态站无法区分，给出统一绕行建议
      if (opts.signal?.aborted) throw err
      throw new AiClientError(
        'network',
        '无法连接到供应商（可能是网络不通，或该服务不允许浏览器跨域直连）。' +
          '可改用支持浏览器直连的服务（如 OpenRouter），或在自定义供应商里填兼容代理地址。',
      )
    }
    await raiseForResponse(res)

    const data = (await res.json().catch(() => null)) as ChatResponseShape | null
    const message = data?.choices?.[0]?.message
    const content = typeof message?.content === 'string' ? message.content : ''
    const toolCalls = parseToolCalls(message?.tool_calls)
    if (!content && !toolCalls) {
      throw new AiClientError('response', '供应商返回了无法解析的响应（缺少 choices[0].message 内容）')
    }
    return { content, toolCalls }
  } finally {
    clearTimeout(timer)
    opts.signal?.removeEventListener('abort', forward)
  }
}

export async function chatComplete(
  profile: AiProfileConfig,
  messages: ChatMessage[],
  opts: ChatCompleteOptions = {},
): Promise<string> {
  const result = await chatCompleteRaw(profile, messages, opts)
  return result.content
}

export interface TestConnectionResult {
  latencyMs: number
  reply: string
}

/** 设置页「测试连接」：发一条最小对话，测延迟并回显模型应答 */
export async function testConnection(profile: AiProfileConfig, opts: ChatCompleteOptions = {}): Promise<TestConnectionResult> {
  const started = performance.now()
  const reply = await chatComplete(
    profile,
    [{ role: 'user', content: '请只回复两个字：正常' }],
    { ...opts, maxTokens: opts.maxTokens ?? 200 },
  )
  return { latencyMs: Math.round(performance.now() - started), reply: reply.trim() }
}
