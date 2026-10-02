/**
 * 编辑器 AI 助手面板（批次1 ask 模式）：多轮对话面板。
 * 两种挂载形态共用本组件（docs/29）：编辑器右栏（其它 tab）与节点图工作台入坞（graph tab，
 * 处于 .graph-editor 主题作用域内随深浅换肤）；宽度均由外层容器决定。
 * 会话存 src/ai/session 模块级 store（按 doc.id），切 tab 卸载重挂不丢。
 * 只读工具（read_script/read_doc/read_json/lint/read_run_log），
 * 选中上下文由挂载方传入（graph：节点 id；script：选区；canvas：组件 id）。
 */
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { runAgentTurn, stopAgent } from '../../ai/agent'
import { clearCheckpoint, getCheckpoint, saveCheckpoint } from '../../ai/checkpoint'
import type { AiProfileConfig, ChatMessage } from '../../ai/client'
import { buildEditorSystemPrompt, formatSelectionContext, type AiSelectionContext } from '../../ai/prompts'
import { appendMessage, clearSession, getSession, patchSession, subscribeAiSession, type AiMode } from '../../ai/session'
import { loadAiSettings } from '../../ai/settings'
import { READONLY_TOOLS } from '../../ai/tools'
import { WRITE_TOOLS } from '../../ai/tools-write'
import type { LevelDoc } from '../../engine/level'

interface Props {
  doc: LevelDoc
  selection: AiSelectionContext
  onClose: () => void
  /** 应用 AI 修改后的 doc（编辑器唯一写路径 update——全视图自动刷新+标脏）；agent 模式必经 */
  onApplyDoc: (doc: LevelDoc) => void
  /** 节点图入坞形态：列内定高（列内非末位面板） */
  style?: React.CSSProperties
  /** 追加到根（drag-src 拖拽源半透明等） */
  className?: string
  /** 标题栏拖拽手柄（跨列槽移动，GraphEditor DnD 统一管理；可选） */
  headerDrag?: {
    onDragStart: () => void
    onDragEnd: () => void
    onDragOver: (e: React.DragEvent) => void
  }
}

function activeProfile(): AiProfileConfig | null {
  const s = loadAiSettings()
  const p = s.profiles[s.activeId]
  if (!p || !p.apiKey.trim() || !p.baseUrl.trim() || !p.model.trim()) return null
  return { baseUrl: p.baseUrl, model: p.model, apiKey: p.apiKey }
}

const MODE_META: Record<AiMode, { label: string; tip: string }> = {
  ask: { label: 'ask', tip: '只读问答：AI 可读取脚本/文档/校验/日志，不会修改关卡' },
  plan: { label: 'plan', tip: '规划模式：AI 调研后产出编号执行计划，确认后一键转 agent 执行' },
  agent: { label: 'agent', tip: '代理修改：AI 可直接修改关卡（发送时自动存检查点，可一键回滚）' },
}

