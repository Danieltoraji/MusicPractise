/**
 * Agent 循环：chat → tool_calls → 本地执行 → 回填 → 继续，直至模型给出文本回复。
 * 批次1 仅注册只读工具（ask 模式）；批次2 的写工具走同一循环。
 * 会话消息实时写入 session store（面板订阅渲染）；每关一个并发控制器支持停止。
 */

import { AiClientError, chatCompleteRaw, type AiProfileConfig, type AiToolSpec, type ChatMessage } from './client'
import { addSessionUsage, appendMessage, beginStreamingMessage, getSession, patchSession, replaceLastMessage, streamAppendToLast } from './session'
import type { AiTool, ToolContext } from './tools'

const controllers = new Map<string, AbortController>()

/** 单次请求下发的消息条数上限（不含 system；超出只下发最近窗口——面板仍显示完整历史，批次8c） */
const MODEL_MSG_LIMIT = 60

/**
 * 组装发给模型的请求消息：system + 最近窗口。
 * 超限时窗口起点前进到第一条 user 消息——不能从 assistant(tool_calls)/tool 对中间切开，
 * 否则 tool 消息失去前置 tool_calls，严格供应商会 4xx。只影响下发副本，不动会话。
 */
export function buildModelMessages(systemPrompt: string, history: ChatMessage[]): ChatMessage[] {
  if (history.length <= MODEL_MSG_LIMIT) return [{ role: 'system', content: systemPrompt }, ...history]
  let start = history.length - MODEL_MSG_LIMIT
  while (start < history.length && history[start].role !== 'user') start++
  if (start >= history.length) {
    // 窗口内没有 user 消息（极端情况）：保完整历史，宁可偏长不可断对
    return [{ role: 'system', content: systemPrompt }, ...history]
  }
  return [
    { role: 'system', content: systemPrompt },
    { role: 'system', content: `（更早的 ${start} 条消息已省略以控制上下文长度；如需更早的细节请让用户重新提供。）` },
    ...history.slice(start),
  ]
}

/** 面板「停止」按钮：中断当前轮的 fetch（工具执行为本地纯函数不中断） */
export function stopAgent(docId: string): void {
  controllers.get(docId)?.abort()
}

export interface AgentTurnOptions {
  docId: string
  profile: AiProfileConfig
  systemPrompt: string
  /** 用户输入（调用方已拼好选中上下文前缀）；不传/空 = 不追加 user 消息（失败重试时直接续跑现有历史） */
  userText?: string
  /** 随本轮 user 消息附带的图片（data URL；用户附图/多模态） */
  images?: string[]
  tools: AiTool[]
  ctx: ToolContext
  /** 单次提问最多工具调用轮数，防失控 */
  maxTurns?: number
  /** 流式输出：chat 走 SSE，assistant 消息在会话中打字机式增长（批次6a） */
  stream?: boolean
}

function toSpecs(tools: AiTool[]): AiToolSpec[] {
  return tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } }))
}

/** 执行一轮完整对话（可能包含多次工具调用）；返回时 busy 已复位 */
export async function runAgentTurn(opts: AgentTurnOptions): Promise<void> {
  const session = getSession(opts.docId)
  if (session.busy) return // 同一关卡防重入（面板同时禁用发送按钮，双保险）

  const ctrl = new AbortController()
  controllers.set(opts.docId, ctrl)
  patchSession(opts.docId, { busy: true, error: null })
  if (opts.userText) {
    appendMessage(opts.docId, {
      role: 'user',
      content: opts.userText,
      images: opts.images && opts.images.length > 0 ? opts.images : undefined,
    })
  }

  try {
    const maxTurns = opts.maxTurns ?? 8
    patchSession(opts.docId, { turnCount: 0, turnCapHit: false })
    // 本轮对话的本地副本（会话真源由 session store 维护）；每次请求前按预算重新组装下发消息
    const history: ChatMessage[] = [...getSession(opts.docId).messages]
    const specs = toSpecs(opts.tools)
    // 工具产生的图像（如 debug_screenshot）缓冲；一轮工具结果消费完后以带图 user 消息发给多模态模型
    const imageBuffer: string[] = []
    const ctx: ToolContext = {
      ...opts.ctx,
      emitImages: (imgs) => imageBuffer.push(...imgs),
    }

    for (let turn = 0; turn < maxTurns; turn++) {
      // 流式：先落一条 streaming 占位消息，delta 打字机填充，完成后用最终消息替换
      if (opts.stream) beginStreamingMessage(opts.docId)
      const res = await chatCompleteRaw(opts.profile, buildModelMessages(opts.systemPrompt, history), {
        tools: specs,
        signal: ctrl.signal,
        stream: opts.stream === true,
        onDelta: opts.stream ? (d) => streamAppendToLast(opts.docId, d) : undefined,
      })
      addSessionUsage(opts.docId, res.usage)
      patchSession(opts.docId, { turnCount: turn + 1 })
      const finalMsg: ChatMessage = { role: 'assistant', content: res.content, toolCalls: res.toolCalls }
      history.push(finalMsg)
      if (opts.stream) replaceLastMessage(opts.docId, finalMsg)
      else appendMessage(opts.docId, finalMsg)
      if (!res.toolCalls || res.toolCalls.length === 0) return // 文本回复 = 本轮结束

      for (const call of res.toolCalls) {
        const tool = opts.tools.find((t) => t.name === call.function.name)
        let result: string
        if (!tool) {
          result = `错误：未知工具「${call.function.name}」。可用工具：${opts.tools.map((t) => t.name).join('、')}`
        } else {
          try {
            const args = call.function.arguments.trim() ? (JSON.parse(call.function.arguments) as Record<string, unknown>) : {}
            result = await tool.exec(args, ctx)
          } catch (err) {
            result = `工具执行出错：${err instanceof Error ? err.message : String(err)}`
          }
        }
        const msg: ChatMessage = { role: 'tool', toolCallId: call.id, name: call.function.name, content: result }
        history.push(msg)
        appendMessage(opts.docId, msg)
      }

      // 截图等工具产出的图像：以带图 user 消息附给多模态模型（面板同步展示）
      if (imageBuffer.length > 0) {
        const msg: ChatMessage = {
          role: 'user',
          content: '（以下是刚才工具截取的屏幕截图，请结合它继续分析）',
          images: [...imageBuffer],
        }
        imageBuffer.length = 0
        history.push(msg)
        appendMessage(opts.docId, msg)
      }
    }
    appendMessage(opts.docId, {
      role: 'assistant',
      content: `（已达单次任务轮数上限（${maxTurns} 轮），自动停止。任务未完可点「▶ 继续」接着当前进度跑，或直接补充新要求。）`,
    })
    patchSession(opts.docId, { turnCapHit: true })
  } catch (err) {
    let message: string
    if (ctrl.signal.aborted) message = '已停止。'
    else if (err instanceof AiClientError) message = err.message
    else message = err instanceof Error ? err.message : String(err)
    patchSession(opts.docId, { error: message })
  } finally {
    controllers.delete(opts.docId)
    patchSession(opts.docId, { busy: false })
  }
}
