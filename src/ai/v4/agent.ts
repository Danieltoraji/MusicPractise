/**
 * v4 AI agent 循环（W8.3）：chat → tool_calls → 本地执行 → 回填 → 继续，直至模型给出文本回复。
 *
 * 与 v3 `src/ai/agent.ts` 的分工：
 * - 复用 `src/ai/client`（OpenAI 兼容客户端）与 `src/ai/session`（按 docId 键控的会话 store）；
 * - 工具上下文换成 v4 的 `V4ToolContext`（按层读写），本文件负责运行内「影子文档」与 revision 冲突门：
 *   写工具的 applyDoc 经宿主（编辑器唯一写路径）落地，同时更新本次 run 的读写基准；
 * - 宿主既可以是 AiPanelV4（面板卸载后 run 继续，写通道经 ref 指向编辑器 update），
 *   也可以是后续无头/测试宿主。
 *
 * 消息窗口压缩与 v3 同语义（下发最近 120 条、最近 48 条全量、更早 tool 结果截 200 字符、
 * 不拆 assistant(tool_calls)/tool 对）——v4 自包含，W9 删除 v3 模块时本文件不受影响。
 */
import type { LevelDocV4 } from '../../engine/v4/model'
import {
  AiClientError,
  chatCompleteRaw,
  type AiProfileConfig,
  type AiToolSpec,
  type ChatMessage,
} from '../client'
import {
  addSessionUsage,
  appendMessage,
  getSession,
  patchSession,
} from '../session'
import { buildV4SystemPrompt } from './prompts'
import { createRevisionGuard, getV4Tools, type AiToolV4, type V4ToolContext } from './tools'

/** 运行控制器：按 docId 键控（停止按钮 / 宿主显式停止 / 文档身份迁移） */
const controllers = new Map<string, AbortController>()

/** 停止某关卡的 v4 AI 运行（面板卸载不自动停止——运行归属宿主，docs/40 §12.4） */
export function stopAgentV4(docId: string): void {
  controllers.get(docId)?.abort()
}

/** 该关卡是否有 v4 AI 运行在跑（宿主清理/测试断言用） */
export function isAgentV4Running(docId: string): boolean {
  return controllers.has(docId)
}

// ---------------------------------------------------------------------------
// 下发窗口组装（与 v3 agent.buildModelMessages 同语义）
// ---------------------------------------------------------------------------

const MODEL_MSG_LIMIT = 120
const FULL_TAIL = 48
const OLD_TOOL_KEEP = 200

function compressOld(msg: ChatMessage, index: number, arr: ChatMessage[]): ChatMessage {
  if (index < arr.length - FULL_TAIL && msg.role === 'tool' && msg.content.length > OLD_TOOL_KEEP) {
    return { ...msg, content: `${msg.content.slice(0, OLD_TOOL_KEEP)}\n…（早期工具结果已截断，如需完整内容请重新读取）` }
  }
  return msg
}

/** 流式中断残留的 streaming 占位与空 assistant 不发给模型 */
function usableForModel(m: ChatMessage): boolean {
  if (m.role !== 'assistant') return true
  if (m.streaming === true) return false
  return m.content.trim() !== '' || (m.toolCalls?.length ?? 0) > 0
}

/**
 * system + 最近窗口；超限时窗口起点前进到第一条 user 消息，
 * 不能从 assistant(tool_calls)/tool 对中间切开（严格供应商会 4xx）。
 */
export function buildV4ModelMessages(systemPrompt: string, history: ChatMessage[]): ChatMessage[] {
  const usable = history.filter(usableForModel)
  if (usable.length <= MODEL_MSG_LIMIT) {
    return [{ role: 'system', content: systemPrompt }, ...usable.map(compressOld)]
  }
  let start = usable.length - MODEL_MSG_LIMIT
  while (start < usable.length && usable[start].role !== 'user') start++
  if (start >= usable.length) {
    return [{ role: 'system', content: systemPrompt }, ...usable.map(compressOld)]
  }
  return [
    { role: 'system', content: systemPrompt },
    { role: 'system', content: `（更早的 ${start} 条消息已省略以控制上下文长度；如需更早的细节请让用户重新提供。）` },
    ...usable.slice(start).map(compressOld),
  ]
}

// ---------------------------------------------------------------------------
// 宿主能力 & 运行入口
// ---------------------------------------------------------------------------

/** 宿主只需提供四个能力（AiPanelV4 经 ref 转发编辑器实时状态） */
export type V4HostContext = Pick<V4ToolContext, 'getDoc' | 'applyDoc' | 'getRevision' | 'levelId'>

