/**
 * v4 双层游玩舞台（docs/52 W3.1 / docs/53 §11）：
 * 单一 800×470 fit 画布内——shell 层常驻在下、surface 层按题型调用整帧挂载/卸载在上。
 *
 * 契约：
 * - 保留 `.stage-viewport` / `.stage-canvas`（fit-scale 复用 `computeStageFit`，单次变换）；
 * - 组件渲染复用 `ComponentView` 通路，store 分层：shell 用 `session.shellStore`、
 *   surface 用 `session.getSurfaceStore()`（每帧新建，组件内部状态随帧重置）；
 * - surface 层包 `div.v4-surface`，key 含 callId（docs/53 §11）+ 帧 store 序号：
 *   flow restart 会把 callId 归零，仅靠 callId 时上一帧 DOM 可能被 React 复用，
 *   追加每帧唯一的 store 序号保证「整帧卸载重建」语义；
 * - surface 为空时不渲染该层。
 *
 * 边界：本组件只做渲染与事件转发（shell → session.dispatchShellEvent，
 * surface → session.dispatchSurfaceEvent），不持有流程状态。
 */
import { useLayoutEffect, useRef, useState } from 'react'
import { ComponentView } from '../../components/views'
import { EDITOR_HOOKS } from '../../editor/editorHooks'
import type { Json } from '../../engine/expr'
import type { ComponentInstanceV4 } from '../../engine/v4/model'
import { STAGE_H, STAGE_W, computeStageFit } from '../stageGeometry'
import type { ComponentStore } from '../store'
import type { V4Session, V4Snapshot } from './session'
import './v4-runtime.css'

/**
 * 题型内视图过滤（v4.1，docs/56）：组件未声明 `view` 时在所有视图可见（题面/反馈等常驻件）；
 * 题型没有视图时全部渲染。视图只过滤渲染，组件 store 不重建。
 */
export function filterSurfaceComponents(
  components: ComponentInstanceV4[],
  view: string,
): ComponentInstanceV4[] {
  if (view === '') return components
  return components.filter((component) => component.view === undefined || component.view === view)
}

export interface LevelStageV4Props {
  session: V4Session
  /** 会话快照（调用方经 useV4Snapshot 订阅后传入，保证重渲染） */
  snapshot: V4Snapshot
  /** 视口附加 class（玩家页传 level-canvas-wrap，与 v3 一致） */
  viewportClassName?: string
  /** 画布附加 class（玩家页传 level-canvas） */
  canvasClassName?: string
}

export function LevelStageV4({ session, snapshot, viewportClassName, canvasClassName }: LevelStageV4Props) {
  const wrapRef = useRef<HTMLDivElement>(null)
  const [fit, setFit] = useState({ scale: 1, left: 0 })
  /** 帧序号缓存：surface store 实例 → 稳定递增序号（WeakMap 不阻止 store 回收） */
  const frameKeys = useRef({ next: 0, seen: new WeakMap<ComponentStore, number>() })

  // G11（docs/44 R26）：ResizeObserver 回调经 rAF 合并 + Object.is 短路（与 LevelStage 同口径）
  useLayoutEffect(() => {
    const el = wrapRef.current
    if (!el) return
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

  // shell 组件按当前视图过滤；v4 规格要求 shell.view 必填，缺失时按当前视图兜底（不隐藏组件）
  const shellComponents = snapshot.shell.filter((component) => (component.view ?? snapshot.view) === snapshot.view)

  const surface = snapshot.surface
  const surfaceStore = surface ? session.getSurfaceStore() : null
  let surfaceFrameKey = ''
  if (surface && surfaceStore) {
    const cache = frameKeys.current
    let seq = cache.seen.get(surfaceStore)
    if (seq === undefined) {
      seq = ++cache.next
      cache.seen.set(surfaceStore, seq)
    }
    surfaceFrameKey = `${surface.callId}:${seq}`
  }

  const emitShell = (componentId: string) =>
    (event: string, payload?: Json): void => {
      session.dispatchShellEvent(componentId, event, payload)
    }
  const emitSurface = (componentId: string) =>
    (event: string, payload?: Json): void => {
      session.dispatchSurfaceEvent(componentId, event, payload)
    }

  return (
    <div
      ref={wrapRef}
      className={`${EDITOR_HOOKS.stageViewport}${viewportClassName ? ` ${viewportClassName}` : ''}`}
      data-testid="v4-stage-viewport"
    >
      <div
        className={`${EDITOR_HOOKS.stageCanvas}${canvasClassName ? ` ${canvasClassName}` : ''}`}
        style={{
          transform: `scale(${fit.scale})`,
          width: STAGE_W,
          height: STAGE_H,
          left: fit.left,
        }}
      >
        <div className="v4-shell" data-testid="v4-shell">
          {shellComponents.map((component) => (
            <ComponentView
              key={component.id}
              spec={component}
              store={session.shellStore}
              emit={emitShell(component.id)}
            />
          ))}
        </div>
        {surface && surfaceStore ? (
          <div
            key={surfaceFrameKey}
            className="v4-surface"
            data-testid="v4-surface"
            data-call-id={surface.callId}
            data-view={surface.view}
          >
            {filterSurfaceComponents(surface.components, surface.view).map((component) => (
              <ComponentView
                key={component.id}
                spec={component}
                store={surfaceStore}
                emit={emitSurface(component.id)}
              />
            ))}
          </div>
        ) : null}
      </div>
    </div>
  )
}
