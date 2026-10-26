/**
 * v4 编辑器 AI 面板（W8.3）：实现 `V4EditorSlots.renderAiPanel` 插槽（props: {doc,onChange,revision}）。
 *
 * 形态：最小可用面板——消息流 / ask·agent 双模式 / 工具调用折叠 / 错误可读 / 停止 / 撞限继续。
 * 复用 v3 基建：`src/ai/client`（OpenAI 兼容客户端）、`src/ai/settings`（本地配置）、
 * `src/ai/session`（按 docId 键控的会话 store，跨面板卸载保留）；agent 循环与按层工具是 v4 自有
 * （`src/ai/v4/{agent,tools,prompts}`）。
 *
 * 关键语义（与 docs/40 §12 / docs/43 对齐）：
 * - **一次 run 一条撤销步**：run 开始发号 `ai:<n>` 作为更新 tag，run 内多次写入同 tag 由宿主
 *   `update()` 合并为一条撤销步；两次 run 不合并。
 * - **revision 冲突门**：v4 写入在 run 期间若创作者手改过文档会被拒绝（工具回「先读后写」）。
 *   宿主传下来的 `revision` 是渲染期快照，而宿主 `update()` 会同步递增内部 revision——面板用
 *   「渲染期快照 + 本次渲染前自身写入数」代理出逻辑 revision，保证同轮多写不被误判为手改。
 * - **运行归属宿主**：面板卸载不 abort（切 Tab/布局不会打断 AI）；显式「停止」按钮与宿主
 *   （关闭 AI 栏 / 卸载编辑器 / 内置副本另存）调 `stopAgentV4(docId)`。面板自身只在
 *   **文档身份迁移**（内置示例另存副本换 id）时停止旧 id 的运行并迁移会话/运行日志。
 */
import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { AiProfileConfig, ChatMessage } from '../../ai/client'
import {
  clearSession,
  getSession,
  hydrateSession,
  patchSession,
  renameSession,
  subscribeAiSession,
} from '../../ai/session'
import { loadAiSettings } from '../../ai/settings'
import { runAgentTurnV4, stopAgentV4 } from '../../ai/v4/agent'
import { V4_WRITE_TOOL_NAMES } from '../../ai/v4/tools'
import type { LevelDocV4 } from '../../engine/v4/model'
import { renameRunLog } from '../../runtime/runLog'
import type { V4EditorSlotProps } from './shared'
import './v4-ai.css'

function activeProfile(): AiProfileConfig | null {
  const settings = loadAiSettings()
  const profile = settings.profiles[settings.activeId]
  if (!profile || !profile.apiKey.trim() || !profile.baseUrl.trim() || !profile.model.trim()) return null
  return { baseUrl: profile.baseUrl, model: profile.model, apiKey: profile.apiKey }
}

const MODE_HINT: Record<'ask' | 'agent', string> = {
  ask: '只读问答：AI 可读取各层 / lint / 试运行，不会修改关卡。',
  agent: `代理修改：AI 按层写入（${V4_WRITE_TOOL_NAMES.join(' / ')}），每次写入过校验，一次 run 可 Ctrl+Z 整段撤销。`,
}

/** 工具结果折叠展示（工具返回可能很长：默认收起，点开看全文） */
function ToolResult(props: { msg: ChatMessage }): React.ReactElement {
  return (
    <details className="v4-ai-tool" data-testid="v4-ai-msg-tool">
      <summary>⚙ 工具结果 · {props.msg.name ?? 'tool'}</summary>
      <pre>{props.msg.content}</pre>
    </details>
  )
}

function MessageView(props: { msg: ChatMessage }): React.ReactElement | null {
  const msg = props.msg
  if (msg.role === 'user') {
    return (
      <div className="v4-ai-msg v4-ai-msg-user" data-testid="v4-ai-msg-user">
        <p className="v4-ai-text">{msg.content}</p>
      </div>
    )
  }
  if (msg.role === 'assistant') {
    return (
      <div className="v4-ai-msg v4-ai-msg-assistant" data-testid="v4-ai-msg-assistant">
        {msg.content !== '' && <p className="v4-ai-text">{msg.content}</p>}
        {msg.toolCalls && msg.toolCalls.length > 0 && (
          <div className="v4-ai-tool-calls" data-testid="v4-ai-tool-calls">
            ⚙ 调用工具：{msg.toolCalls.map((call) => call.function.name).join('、')}
          </div>
        )}
      </div>
    )
  }
  if (msg.role === 'tool') return <ToolResult msg={msg} />
  return null
}