export function AiPanel({ doc, selection, onClose, onApplyDoc, style, className, headerDrag }: Props) {
  const session = useSyncExternalStore(subscribeAiSession, () => getSession(doc.id))
  // 工具 ctx 走 ref：agent 循环跨 await 期间始终读到最新 doc（保存副本换 id 会重挂面板，无碍）
  const docRef = useRef(doc)
  docRef.current = doc
  const applyRef = useRef(onApplyDoc)
  applyRef.current = onApplyDoc
  const [input, setInput] = useState('')
  const listRef = useRef<HTMLDivElement>(null)

  const profile = activeProfile()

  // 新消息/状态变化时滚到底部
  useEffect(() => {
    const el = listRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [session.messages.length, session.busy, session.error])

  const send = async (): Promise<void> => {
    const text = input.trim()
    if (!text || session.busy) return
    await sendText(text)
  }

  /** 实际发送（send 的内 guts；执行计划/开场自动发送复用）。mode 直读 store 真源（executePlan 先切模式再发送，快照会滞后） */
  const sendText = async (text: string): Promise<void> => {
    if (!text || session.busy) return
    const prof = profile ?? activeProfile()
    if (!prof) return
    const mode = getSession(doc.id).mode
    setInput('')
    // agent 模式：发送即存检查点（回滚 = 回到本轮 AI 动手前）
    if (mode === 'agent') {
      const at = saveCheckpoint(doc.id, docRef.current)
      patchSession(doc.id, { checkpointAt: at })
    }
    const ctxText = formatSelectionContext(selection, docRef.current)
    const userText = ctxText ? `[上下文] ${ctxText}\n\n${text}` : text
    await runAgentTurn({
      docId: doc.id,
      profile: prof,
      systemPrompt: buildEditorSystemPrompt(docRef.current, mode),
      userText,
      tools: mode === 'agent' ? [...READONLY_TOOLS, ...WRITE_TOOLS] : READONLY_TOOLS,
      ctx: { getDoc: () => docRef.current, applyDoc: (next) => applyRef.current(next), levelId: doc.id },
      maxTurns: mode === 'agent' ? 8 : 6,
    })
  }

  /** plan 模式确认流：把最近一条 assistant 回复（执行计划）转交 agent 执行 */
  const lastPlan = useMemo(() => {
    if (session.mode !== 'plan' || session.busy) return null
    for (let i = session.messages.length - 1; i >= 0; i--) {
      const m = session.messages[i]
      if (m.role === 'user') return null
      if (m.role === 'assistant' && m.content.trim() !== '') return m.content
    }
    return null
  }, [session.mode, session.busy, session.messages])

  const executePlan = async (): Promise<void> => {
    if (!lastPlan || session.busy) return
    const at = saveCheckpoint(doc.id, docRef.current)
    patchSession(doc.id, { mode: 'agent', checkpointAt: at })
    await sendText(`请严格按以下计划执行修改（不要重新规划，逐项落实后汇报结果）：\n\n${lastPlan}`)
  }

  const rollback = (): void => {
    const cp = getCheckpoint(doc.id)
    if (!cp || session.busy) return
    applyRef.current(cp.doc)
    appendMessage(doc.id, {
      role: 'assistant',
      content: `↩ 已回滚到 AI 修改前的版本（检查点 ${new Date(cp.at).toLocaleTimeString()}）。`,
    })
    clearCheckpoint(doc.id)
    patchSession(doc.id, { checkpointAt: null })
  }

  const empty = session.messages.length === 0

  return (
    <aside className={`ai-panel${className ? ` ${className}` : ''}`} style={style}>
      <div
        className={`ai-panel-head${headerDrag ? ' is-draggable' : ''}`}
        draggable={!!headerDrag}
        title={headerDrag ? 'AI 助手：拖动标题栏可移动到其它列或调整顺序' : undefined}
        onDragStart={() => headerDrag?.onDragStart()}
        onDragEnd={() => headerDrag?.onDragEnd()}
        onDragOver={(e) => headerDrag?.onDragOver(e)}
      >
        <b>AI 助手</b>
        <span className="ai-mode-tabs" role="tablist">
          {(Object.keys(MODE_META) as AiMode[]).map((m) => (
            <button
              key={m}
              type="button"
              className={`ai-mode-tab${session.mode === m ? ' active' : ''}`}
              title={MODE_META[m].tip}
              disabled={session.busy || session.mode === m}
              onClick={() => patchSession(doc.id, { mode: m, checkpointAt: m === 'ask' ? null : session.checkpointAt })}
            >
              {MODE_META[m].label}
            </button>
          ))}
        </span>
        {session.checkpointAt !== null && (
          <button
            type="button"
            className="ai-panel-rollback"
            title="撤销本轮 AI 的全部修改：恢复到 agent 模式发送前的版本"
            onClick={rollback}
            disabled={session.busy}
          >
            ↩ 回滚
          </button>
        )}
        <button
          type="button"
          className="ai-panel-clear"
          onClick={() => clearSession(doc.id)}
          disabled={session.busy || empty}
          title="清空本关卡的对话记录"
        >
          清空
        </button>
        <button type="button" className="ai-panel-close" title="收起面板" onClick={onClose}>
          ✕
        </button>
      </div>

      <div className="ai-panel-msgs" ref={listRef}>
        {empty && !session.error && (
          <div className="ai-panel-empty">
            <p>问点什么，比如：</p>
            <ul>
              <li>这个关卡的逻辑是怎么走的？</li>
              <li>帮我检查有没有悬空引用或类型问题</li>
              <li>试运行报错了，帮我看看日志（先点「▶ 试运行」）</li>
              {session.mode === 'agent' && (
                <>
                  <li>把过关条件改成 v.score &gt;= 60</li>
                  <li>再加 3 道选择题（数据表加行 + 逻辑改判定）</li>
                </>
              )}
            </ul>
            <p className="muted">
              {session.mode === 'agent'
                ? 'agent 模式：AI 会直接修改关卡（每次写入都过校验；发送时已存检查点，可随时「↩ 回滚」）。'
                : 'AI 可读取脚本、文档、校验结果与运行日志。先在画布/节点图/脚本页选中一个元素再提问，会自动附带上下文。'}
            </p>
          </div>
        )}
        {session.messages.map((m, i) => renderMsg(m, i))}
        {session.busy && <p className="muted ai-msg ai-busy">思考中…</p>}
      </div>

      {lastPlan && (
        <div className="ai-plan-bar">
          <span>上方回复包含执行计划</span>
          <button type="button" className="ai-plan-run" onClick={() => void executePlan()}>
            ▶ 执行计划
          </button>
        </div>
      )}

      {session.error && (
        <div className="ai-panel-error">
          <span>{session.error}</span>
          <button type="button" className="ai-panel-error-close" title="关闭" onClick={() => patchSession(doc.id, { error: null })}>
            ×
          </button>
        </div>
      )}
      {!profile && (
        <p className="ai-panel-hint">
          尚未配置 AI 供应商——<a href="#/settings">前往设置</a> 填入 API Key 后即可使用。
        </p>
      )}

      <div className="ai-panel-form">
        <textarea
          rows={2}
          placeholder={
            profile
              ? session.mode === 'agent'
                ? '让 AI 修改关卡…（Enter 发送；发送时自动存检查点）'
                : '询问当前关卡…（Enter 发送，Shift+Enter 换行）'
              : '请先在设置中配置 AI 供应商'
          }
          value={input}
          disabled={!profile}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              void send()
            }
          }}
        />
        {session.busy ? (
          <button type="button" onClick={() => stopAgent(doc.id)}>
            停止
          </button>
        ) : (
          <button type="button" className="primary" disabled={!profile || !input.trim()} onClick={() => void send()}>
            发送
          </button>
        )}
      </div>
    </aside>
  )
}

function renderMsg(m: ChatMessage, i: number): React.ReactNode {
  if (m.role === 'user') {
    return (
      <div key={i} className="ai-msg ai-msg-user">
        {m.content}
      </div>
    )
  }
  if (m.role === 'assistant') {
    return (
      <div key={i} className="ai-msg ai-msg-assistant">
        {m.toolCalls && m.toolCalls.length > 0 && (
          <div className="ai-tool-calls">⚙ 调用工具：{m.toolCalls.map((c) => c.function.name).join('、')}</div>
        )}
        {m.content && <span>{m.content}</span>}
      </div>
    )
  }
  return (
    <details key={i} className="ai-msg ai-msg-tool">
      <summary>⚙ {m.name ?? '工具'} 结果</summary>
      <pre>{m.content}</pre>
    </details>
  )
}

export default AiPanel
