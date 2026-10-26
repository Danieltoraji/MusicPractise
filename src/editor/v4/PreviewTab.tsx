/**
 * v4 编辑器「预览」Tab（docs/53 §13.3 预览；docs/52 W7.2）：
 * 可见游玩画面（LevelStageV4）+ 控制条（开始/停止/重开/暂停/继续/单步/暂停计时器）
 * + 调试面板（调用栈、四层作用域 v/local/t/q/q.state/args/run、牌堆/进度、每题返回、运行日志、结算）。
 *
 * 数据源：`V4DebugController`（docs/52 W7.1，包装 V4Session 的节点边界 gate + 快照订阅）。
 * 会话归属（docs/40 §12.4）：**本 Tab 是运行宿主**——挂载时创建 controller/会话，
 * 文档引用变化（外部修改/撤销）或卸载时 `stop()`（先放行挂起 gate 再 dispose，docs/40 已知坑）；
 * 文档未变化的重渲染不重建会话（effect 依赖 doc 引用 + 重跑序号，回调经 ref/订阅透传）。
 *
 * 静音：`V4DebugController` 的会话宿主 runEffects 恒为空实现（与 v3 调试画面口径一致），
 * 预览不会播声音；播放页仍走 audioHost（LevelRunnerV4）。
 */
import { useEffect, useRef, useState } from 'react'
import type { Json } from '../../engine/expr'
import { LevelStageV4 } from '../../runtime/v4/LevelStageV4'
import { useV4Snapshot } from '../../runtime/v4/sessionHost'
import { V4DebugController, type V4DebugSnapshot } from './debugRunV4'
import type { V4EditorSlotProps } from './shared'
import './v4-preview.css'

type RunPhase = 'idle' | 'live' | 'stopped'

/** JSON 预览文本：undefined/NaN 等异常值降级为 null 而不是抛错 */
function jsonText(value: Json | undefined): string {
  try {
    const text = JSON.stringify(value ?? null)
    return text === undefined ? 'null' : text
  } catch {
    return String(value)
  }
}

