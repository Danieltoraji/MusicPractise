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
    const update = () => {
      const scale = Math.min(1, el.clientWidth / STAGE_W)
      setFit({ scale, left: Math.max(0, (el.clientWidth - STAGE_W * scale) / 2) })
    }
    update()
    const ro = new ResizeObserver(update)
    ro.observe(el)
    return () => ro.disconnect()
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
