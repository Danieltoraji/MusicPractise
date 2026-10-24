/**
 * 游玩舞台（批次12 移动端适配）：800×470 设计坐标系的组件渲染层——玩家页（LevelRunner）
 * 与编辑器调试画面（DebugStage）的共享实现，单一真源。
 * fit-scale：容器实测宽 / 800 等比缩放（上限 1，宽屏不变），窄屏/手机从「横向滚动」
 * 变为「整幅等比缩小并水平居中」；transform 缩放不影响事件命中（浏览器自动映射坐标）。
 */
import { useLayoutEffect, useRef, useState } from 'react'
import { ComponentView } from '../components/views'
import { EDITOR_HOOKS } from '../editor/editorHooks'
import type { LevelDoc } from '../engine/level'
import type { Json } from '../engine/expr'
import type { ComponentStore } from './store'

export const STAGE_W = 800
export const STAGE_H = 470

/** G11（docs/44 R26）：纯函数 fit 计算，便于单测边界/稳定性（宽 0 兜底 scale 0，保持既有语义） */
export function computeStageFit(width: number): { scale: number; left: number } {
  const w = Number.isFinite(width) && width > 0 ? width : 0
  const scale = Math.min(1, w / STAGE_W)
  return { scale, left: Math.max(0, (w - STAGE_W * scale) / 2) }
}

export function LevelStage({
  doc,
  store,
  emitFor,
  view,
  sessionKey,
  viewportClassName,
  canvasClassName,
}: {
  doc: LevelDoc
  store: ComponentStore
  emitFor(id: string): (event: string, payload?: Json) => void
  /** 当前视图 id（空串回落首个视图） */
  view: string
  /** 变化时强制重挂画布（调试会话更替——组件状态 store 随之换实例） */
  sessionKey?: number | string
  viewportClassName?: string
  canvasClassName?: string
}) {
  const wrapRef = useRef<HTMLDivElement>(null)
  const [fit, setFit] = useState({ scale: 1, left: 0 })

  useLayoutEffect(() => {
    const el = wrapRef.current
    if (!el) return
    // G11（docs/44 R26）：ResizeObserver 回调经 rAF 合并 + Object.is 短路——
    // 连续回调不再每次都 setState 新对象（此前舞台整棵树随每次 ResizeObserver 重渲染）。
    let raf = 0
    const apply = (): void => {
      const next = computeStageFit(el.clientWidth)
      setFit((prev) => (prev.scale === next.scale && prev.left === next.left ? prev : next))
    }
    const schedule = (): void => {
      if (raf !== 0) return
      raf = requestAnimationFrame(() => {
        raf = 0
        apply()
      })
    }
    apply() // 首帧同步测量，避免缩放闪跳
    const ro = new ResizeObserver(schedule)
    ro.observe(el)
    return () => {
      ro.disconnect()
      if (raf !== 0) cancelAnimationFrame(raf)
    }
  }, [])

  const firstView = doc.content.views[0]?.id ?? 'main'
  const viewId = view || firstView
  const comps = doc.content.components.filter((c) => (c.view ?? firstView) === viewId)

  return (
    <div ref={wrapRef} className={`${EDITOR_HOOKS.stageViewport}${viewportClassName ? ` ${viewportClassName}` : ''}`}>
      <div
        key={sessionKey}
        className={`${EDITOR_HOOKS.stageCanvas}${canvasClassName ? ` ${canvasClassName}` : ''}`}
        style={{
          transform: `scale(${fit.scale})`,
          width: STAGE_W,
          height: STAGE_H,
          left: fit.left,
        }}
      >
        {comps.map((c) => (
          <ComponentView key={c.id} spec={c} store={store} emit={emitFor(c.id)} />
        ))}
      </div>
    </div>
  )
}