export function PreviewTab({ doc, revision }: V4EditorSlotProps): React.ReactElement {
  const [controller, setController] = useState<V4DebugController | null>(null)
  const [debugSnapshot, setDebugSnapshot] = useState<V4DebugSnapshot | null>(null)
  const [phase, setPhase] = useState<RunPhase>('idle')
  const [runKey, setRunKey] = useState(0)
  const [timerPaused, setTimerPaused] = useState(false)
  /** 会话创建失败（文档 lint 级问题等）：降级为可读提示，不让整块编辑器区域崩掉 */
  const [sessionError, setSessionError] = useState('')
  /** 文档重建/重开时是否自动进入运行态（「开始」后为 true；停止后为 false） */
  const liveRef = useRef(false)

  // 渲染快照经 useSyncExternalStore 订阅（session 内部缓存快照，引用稳定，不无限重渲染）
  const sessionSnapshot = useV4Snapshot(controller?.session ?? null)

  // 会话宿主：文档引用变化或点「重开」（runKey+1）时重建；卸载/重建时 stop（先放行 gate 再 dispose）
  useEffect(() => {
    setTimerPaused(false)
    setSessionError('')
    let next: V4DebugController
    try {
      next = new V4DebugController(doc, {
        onUpdate: (snapshot) => setDebugSnapshot(snapshot),
      })
    } catch (err) {
      // 装载期运行事件（如 shell 绑定求值失败）在 debugRunV4 的 notify 早于 session 赋值时
      // 会抛错——这里降级为可读错误，避免整个编辑器区域被 ErrorBoundary 吞掉。
      setController(null)
      setDebugSnapshot(null)
      setPhase('idle')
      setSessionError(`无法创建预览会话：${err instanceof Error ? err.message : String(err)}`)
      return
    }
    setController(next)
    setDebugSnapshot(next.getSnapshot())
    const unsubscribe = next.subscribe(() => setDebugSnapshot(next.getSnapshot()))
    if (liveRef.current) {
      setPhase('live')
      next.start()
    } else {
      setPhase('idle')
    }
    return () => {
      unsubscribe()
      next.stop()
    }
  }, [doc, runKey])

  const start = (): void => {
    if (!controller || phase === 'live') return
    if (phase === 'stopped') {
      // 停止后会话已 dispose：再「开始」等价于重开一轮
      replay()
      return
    }
    liveRef.current = true
    setPhase('live')
    controller.start()
  }

  const stop = (): void => {
    if (!controller) return
    liveRef.current = false
    controller.stop()
    setPhase('stopped')
  }

  const replay = (): void => {
    if (!controller) return
    liveRef.current = true
    setRunKey((value) => value + 1)
  }

  const pause = (): void => controller?.pause()
  const resume = (): void => controller?.resume()
  const step = (): void => controller?.step()
  const toggleTimersPaused = (paused: boolean): void => {
    setTimerPaused(paused)
    controller?.setTimersPaused(paused)
  }

  const paused = debugSnapshot?.paused ?? false
  const pausedAt = debugSnapshot?.pausedAt ?? null
  const result = sessionSnapshot?.result ?? null
  const progress = sessionSnapshot?.progress ?? { index: 0, total: 0 }
  const shownIndex = Math.min(progress.index, progress.total)
  const viewName = sessionSnapshot?.view ?? doc.content.shell.initialView ?? doc.content.shell.views[0]?.id ?? 'main'
  const debugState = controller ? controller.session.getDebugState() : null
  const questionResults = controller ? controller.session.questionResults : []
  const canOperate = controller !== null && phase !== 'stopped'

  const stateLabel =
    phase === 'stopped'
      ? '已停止'
      : result
        ? `已结算 · ${result.passed ? '通过' : '未通过'}`
        : paused
          ? '已暂停'
          : phase === 'live'
            ? '运行中…'
            : '未开始'

  const scopeRows: { key: string; label: string; testId: string; value: Json | undefined }[] = debugState
    ? [
        { key: 'v', label: 'v', testId: 'v4-preview-scope-v', value: debugState.scopes.v },
        { key: 'local', label: 'local', testId: 'v4-preview-scope-local', value: debugState.scopes.local },
        { key: 't', label: 't', testId: 'v4-preview-scope-t', value: debugState.scopes.t },
        { key: 'q', label: 'q', testId: 'v4-preview-scope-q', value: debugState.scopes.q },
        { key: 'qState', label: 'q.state', testId: 'v4-preview-scope-qstate', value: debugState.scopes.qState },
        { key: 'args', label: 'args', testId: 'v4-preview-scope-args', value: debugState.scopes.args },
        { key: 'run', label: 'run', testId: 'v4-preview-scope-run', value: debugState.scopes.run },
      ]
    : []

  return (
    <div className="v4-preview-tab" data-testid="v4-preview-tab" data-revision={revision}>
      <div className="v4-preview-controls" data-testid="v4-preview-controls">
        <button type="button" data-testid="v4-preview-start" disabled={!controller || phase === 'live'} onClick={start}>
          ▶ 开始
        </button>
        <button type="button" data-testid="v4-preview-stop" disabled={!controller || phase !== 'live'} onClick={stop}>
          ■ 停止
        </button>
        <button type="button" data-testid="v4-preview-replay" disabled={!controller} onClick={replay}>
          ↻ 重开
        </button>
        <button
          type="button"
          data-testid="v4-preview-pause"
          disabled={!canOperate || paused || result !== null}
          title="在当前节点执行完后、下一节点边界暂停"
          onClick={pause}
        >
          ⏸ 暂停
        </button>
        <button type="button" data-testid="v4-preview-resume" disabled={!paused} onClick={resume}>
          ▶ 继续
        </button>
        <button
          type="button"
          data-testid="v4-preview-step"
          disabled={!canOperate || result !== null}
          title="单步：执行到下一个节点边界再暂停"
          onClick={step}
        >
          ⏭ 单步
        </button>
        <label className="v4-preview-check" title="冻结组件计时器（session.setTimersPaused）">
          <input
            type="checkbox"
            data-testid="v4-preview-timers-pause"
            checked={timerPaused}
            disabled={phase === 'stopped'}
            onChange={(e) => toggleTimersPaused(e.currentTarget.checked)}
          />{' '}
          暂停计时器
        </label>
        <span className="v4-preview-state" data-testid="v4-preview-run-state" data-phase={phase}>
          {stateLabel}
        </span>
        <span className="v4-preview-progress" data-testid="v4-preview-progress">
          第 {shownIndex} / {progress.total} 题 · 视图 {viewName}
        </span>
      </div>

      <div className="v4-preview-body">
        <div className="v4-preview-main" data-testid="v4-preview-stage">
          {sessionError && (
            <div className="tone-error v4-preview-error" data-testid="v4-preview-session-error">
              {sessionError}
            </div>
          )}
          {controller && sessionSnapshot ? (
            <LevelStageV4
              session={controller.session}
              snapshot={sessionSnapshot}
              viewportClassName="v4-preview-viewport"
              canvasClassName="v4-preview-canvas"
            />
          ) : (
            <div className="v4-preview-empty" data-testid="v4-preview-stage-empty">
              预览会话准备中…
            </div>
          )}
        </div>

        <aside className="v4-preview-side" data-testid="v4-preview-debug">
          <section className="v4-preview-sec">
            <div className="v4-preview-sec-title">调用栈</div>
            {!debugState || debugState.callStack.length === 0 ? (
              <div className="muted">（无）</div>
            ) : (
              debugState.callStack.map((frame, index) => (
                <div key={`${frame.kind}:${index}`} className="v4-preview-row" data-testid={`v4-preview-frame-${index}`}>
                  <span className="v4-preview-kind">{frame.kind}</span>
                  <span>{frame.nodeId}</span>
                  {frame.typeId && (
                    <span className="muted">
                      {frame.typeId}/{frame.rowId}
                    </span>
                  )}
                </div>
              ))
            )}
            {pausedAt && (
              <div
                className="v4-preview-badge"
                data-testid="v4-preview-paused"
                data-kind={pausedAt.kind}
                data-node={pausedAt.nodeId}
              >
                ⏸ 暂停于 {pausedAt.kind}:{pausedAt.nodeId}
              </div>
            )}
          </section>

          <section className="v4-preview-sec" data-testid="v4-preview-scopes">
            <div className="v4-preview-sec-title">作用域（四层）</div>
            {scopeRows.map((row) => (
              <div key={row.key} className="v4-preview-scope">
                <span className="v4-preview-kind">{row.label}</span>
                <pre className="v4-preview-json" data-testid={row.testId}>
                  {jsonText(row.value)}
                </pre>
              </div>
            ))}
            {scopeRows.length === 0 && <div className="muted">（无）</div>}
          </section>

          <section className="v4-preview-sec" data-testid="v4-preview-deck-sec">
            <div className="v4-preview-sec-title">牌堆（{debugState?.deck.length ?? 0}）</div>
            <div data-testid="v4-preview-deck">
              {(debugState?.deck ?? []).map((item) => (
                <div key={item.slotIndex} className="v4-preview-row" data-testid={`v4-preview-deck-item-${item.slotIndex}`}>
                  <span className="v4-preview-index">{item.slotIndex + 1}.</span>
                  <span>
                    {item.type}/{item.row}
                  </span>
                  {item.args !== undefined && <span className="muted">{jsonText(item.args)}</span>}
                </div>
              ))}
              {(debugState?.deck.length ?? 0) === 0 && <div className="muted">（无——检查题型实例数据/题单）</div>}
            </div>
          </section>

          <section className="v4-preview-sec" data-testid="v4-preview-results">
            <div className="v4-preview-sec-title">每题返回（{questionResults.length}）</div>
            {questionResults.length === 0 ? (
              <div className="muted">（尚未有题目返回）</div>
            ) : (
              questionResults.map((entry) => (
                <div key={entry.callId} className="v4-preview-row" data-testid={`v4-preview-question-${entry.callId}`}>
                  <span className="v4-preview-index">#{entry.callId}</span>
                  <span>
                    {entry.typeId}/{entry.rowId}
                  </span>
                  <span className="muted">
                    {entry.result.status ?? 'answered'}
                    {entry.result.correct === undefined ? '' : ` · ${entry.result.correct ? '正确' : '错误'}`}
                    {entry.result.scoreDelta === undefined ? '' : ` · +${entry.result.scoreDelta}`}
                  </span>
                </div>
              ))
            )}
          </section>

          {result && (
            <div
              className={`v4-preview-result ${result.passed ? 'pass' : 'nopass'}`}
              data-testid="v4-preview-result"
              data-passed={result.passed ? 'true' : 'false'}
              aria-live="polite"
            >
              结算：得分 {result.score} · {result.passed ? '通过' : '未通过'}
            </div>
          )}

          <section className="v4-preview-sec" data-testid="v4-preview-logs-sec">
            <div className="v4-preview-sec-title">运行日志（{debugState?.logs.length ?? 0}）</div>
            <div className="v4-preview-logs" data-testid="v4-preview-logs">
              {(debugState?.logs ?? []).length === 0 ? (
                <div className="muted">（暂无日志）</div>
              ) : (
                (debugState?.logs ?? []).map((event, index) => (
                  <div
                    key={`${event.t}:${index}`}
                    className={`v4-preview-log ${event.kind}`}
                    data-testid={`v4-preview-log-${index}`}
                  >
                    <span className="v4-preview-kind">{event.kind}</span>
                    <span>
                      {event.nodeId ? `[${event.nodeId}] ` : ''}
                      {event.message ?? ''}
                    </span>
                  </div>
                ))
              )}
            </div>
          </section>
        </aside>
      </div>
    </div>
  )
}
