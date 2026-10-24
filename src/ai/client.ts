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
  /** 附带图像（data URL，如 AI 截图）；序列化为 multimodal content 数组 */
  images?: string[]
  /** 流式中的 assistant 消息（面板渲染光标态；定稿后清除） */
  streaming?: boolean
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

/** aborted = 调用方已停止（R5/F5：进入 fetch 前预检 signal，避免「停止后仍发起新请求」）
 *  timeout = 连接/首字节/流式空闲超时（F13：与调用方中止、普通网络错误区分，给可读诊断） */
export type AiErrorKind =
  | 'bad-config'
  | 'network'
  | 'auth'
  | 'rate-limit'
  | 'server'
  | 'bad-request'
  | 'response'
  | 'aborted'
  | 'timeout'

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
  /** 连接/首字节超时（毫秒，默认 60s）；触发后抛 AiClientError kind='timeout' */
  timeoutMs?: number
  /** 流式空闲超时（毫秒，默认 30s）：两次增量之间允许的最长间隔；触发后 kind='timeout' */
  idleTimeoutMs?: number
  temperature?: number
  /** 限制补全长度（测试连接用小值） */
  maxTokens?: number
  /** function calling 工具声明；agent 循环使用 */
  tools?: AiToolSpec[]
  /** 流式输出：SSE 增量回调（content 增量文本）；最终仍返回完整结果 */
  stream?: boolean
  onDelta?: (delta: string) => void
}

function assertConfig(profile: AiProfileConfig): void {
  if (!profile.baseUrl.trim()) throw new AiClientError('bad-config', '请先填写 API 地址（Base URL）')
  if (!/^https?:\/\//i.test(profile.baseUrl.trim())) {
    throw new AiClientError('bad-config', 'API 地址需以 http:// 或 https:// 开头')
  }
  // F16：https 页面下 http 接口必被浏览器 mixed content 拦截，且报错伪装成 CORS——
  // 提前给出可读诊断（http 部署的站点不受影响）
  if (typeof location !== 'undefined' && location.protocol === 'https:' && /^http:\/\//i.test(profile.baseUrl.trim())) {
    throw new AiClientError('bad-config', '当前页面是 https，HTTP 的 API 地址会被浏览器拦截（mixed content）——请使用 https 接口地址，或改用 http 访问本站')
  }
  if (!profile.model.trim()) throw new AiClientError('bad-config', '请先填写模型名')
  if (!profile.apiKey.trim()) throw new AiClientError('bad-config', '请先填写 API Key')
}

function chatUrl(baseUrl: string): string {
  // F16（docs/40）：用户可能直接粘贴含 endpoint 的完整地址——剥除避免双重拼接 404
  const base = baseUrl.trim().replace(/\/+$/, '').replace(/\/chat\/completions$/, '')
  return `${base}/chat/completions`
}

interface ChatChoice {
  message?: { content?: unknown; tool_calls?: unknown }
}
interface ChatResponseShape {
  choices?: ChatChoice[]
  usage?: { prompt_tokens?: unknown; completion_tokens?: unknown }
  error?: { message?: unknown }
}

