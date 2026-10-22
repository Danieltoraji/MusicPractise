/**
 * 调试面板（docs/30）：Debug 模式的控制台。
 * 启动/停止调试会话 + 断点管理 + 继续/单步/暂停 + 变量实时观察与赋值 +
 * 手动触发组件事件 + 实时运行日志。数据源 = debugRun 模块单例（useSyncExternalStore）。
 * 仅存在于编辑器工作台（Debug 模式只在编辑器开启）。
 */
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import type { LevelDoc } from '../../engine/level'
import type { Json } from '../../engine/expr'
import {
  clearDebugBreakpoints,
  dispatchDebugEvent,
  getDebugSnapshot,
  pauseDebug,
  resumeDebug,
  setDebugVar,
  startDebugRun,
  stepDebug,
  stopDebugRun,
  subscribeDebugRun,
  toggleDebugBreakpoint,
} from './debugRun'
import { buildEventGroups } from './palette'

interface Props {
  doc: LevelDoc
  onFocusNode: (id: string) => void
}

export function DebugPanel({ doc, onFocusNode }: Props) {
  const snap = useSyncExternalStore(subscribeDebugRun, getDebugSnapshot)
  const [eventValue, setEventValue] = useState('')
  const [payloadText, setPayloadText] = useState('{}')
  const [triggerError, setTriggerError] = useState<string | null>(null)
  const logRef = useRef<HTMLDivElement>(null)

  const events = useMemo(() => buildEventGroups(doc).flatMap((g) => g.items), [doc])

  // 暂停时自动定位到挂起节点
  useEffect(() => {
    if (snap.pausedAt) onFocusNode(snap.pausedAt)
  }, [snap.pausedAt, onFocusNode])

  // 实时日志自动滚动到底部——依赖数组用 events 引用而非 length（O5：满 100 条后
  // length 不再变化，新日志到来不会触发滚动）
  useEffect(() => {
    const el = logRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [snap.events])

  const trigger = async (): Promise<void> => {
    setTriggerError(null)
    let payload: Json = {}
    if (payloadText.trim() !== '') {
      try {
        payload = JSON.parse(payloadText) as Json
      } catch {
        setTriggerError('负载不是合法 JSON')
        return
      }
    }
    const err = await dispatchDebugEvent(eventValue, payload)
    if (err) setTriggerError(err)
  }

  const startErr = async (): Promise<void> => {
    const err = await startDebugRun(doc)
    if (err) setTriggerError(err)
  }

  return (
    <div className="gdb">
      {snap.mode === 'idle' ? (
        <>
          <button type="button" className="primary gdb-start" onClick={() => void startErr()}>
            ▶ 启动调试
          </button>
          {snap.loadErrors && (
            <div className="gdb-loaderr">
              {snap.loadErrors.map((e, i) => (
                <div key={i}>- {e}</div>
              ))}
            </div>
          )}
          <p className="muted gdb-hint">
            启动后以当前文档运行一个可暂停的会话：在节点卡左侧圆点设断点，用事件触发表驱动流程，实时观察变量与日志。
          </p>
        </>
      ) : (
        <>
          <div className="gdb-controls">
            {snap.pausedAt ? (
              <span className="gdb-state gdb-state-paused" title={`事件 ${snap.pausedEvent ?? ''}`}>
                ⏸ 暂停于 {snap.pausedAt}
              </span>
            ) : (
              <span className="gdb-state">▶ 运行中…</span>
            )}
            <button type="button" disabled={!snap.pausedAt} onClick={() => resumeDebug()} title="放行到下一个断点">
              继续
            </button>
            <button type="button" disabled={!snap.pausedAt} onClick={() => stepDebug()} title="执行当前节点后在下一节点暂停">
              单步
            </button>
            <button type="button" disabled={!!snap.pausedAt} onClick={() => pauseDebug()} title="在下一个节点边界暂停">
              暂停
            </button>
            <button type="button" className="danger" onClick={() => stopDebugRun()} title="停止调试会话">
              停止
            </button>
          </div>
          {snap.pausedAt && (
            <button type="button" className="link gdb-focus" onClick={() => onFocusNode(snap.pausedAt!)}>
              在画布中定位 {snap.pausedAt}
            </button>
          )}
          <div className="gdb-sec">
            <div className="glib-group-head">变量（实时，可赋值）</div>
            {Object.entries(snap.vars).map(([name, value]) => (
              <VarRow key={name} name={name} value={value} />
            ))}
            {Object.keys(snap.vars).length === 0 && <div className="glib-empty muted">暂无变量</div>}
          </div>
          <div className="gdb-sec">
            <div className="glib-group-head">手动触发事件</div>
            <select value={eventValue} onChange={(e) => setEventValue(e.target.value)}>
              <option value="">选择事件…</option>
              {events.map((ev) => (
                <option key={ev.value} value={ev.value}>
                  {ev.label}
                </option>
              ))}
              {eventValue && !events.some((ev) => ev.value === eventValue) && <option value={eventValue}>{eventValue}</option>}
            </select>
            <input
              className="gdb-payload"
              value={payloadText}
              onChange={(e) => setPayloadText(e.target.value)}
              placeholder='负载 JSON，如 {"midi": 60}'
            />
            <button type="button" disabled={!eventValue} onClick={() => void trigger()}>
              触发
            </button>
            {triggerError && <div className="gem-err">{triggerError}</div>}
          </div>
        </>
      )}

      <div className="gdb-sec">
        <div className="glib-group-head">
          断点（{snap.breakpoints.length}）
          {snap.breakpoints.length > 0 && (
            <button type="button" className="link gdb-bp-clear" onClick={() => clearDebugBreakpoints()}>
              清空
            </button>
          )}
        </div>
        {snap.breakpoints.length === 0 ? (
          <div className="glib-empty muted">未设断点——点击节点卡左侧圆点设置</div>
        ) : (
          snap.breakpoints.map((id) => (
            <div key={id} className="gdb-bp-row">
              <span className="gnode-bp on" aria-hidden />
              <button type="button" className="link" onClick={() => onFocusNode(id)}>
                {id}
              </button>
              <button type="button" className="link gdb-bp-del" title="移除断点" onClick={() => toggleDebugBreakpoint(id)}>
                ×
              </button>
            </div>
          ))
        )}
      </div>

      <div className="gdb-sec gdb-log-sec">
        <div className="glib-group-head">实时日志</div>
        <div className="gdb-log" ref={logRef}>
          {snap.events.length === 0 ? (
            <div className="glib-empty muted">暂无日志</div>
          ) : (
            snap.events.map((e, i) => (
              <div key={i} className={`gdb-log-row ${e.kind}`}>
                <span className="gdb-log-kind">{e.kind === 'error' ? '✗' : '·'}</span>
                <span className="gdb-log-text">
                  {e.kind === 'error' ? `${e.nodeId ? `[${e.nodeId}] ` : ''}${e.message}` : e.path}
                </span>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  )
}

/** 变量观察行：显示实时值，失焦提交赋值（JSON 优先，回退字符串） */
function VarRow({ name, value }: { name: string; value: Json }) {
  const [text, setText] = useState(() => JSON.stringify(value) ?? '')
  const [err, setErr] = useState(false)
  // 外部值变化（运行推进）时同步显示——用户正在编辑时不打扰
  const editingRef = useRef(false)
  useEffect(() => {
    if (!editingRef.current) setText(JSON.stringify(value))
  }, [value])

  const apply = (): void => {
    editingRef.current = false
    const t = text.trim()
    if (t === JSON.stringify(value)) return
    let parsed: Json
    try {
      parsed = JSON.parse(t) as Json
    } catch {
      parsed = text
    }
    const e = setDebugVar(name, parsed)
    setErr(e !== null)
    if (!e) setText(JSON.stringify(value))
  }

  return (
    <div className="gdb-var-row">
      <span className="gdb-var-name" title={name}>
        {name}
      </span>
      <input
        value={text}
        onFocus={() => (editingRef.current = true)}
        onChange={(e) => {
          editingRef.current = true
          setText(e.target.value)
        }}
        onBlur={apply}
        onKeyDown={(e) => {
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
        }}
        className={err ? 'tone-error' : ''}
      />
    </div>
  )
}
