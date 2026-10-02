/**
 * 编辑器 AI 助手面板（批次1 ask 模式）：多轮对话面板。
 * 两种挂载形态共用本组件（docs/29）：编辑器右栏（其它 tab）与节点图工作台入坞（graph tab，
 * 处于 .graph-editor 主题作用域内随深浅换肤）；宽度均由外层容器决定。
 * 会话存 src/ai/session 模块级 store（按 doc.id），切 tab 卸载重挂不丢。
 * 只读工具（read_script/read_doc/read_json/lint/read_run_log），
 * 选中上下文由挂载方传入（graph：节点 id；script：选区；canvas：组件 id）。
 */
import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { runAgentTurn, stopAgent } from '../../ai/agent'
import type { AiProfileConfig, ChatMessage } from '../../ai/client'
import { buildEditorSystemPrompt, formatSelectionContext, type AiSelectionContext } from '../../ai/prompts'
import { clearSession, getSession, patchSession, subscribeAiSession } from '../../ai/session'
import { loadAiSettings } from '../../ai/settings'
import { READONLY_TOOLS } from '../../ai/tools'
import type { LevelDoc } from '../../engine/level'

interface Props {
  doc: LevelDoc
  selection: AiSelectionContext
  onClose: () => void
}

function activeProfile(): AiProfileConfig | null {
  const s = loadAiSettings()
  const p = s.profiles[s.activeId]
  if (!p || !p.apiKey.trim() || !p.baseUrl.trim() || !p.model.trim()) return null
  return { baseUrl: p.baseUrl, model: p.model, apiKey: p.apiKey }
}

export function AiPanel({ doc, selection, onClose }: Props) {
  const session = useSyncExternalStore(subscribeAiSession, () => getSession(doc.id))
  // 工具 ctx 走 ref：agent 循环跨 await 期间始终读到最新 doc（保存副本换 id 会重挂面板，无碍）
  const docRef = useRef(doc)
  docRef.current = doc
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
    const prof = profile ?? activeProfile()
    if (!prof) return
    setInput('')
    const ctxText = formatSelectionContext(selection, docRef.current)
    const userText = ctxText ? `[上下文] ${ctxText}\n\n${text}` : text
    await runAgentTurn({
      docId: doc.id,
      profile: prof,
      systemPrompt: buildEditorSystemPrompt(docRef.current),
      userText,
      tools: READONLY_TOOLS,
      ctx: { getDoc: () => docRef.current, levelId: doc.id },
    })
  }

  const empty = session.messages.length === 0

  return (
    <aside className="ai-panel">
      <div className="ai-panel-head">
        <b>AI 助手</b>
        <span className="ai-mode-chip" title="只读问答：AI 可读取脚本/文档/校验/日志，不会修改关卡">
          ask
        </span>
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
            </ul>
            <p className="muted">
              AI 可读取脚本、文档、校验结果与运行日志。先在画布/节点图/脚本页选中一个元素再提问，会自动附带上下文。
            </p>
          </div>
        )}
        {session.messages.map((m, i) => renderMsg(m, i))}
        {session.busy && <p className="muted ai-msg ai-busy">思考中…</p>}
      </div>

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
          placeholder={profile ? '询问当前关卡…（Enter 发送，Shift+Enter 换行）' : '请先在设置中配置 AI 供应商'}
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