/** 解析响应体顶层 usage（数字才收；缺字段即 undefined——流式部分供应商不带） */
function parseUsage(raw: unknown): ChatUsage | undefined {
  const u = (raw ?? {}) as { prompt_tokens?: unknown; completion_tokens?: unknown }
  if (typeof u.prompt_tokens !== 'number' || typeof u.completion_tokens !== 'number') return undefined
  return { promptTokens: u.prompt_tokens, completionTokens: u.completion_tokens }
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

/** 把会话消息序列化成 OpenAI 兼容请求体（tool 角色附 tool_call_id；带图消息走 multimodal content 数组） */
function serializeMessage(m: ChatMessage): Record<string, unknown> {
  const out: Record<string, unknown> = { role: m.role }
  if (m.images && m.images.length > 0) {
    out.content = [
      { type: 'text', text: m.content },
      ...m.images.map((url) => ({ type: 'image_url', image_url: { url } })),
    ]
  } else {
    out.content = m.content
  }
  if (m.toolCalls) out.tool_calls = m.toolCalls
  if (m.toolCallId) out.tool_call_id = m.toolCallId
  if (m.name) out.name = m.name
  return out
}

export interface ChatUsage {
  promptTokens: number
  completionTokens: number
}

export interface ChatCompletionResult {
  /** 助手文本（可能为空串——纯工具调用轮） */
  content: string
  /** 非空 = 模型请求调用工具，调用方执行后以 role='tool' 消息回填继续 */
  toolCalls?: ToolCall[]
  /** 本次请求的 token 用量（供应商返回才有——流式部分供应商不带，缺省即无） */
  usage?: ChatUsage
}

/** 完整版补全：保留 tool_calls 与原始结构，agent 循环使用 */
export async function chatCompleteRaw(
  profile: AiProfileConfig,
  messages: ChatMessage[],
  opts: ChatCompleteOptions = {},
): Promise<ChatCompletionResult> {
  assertConfig(profile)
  // R5/F5（docs/42 §4.4）：停止信号可能在两次请求之间到达——必须在 fetch 前预检，
  // 否则已停止的 run 仍会发起新请求（AI 调试工作流被生命周期修复打断的路径之一）。
  if (opts.signal?.aborted) throw new AiClientError('aborted', '已停止。')

  const controller = new AbortController()
  const connectTimeoutMs = opts.timeoutMs ?? 60_000
  const idleTimeoutMs = opts.idleTimeoutMs ?? 30_000
  // F13：区分「连接/首字节超时」与「流式空闲超时」——前者覆盖 fetch 到首块之前，
  // 后者在每次收到增量后重置；两者都通过 abort 打断底层读取，再按阶段映射可读错误。
  let timeoutPhase: 'connect' | 'idle' | null = null
  let timer: ReturnType<typeof setTimeout> | undefined
  const arm = (phase: 'connect' | 'idle', ms: number): void => {
    if (timer !== undefined) clearTimeout(timer)
    timer = setTimeout(() => {
      timeoutPhase = phase
      controller.abort()
    }, ms)
  }
  const timeoutError = (): AiClientError => {
    const ms = timeoutPhase === 'idle' ? idleTimeoutMs : connectTimeoutMs
    const sec = Math.max(1, Math.round(ms / 1000))
    return timeoutPhase === 'idle'
      ? new AiClientError('timeout', `响应超时：连续 ${sec} 秒没有收到新的流式数据（供应商可能已断流或代理超时），请重试`)
      : new AiClientError('timeout', `请求超时：${sec} 秒内没有建立连接或收到首字节（网络慢或供应商无响应），请重试`)
  }
  const forward = () => controller.abort()
  opts.signal?.addEventListener('abort', forward)
  arm('connect', connectTimeoutMs)

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
          stream: opts.stream === true,
          ...(opts.temperature !== undefined ? { temperature: opts.temperature } : {}),
          ...(opts.maxTokens !== undefined ? { max_tokens: opts.maxTokens } : {}),
          ...(opts.tools && opts.tools.length > 0 ? { tools: opts.tools } : {}),
        }),
        signal: controller.signal,
      })
    } catch (err) {
      // 调用方主动停止优先：保持原有 AbortError 透传语义（agent/面板据此显示「已停止」）
      if (opts.signal?.aborted) throw err
      if (timeoutPhase !== null) throw timeoutError()
      // fetch 抛 TypeError 基本是断网 / DNS / CORS 拦截——静态站无法区分，给出统一绕行建议
      throw new AiClientError(
        'network',
        '无法连接到供应商（可能是网络不通，或该服务不允许浏览器跨域直连）。' +
          '可改用支持浏览器直连的服务（如 OpenRouter），或在自定义供应商里填兼容代理地址。',
      )
    }
    await raiseForResponse(res)

    // F13：首字节到达后不再用「总时长」卡住长回复——每收到一块增量重置空闲计时
    arm('idle', idleTimeoutMs)
    if (opts.stream === true) {
      try {
        return await consumeSseStream(res, opts, {
          signal: controller.signal,
          onActivity: () => arm('idle', idleTimeoutMs),
        })
      } catch (err) {
        if (err instanceof AiClientError) throw err
        if (opts.signal?.aborted) throw err
        if (timeoutPhase !== null) throw timeoutError()
        // 保留底层错误详情便于诊断（agent.test 既有断言依赖原文），外层给可读中文
        const detail = err instanceof Error && err.message ? `（${err.message}）` : ''
        throw new AiClientError('network', `流式响应读取中断${detail}：网络断开或代理超时，请重试`)
      }
    }

    let data: ChatResponseShape | null = null
    try {
      data = (await res.json()) as ChatResponseShape
    } catch {
      if (timeoutPhase !== null) throw timeoutError()
      // 非 JSON/响应体读取失败：交给下面的「无法解析」错误统一处理
    }
    const message = data?.choices?.[0]?.message
    const content = typeof message?.content === 'string' ? message.content : ''
    const toolCalls = parseToolCalls(message?.tool_calls)
    if (!content && !toolCalls) {
      throw new AiClientError('response', '供应商返回了无法解析的响应（缺少 choices[0].message 内容）')
    }
    return { content, toolCalls, usage: parseUsage(data?.usage) }
  } finally {
    if (timer !== undefined) clearTimeout(timer)
    opts.signal?.removeEventListener('abort', forward)
  }
}