export interface AgentTurnV4Options {
  docId: string
  profile: AiProfileConfig
  mode: 'ask' | 'agent'
  host: V4HostContext
  /** 用户输入；不传/空 = 不追加 user 消息（失败重试/撞限继续时以现有历史续跑） */
  userText?: string
  /** 覆盖默认工具集（测试/预置场景） */
  tools?: AiToolV4[]
  /** 单次提问最多工具调用轮数（缺省 agent 32 / ask 8） */
  maxTurns?: number
}

function toSpecs(tools: AiToolV4[]): AiToolSpec[] {
  return tools.map((tool) => ({
    type: 'function',
    function: { name: tool.name, description: tool.description, parameters: tool.parameters },
  }))
}

/**
 * 执行一轮完整对话（可能包含多次工具调用）；返回时 busy 已复位。
 * 错误统一写入 session.error（可读中文），面板据此渲染「重试/关闭」。
 */
export async function runAgentTurnV4(opts: AgentTurnV4Options): Promise<void> {
  const session = getSession(opts.docId)
  if (session.busy) return // 同一关卡防重入

  const ctrl = new AbortController()
  controllers.set(opts.docId, ctrl)
  patchSession(opts.docId, { busy: true, error: null, turnCapHit: false, turnCount: 0 })
  if (opts.userText !== undefined && opts.userText.trim() !== '') {
    appendMessage(opts.docId, { role: 'user', content: opts.userText })
  }

  try {
    const maxTurns = opts.maxTurns ?? (opts.mode === 'agent' ? 32 : 8)
    const tools = opts.tools ?? getV4Tools(opts.mode)
    const specs = toSpecs(tools)
    // 本轮对话的本地副本（会话真源由 session store 维护）；每次请求前按窗口重新组装
    const history: ChatMessage[] = [...getSession(opts.docId).messages]
    const abortIfStopped = (): void => {
      if (ctrl.signal.aborted) throw new Error('已停止。')
    }

    /**
     * 运行内影子文档：applyDoc 经宿主 React state 提交，外部引用要等渲染期才更新；
     * 同轮多写入时后一个工具会读到旧快照互相覆盖。runDoc 让本轮读写始终基于最新已应用结果。
     * 冲突（用户手改）时置空 → 读工具回到宿主实时文档。
     */
    let runDoc: LevelDocV4 | null = null
    const guard = createRevisionGuard({
      getRevision: () => opts.host.getRevision(),
      onReject: () => {
        runDoc = null
      },
    })
    const ctx: V4ToolContext = {
      getDoc: () => runDoc ?? opts.host.getDoc(),
      applyDoc: (next) => {
        opts.host.applyDoc(next) // 宿主唯一写路径（可能抛冲突/校验错误）
        runDoc = next
      },
      getRevision: () => opts.host.getRevision(),
      levelId: opts.host.levelId,
      signal: ctrl.signal,
      revisionGuard: guard,
    }

    for (let turn = 0; turn < maxTurns; turn++) {
      abortIfStopped()
      // system prompt 每轮现算：runDoc 是本轮最新文档（中途新增题型/行当轮即可见）
      const systemPrompt = buildV4SystemPrompt(runDoc ?? opts.host.getDoc(), opts.mode)
      const res = await chatCompleteRaw(opts.profile, buildV4ModelMessages(systemPrompt, history), {
        tools: specs,
        signal: ctrl.signal,
      })
      abortIfStopped() // fetch 期间被停止：不再记账/执行工具
      addSessionUsage(opts.docId, res.usage)
      patchSession(opts.docId, { turnCount: turn + 1 })
      const finalMsg: ChatMessage = { role: 'assistant', content: res.content, toolCalls: res.toolCalls }
      history.push(finalMsg)
      appendMessage(opts.docId, finalMsg)
      if (!res.toolCalls || res.toolCalls.length === 0) return // 文本回复 = 本轮结束

      for (const call of res.toolCalls) {
        abortIfStopped()
        const tool = tools.find((candidate) => candidate.name === call.function.name)
        let result: string
        if (!tool) {
          result = `错误：未知工具「${call.function.name}」。可用工具：${tools.map((candidate) => candidate.name).join('、')}`
        } else {
          try {
            const args = call.function.arguments.trim()
              ? (JSON.parse(call.function.arguments) as Record<string, unknown>)
              : {}
            result = await tool.exec(args, ctx)
          } catch (err) {
            result = `工具执行出错：${err instanceof Error ? err.message : String(err)}`
          }
        }
        abortIfStopped() // 工具执行期间被停止：结果不落会话、不再发起下一轮请求
        const msg: ChatMessage = { role: 'tool', toolCallId: call.id, name: call.function.name, content: result }
        history.push(msg)
        appendMessage(opts.docId, msg)
      }
    }
    abortIfStopped()
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
