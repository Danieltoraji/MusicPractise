/**
 * Agent 循环：chat → tool_calls → 本地执行 → 回填 → 继续，直至模型给出文本回复。
 * 批次1 仅注册只读工具（ask 模式）；批次2 的写工具走同一循环。
 * 会话消息实时写入 session store（面板订阅渲染）；每关一个并发控制器支持停止。
 */

import { AiClientError, chatCompleteRaw, type AiProfileConfig, type AiToolSpec, type ChatMessage } from './client'
import { addSessionUsage, appendMessage, beginStreamingMessage, finalizeStreamingMessage, getSession, patchSession, replaceLastMessage, streamAppendToLast } from './session'
import type { AiTool, ToolContext } from './tools'
import type { LevelDoc } from '../engine/level'

const controllers = new Map<string, AbortController>()

/** 单次请求下发的消息条数上限（不含 system；超出只下发最近窗口——面板仍显示完整历史，批次8c） */
const MODEL_MSG_LIMIT = 120
/** 窗口内最近多少条消息保全量；更早的 tool 结果压缩截断（轮数预算提升后防长任务上下文爆炸/失忆） */
const FULL_TAIL = 48
/** 远期 tool 结果保留的字符数 */
const OLD_TOOL_KEEP = 200

/** 远期（非最近 FULL_TAIL 条）tool 结果压缩为前 OLD_TOOL_KEEP 字符；结构与 tool_call_id 配对原样保留 */
function compressOld(msg: ChatMessage, index: number, arr: ChatMessage[]): ChatMessage {
  if (index < arr.length - FULL_TAIL && msg.role === 'tool' && msg.content.length > OLD_TOOL_KEEP) {
    return { ...msg, content: `${msg.content.slice(0, OLD_TOOL_KEEP)}\n…（早期工具结果已截断，如需完整内容请重新读取）` }
  }
  return msg
}

/** 下发前清洗：流式中断残留的 streaming 占位与空 assistant（无内容也无 tool_calls）不发给模型（docs/40 F2） */
function usableForModel(m: ChatMessage): boolean {
  if (m.role !== 'assistant') return true
  if (m.streaming === true) return false
  return m.content.trim() !== '' || (m.toolCalls?.length ?? 0) > 0
}

/**
 * 组装发给模型的请求消息：system + 最近窗口。
 * 超限时窗口起点前进到第一条 user 消息——不能从 assistant(tool_calls)/tool 对中间切开，
 * 否则 tool 消息失去前置 tool_calls，严格供应商会 4xx。只影响下发副本，不动会话。
 */
export function buildModelMessages(systemPrompt: string, history: ChatMessage[]): ChatMessage[] {
  const usable = history.filter(usableForModel)
  if (usable.length <= MODEL_MSG_LIMIT) return [{ role: 'system', content: systemPrompt }, ...usable.map(compressOld)]
  let start = usable.length - MODEL_MSG_LIMIT
  while (start < usable.length && usable[start].role !== 'user') start++
  if (start >= usable.length) {
    // 窗口内没有 user 消息（极端情况）：保完整历史，宁可偏长不可断对
    return [{ role: 'system', content: systemPrompt }, ...usable.map(compressOld)]
  }
  return [
    { role: 'system', content: systemPrompt },
    { role: 'system', content: `（更早的 ${start} 条消息已省略以控制上下文长度；如需更早的细节请让用户重新提供。）` },
    ...usable.slice(start).map(compressOld),
  ]
}

/** 面板「停止」按钮：中断当前轮的 fetch（工具执行为本地纯函数不中断） */
export function stopAgent(docId: string): void {
  controllers.get(docId)?.abort()
}

export interface AgentTurnOptions {
  docId: string
  profile: AiProfileConfig
  /** System prompt；传函数则每轮请求前以「运行内最新 doc」现算（读取运行中途新增组件的契约清单） */
  systemPrompt: string | ((doc: LevelDoc) => string)
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
    // 运行内写通道：applyDoc 经编辑器 React state 异步提交（getDoc 的外部引用要等渲染期才更新），
    // 同轮多写入时后一个工具会读到旧快照互相覆盖；面板实例中途重挂（dock 拖拽/tab 切换/调试布局/
    // HMR）后其引用更是永久停摆。runDoc 让本轮读写始终基于最新已应用结果，不依赖外部引用的存活与提交时序。
    let runDoc: LevelDoc | null = null
    // F1（docs/40）：外部（编辑器）doc 引用跟踪。applyDoc 是异步提交（React 渲染滞后），
    // 写入瞬间的外部引用记为 lastSeenExternal——检测时 external 与「影子最新值」和
    // 「最后一次写入时看到的值」都不同 = 创作者手动改过文档
    let lastSeenExternal = opts.ctx.getDoc()
    const ctx: ToolContext = {
      ...opts.ctx,
      getDoc: () => runDoc ?? opts.ctx.getDoc(),
      applyDoc: (next) => {
        runDoc = next
        lastSeenExternal = opts.ctx.getDoc()
        opts.ctx.applyDoc(next)
      },
      emitImages: (imgs) => {
        // F15：工具产出图片设上限（会话随消息持久化 IndexedDB，无上限会撑爆配额）
        const room = Math.max(0, 12 - imageBuffer.length)
        imageBuffer.push(...imgs.slice(0, room))
      },
      signal: ctrl.signal, // F5/C4：本地工具可感知停止（长等待点提前收尾）
    }

    for (let turn = 0; turn < maxTurns; turn++) {
      // System prompt 每轮现算（函数形态）：runDoc 是运行内最新 doc——中途新增组件的契约当轮即可见
      const sys = typeof opts.systemPrompt === 'function' ? opts.systemPrompt(runDoc ?? opts.ctx.getDoc()) : opts.systemPrompt
      // 流式：先落一条 streaming 占位消息，delta 打字机填充，完成后用最终消息替换
      if (opts.stream) beginStreamingMessage(opts.docId)
      const res = await chatCompleteRaw(opts.profile, buildModelMessages(sys, history), {
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
        // F1：写工具执行后检测创作者同栈手动编辑——检测到则附提醒，让模型先重读再继续，
        // 而不是基于幻影状态继续写（此前静默覆盖用户改动）
        if (runDoc !== null) {
          const external = opts.ctx.getDoc()
          if (external !== runDoc && external !== lastSeenExternal) {
            lastSeenExternal = external
            result += '\n⚠ 警告：检测到创作者刚刚在编辑器中手动修改了关卡（编辑器文档与你的工作副本已不一致）。' +
              '你基于旧状态做的后续修改可能覆盖其改动——请先 read_doc / read_script 重新读取现状再继续，必要时向创作者说明。'
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
    // 流式中断/失败收尾：移除或定稿 streaming 占位、清未刷 delta（docs/40 F2），
    // 否则幽灵占位留在会话（光标永久闪烁）且下次重试会把它发给供应商
    if (opts.stream) finalizeStreamingMessage(opts.docId)
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
