/**
 * 调试画面（批次9 可视化）：把调试会话渲染成可交互的游玩画面——与玩家页同构
 * （同一 ComponentView/store/emit 三件套），画面点击即 session.dispatch（与 AI 手动触发同路径）。
 * 渲染源来自 debugRun 快照的 stage（装载副本 + per-session store）；暂停时引擎挂起 +
 * 计时器冻结，画面完全静止；结算后可重开（restartDebug）。
 * 布局：顶条（题面/进度/暂停徽标）+ 800×470 fit-scale 画布 + 底条（结算/重开）。
 */
import { useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react'
import { ComponentView } from '../../components/views'
import type { LevelDoc } from '../../engine/level'
import { promptText } from '../../runtime/LevelRunner'
import { getDebugSnapshot, restartDebug, subscribeDebugRun } from './debugRun'

/** 画布逻辑尺寸（与玩家页 .level-canvas 一致；组件按此坐标系绝对定位） */
const STAGE_W = 800
const STAGE_H = 470

export function DebugStage({ doc }: { doc: LevelDoc }) {
  const snap = useSyncExternalStore(subscribeDebugRun, getDebugSnapshot)
  const stage = snap.stage
  const wrapRef = useRef<HTMLDivElement>(null)
  const [scale, setScale] = useState(1)

  // fit-scale：容器宽 / 800，窄面板画面等比缩小不滚条
  useLayoutEffect(() => {
    const el = wrapRef.current
    if (!el) return
    const update = () => setScale(Math.min(1, el.clientWidth / STAGE_W))
    update()
    const ro = new ResizeObserver(update)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const firstView = doc.content.views[0]?.id ?? 'main'
  const viewId = snap.view || firstView

  if (!stage) {
    return (
      <div className="gdb-stage">
        <div className="gdb-stage-empty muted">
          <p>无运行中的调试会话。</p>
          <p>在右侧调试面板点「▶ 启动调试」，或让 AI 用 debug_control 启动。</p>
        </div>
      </div>
    )
  }

  const comps = stage.doc.content.components.filter((c) => (c.view ?? firstView) === viewId)
  const viewName = doc.content.views.find((v) => v.id === viewId)?.name ?? viewId

  return (
    <div className="gdb-stage">
      <div className="gdb-stage-head">
        <span className="gdb-stage-title">{String(stage.doc.meta.title ?? doc.meta.title ?? '调试运行')}</span>
        <span className="muted">{viewName}</span>
        <span className="muted">
          第 {Math.min(snap.row + 1, snap.total)} / {snap.total} 题
        </span>
        {promptText(snap.rowData) && <span className="gdb-stage-prompt">{promptText(snap.rowData)}</span>}
        {snap.mode === 'paused' && <span className="gdb-stage-badge">⏸ 已暂停于 {snap.pausedAt}</span>}
      </div>
      <div className="gdb-stage-viewport" ref={wrapRef}>
        <div
          key={stage.sessionNo}
          className="gdb-stage-canvas"
          style={{ transform: `scale(${scale})`, width: STAGE_W, height: STAGE_H }}
        >
          {comps.map((c) => (
            <ComponentView key={c.id} spec={c} store={stage.store} emit={stage.emitFor(c.id)} />
          ))}
        </div>
      </div>
      <div className="gdb-stage-foot">
        {snap.finished ? (
          <span className={snap.finished.passed ? 'pass' : 'nopass'}>
            已完成 · 得分 {String(snap.finished.score)} · {snap.finished.passed ? '通过 🎉' : '未通过'}
          </span>
        ) : (
          <span className="muted">画面可交互——点击组件即向调试会话派发真实事件</span>
        )}
        <button type="button" className="link" onClick={() => restartDebug()}>
          ↻ 重开
        </button>
      </div>
    </div>
  )
}