export function AiPanelV4({ doc, onChange, revision }: V4EditorSlotProps): React.ReactElement {
  const docId = doc.id
  const session = useSyncExternalStore(subscribeAiSession, () => getSession(docId))

  // 宿主实时状态经 ref 转发：agent run 跨 await 期间始终读到最新 doc / revision / onChange
  const docRef = useRef<LevelDocV4>(doc)
  docRef.current = doc
  const applyRef = useRef(onChange)
  applyRef.current = onChange

  /**
   * revision 代理（详见文件头注释）：
   * hostRevisionRef = 最近一次渲染看到的宿主 revision；pendingWritesRef = 尚未反映进 prop 的自身写入数。
   * 渲染期用新 prop 的增量抵扣 pending；getRevision() 返回「宿主当前逻辑 revision」的近似值。
   */
  const hostRevisionRef = useRef(revision)
  const pendingWritesRef = useRef(0)
  if (revision !== hostRevisionRef.current) {
    pendingWritesRef.current = Math.max(0, pendingWritesRef.current - (revision - hostRevisionRef.current))
    hostRevisionRef.current = revision
  }

  const runSeqRef = useRef(0)
  const runTagRef = useRef('ai')
  const [input, setInput] = useState('')
  const listRef = useRef<HTMLDivElement>(null)
  const profile = activeProfile()

  // 文档身份迁移（内置示例另存副本换 id，docs/42 §4.6 C5）：停旧 id 运行 + 会话/运行日志跟随
  const prevDocIdRef = useRef(docId)
  useEffect(() => {
    const previous = prevDocIdRef.current
    if (previous === docId) return
    prevDocIdRef.current = docId
    stopAgentV4(previous)
    void renameSession(previous, docId)
    renameRunLog(previous, docId)
  }, [docId])

  // 会话持久化恢复（内存为空才载入）
  useEffect(() => {
    void hydrateSession(docId)
  }, [docId])

  // 新消息/状态变化时滚到底部
  useEffect(() => {
    const el = listRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [session.messages.length, session.busy, session.error])

  const mode: 'ask' | 'agent' = session.mode === 'agent' ? 'agent' : 'ask'

  /** 组装宿主能力：写入经编辑器唯一写路径 update（tag = 本 run 的 ai:<n>） */
  const hostContext = (): {
    getDoc: () => LevelDocV4
    applyDoc: (next: LevelDocV4) => void
    getRevision: () => number
    levelId: string
  } => ({
    getDoc: () => docRef.current,
    applyDoc: (next) => {
      pendingWritesRef.current += 1
      applyRef.current(next, runTagRef.current)
    },
    getRevision: () => hostRevisionRef.current + pendingWritesRef.current,
    levelId: docRef.current.id,
  })

  const startRun = async (text?: string): Promise<void> => {
    if (session.busy) return
    const active = profile ?? activeProfile()
    if (!active) return
    runTagRef.current = `ai:${++runSeqRef.current}`
    await runAgentTurnV4({
      docId: docRef.current.id,
      profile: active,
      mode: getSession(docRef.current.id).mode === 'agent' ? 'agent' : 'ask',
      host: hostContext(),
      userText: text,
    })
  }

  const send = async (): Promise<void> => {
    const text = input.trim()
    if (text === '' || session.busy) return
    setInput('')
    await startRun(text)
  }

  const retry = async (): Promise<void> => {
    if (session.busy || !session.error) return
    patchSession(docId, { error: null })
    await startRun()
  }

  const continueAfterCap = async (): Promise<void> => {
    if (session.busy || !session.turnCapHit) return
    patchSession(docId, { turnCapHit: false })
    await startRun()
  }

  const switchMode = (next: 'ask' | 'agent'): void => {
    if (session.busy || next === session.mode) return
    patchSession(docId, { mode: next })
  }

  const empty = session.messages.length === 0

  return (
    <div className="v4-ai" data-testid="v4-ai">
      <div className="v4-ai-head">
        <b>AI 助手</b>
        <span className="v4-ai-modes" role="tablist">
          {(['ask', 'agent'] as const).map((item) => (
            <button
              key={item}
              type="button"
              role="tab"
              aria-selected={mode === item}
              data-testid={`v4-ai-mode-${item}`}
              className={`v4-ai-mode${mode === item ? ' active' : ''}`}
              title={MODE_HINT[item]}
              disabled={session.busy || mode === item}
              onClick={() => switchMode(item)}
            >
              {item}
            </button>
          ))}
        </span>
        <button
          type="button"
          className="v4-ai-clear"
          data-testid="v4-ai-clear"
          title="清空本关卡的对话记录"
          disabled={session.busy || empty}
          onClick={() => clearSession(docId)}
        >
          清空
        </button>
      </div>

      <div className="v4-ai-msgs" ref={listRef} data-testid="v4-ai-messages">
        {empty && !session.error && (
          <div className="v4-ai-empty" data-testid="v4-ai-empty">
            <p>用中文描述要改哪一层，例如：</p>
            <ul>
              <li>「内容表加 3 道选择题，然后跑 run_level 验证」</li>
              <li>「把主流程改成答对 3 题才算通过」</li>
            </ul>
            <p className="v4-ai-hint">{MODE_HINT[mode]}</p>
          </div>
        )}
        {session.messages.map((msg, index) => (
          <MessageView key={index} msg={msg} />
        ))}
        {session.busy && (
          <p className="v4-ai-hint" data-testid="v4-ai-busy">
            思考中…（可点「停止」中断）
          </p>
        )}
      </div>

      {session.turnCapHit && !session.busy && (
        <div className="v4-ai-capbar" data-testid="v4-ai-capbar">
          <span>已达单次任务轮数上限，任务还没跑完？</span>
          <button
            type="button"
            data-testid="v4-ai-continue"
            disabled={!profile}
            title="以现有进度接着跑（轮数预算重置）"
            onClick={() => void continueAfterCap()}
          >
            ▶ 继续
          </button>
        </div>
      )}

      {session.error && (
        <div className="v4-ai-error" data-testid="v4-ai-error">
          <span data-testid="v4-ai-error-text">{session.error}</span>
          <button
            type="button"
            data-testid="v4-ai-retry"
            title="以现有对话重跑本轮（不重复发送刚才的消息）"
            disabled={session.busy || !profile}
            onClick={() => void retry()}
          >
            ↻ 重试
          </button>
          <button
            type="button"
            className="v4-ai-error-close"
            data-testid="v4-ai-error-close"
            title="关闭错误提示"
            onClick={() => patchSession(docId, { error: null })}
          >
            ×
          </button>
        </div>
      )}

      {!profile && (
        <p className="v4-ai-hint" data-testid="v4-ai-nokey">
          尚未配置 AI 供应商——<a href="#/settings">前往设置</a> 填入 API Key 后即可使用。
        </p>
      )}

      <div className="v4-ai-form">
        <textarea
          data-testid="v4-ai-input"
          rows={3}
          value={input}
          placeholder={mode === 'agent' ? '描述要改的层与目标（写工具会过校验）…' : '问点什么…'}
          spellCheck={false}
          disabled={session.busy}
          onChange={(event) => setInput(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return
            event.preventDefault()
            void send()
          }}
        />
        {session.busy ? (
          <button type="button" data-testid="v4-ai-stop" onClick={() => stopAgentV4(docId)}>
            停止
          </button>
        ) : (
          <button
            type="button"
            className="primary"
            data-testid="v4-ai-send"
            disabled={!profile || input.trim() === ''}
            onClick={() => void send()}
          >
            发送
          </button>
        )}
      </div>
      {session.busy && session.error === null && (
        <p className="v4-ai-hint" data-testid="v4-ai-stop-hint">
          停止会丢弃尚未完成的这一轮（已应用的写入保留，可用 Ctrl+Z 撤销本 run）。
        </p>
      )}
    </div>
  )
}

export default AiPanelV4
