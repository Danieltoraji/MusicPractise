/**
 * 调试画面（批次9 可视化 / 批次12 改用共享 LevelStage）：把调试会话渲染成可交互的
 * 游玩画面——与玩家页同构（同一 LevelStage/ComponentView/store/emit 三件套），
 * 画面点击即 session.dispatch（与 AI 手动触发同路径）。
 * 渲染源来自 debugRun 快照的 stage（装载副本 + per-session store）；
 * 暂停时引擎挂起 + 计时器冻结，画面完全静止；结算后可重开（restartDebug）。
 * 布局：顶条（题面/进度/暂停徽标）+ LevelStage（fit-scale）+ 底条（结算/重开）。
 */
import { useSyncExternalStore } from 'react'
import type { LevelDoc } from '../../engine/level'
import { promptText } from '../../runtime/LevelRunner'
import { LevelStage } from '../../runtime/LevelStage'
import { getDebugSnapshot, restartDebug, subscribeDebugRun } from './debugRun'

export function DebugStage({ doc }: { doc: LevelDoc }) {
  const snap = useSyncExternalStore(subscribeDebugRun, getDebugSnapshot)
  const stage = snap.stage

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

  const firstView = doc.content.views[0]?.id ?? 'main'
  const viewId = snap.view || firstView
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
      <LevelStage
        doc={stage.doc}
        store={stage.store}
        emitFor={(id) => stage.emitFor(id)}
        view={viewId}
        sessionKey={stage.sessionNo}
        viewportClassName="gdb-stage-viewport"
        canvasClassName="gdb-stage-canvas"
      />
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