interface SseDelta {
  content?: string | null
  tool_calls?: Array<{ index?: number; id?: string; function?: { name?: string; arguments?: string } }>
}

/**
 * 解析 OpenAI 兼容 SSE 流（data: {...} 行 / data: [DONE] 终止）：
 * 增量 content 经 onDelta 回调，tool_calls 按 index 增量拼接（id/name 首块、arguments 追加），
 * chunk 顶层 usage（部分供应商随末块返回）最后一块覆盖，
 * 最终返回与非流式一致的完整结果。
 */
async function consumeSseStream(
  res: Response,
  opts: { onDelta?: (delta: string) => void },
  hooks: { signal?: AbortSignal; onActivity?: () => void } = {},
): Promise<ChatCompletionResult> {
  if (!res.body) throw new AiClientError('response', '供应商流式响应没有内容体')
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let content = ''
  let usage: ChatUsage | undefined
  const toolAcc = new Map<number, { id: string; function: { name: string; arguments: string } }>()

  /**
   * F13：读取与 abort 竞速——底层 body 在部分环境/供应商实现里不会因 fetch signal 中止
   * 而立即 reject，若只等 reader.read()，空闲超时后仍可能永久挂起。
   */
  const readWithAbort = async (): Promise<ReadableStreamReadResult<Uint8Array>> => {
    const signal = hooks.signal
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')
    const readPromise = reader.read()
    if (!signal) return readPromise
    // 竞速失败方（abort 后的 readPromise）可能稍后 reject：挂接 catch 防未处理拒绝
    void readPromise.catch(() => {})
    let onAbort: (() => void) | undefined
    const aborted = new Promise<never>((_, reject) => {
      onAbort = () => reject(new DOMException('Aborted', 'AbortError'))
      signal.addEventListener('abort', onAbort, { once: true })
    })
    try {
      return await Promise.race([readPromise, aborted])
    } finally {
      if (onAbort) signal.removeEventListener('abort', onAbort)
    }
  }

  const handleChunk = (chunkText: string): void => {
    for (const rawLine of chunkText.split('\n')) {
      const line = rawLine.trim()
      if (line === '' || !line.startsWith('data:')) continue
      const data = line.slice(5).trim()
      if (data === '[DONE]') continue
      let parsed: { choices?: Array<{ delta?: SseDelta }>; usage?: unknown }
      try {
        parsed = JSON.parse(data)
      } catch {
        continue // 心跳/注释等非 JSON 行
      }
      if (parsed.usage) usage = parseUsage(parsed.usage)
      const delta = parsed.choices?.[0]?.delta
      if (!delta) continue
      if (typeof delta.content === 'string' && delta.content !== '') {
        content += delta.content
        opts.onDelta?.(delta.content)
      }
      for (const tc of delta.tool_calls ?? []) {
        const idx = typeof tc.index === 'number' ? tc.index : 0
        const acc = toolAcc.get(idx) ?? { id: '', function: { name: '', arguments: '' } }
        if (typeof tc.id === 'string') acc.id = tc.id
        if (typeof tc.function?.name === 'string') acc.function.name += tc.function.name
        if (typeof tc.function?.arguments === 'string') acc.function.arguments += tc.function.arguments
        toolAcc.set(idx, acc)
      }
    }
  }

  try {
    for (;;) {
      const { done, value } = await readWithAbort()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      // F13：收到数据即重置空闲计时（首块后 arm('idle')；后续每块续命）
      hooks.onActivity?.()
      const nl = buffer.lastIndexOf('\n')
      if (nl === -1) continue
      handleChunk(buffer.slice(0, nl + 1))
      buffer = buffer.slice(nl + 1)
    }
    handleChunk(buffer + '\n')
  } finally {
    reader.releaseLock()
  }

  const toolCalls: ToolCall[] = [...toolAcc.values()]
    .filter((t) => t.id !== '' && t.function.name !== '')
    .map((t) => ({ id: t.id, type: 'function' as const, function: t.function }))
  if (content === '' && toolCalls.length === 0) {
    throw new AiClientError('response', '供应商流式响应没有产出内容')
  }
  return { content, toolCalls: toolCalls.length > 0 ? toolCalls : undefined, usage }
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
