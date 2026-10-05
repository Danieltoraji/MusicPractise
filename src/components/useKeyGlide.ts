/**
 * 键盘类组件的滑奏 hook（批次12 fingering 引入、批次13 抽共享供 synth 面板复用）：
 * 按下（pointerdown）立即发声——钢琴语义，桌面点击从「松手响」变「按下响」；
 * 按住拖划经 elementFromPoint 命中换键连发；松手时浏览器对起始键补发的
 * click 由 movedRef 抑制（发声权已归 pointerdown）。
 * 命中约定：键元素带 data-midi 属性，容器挂 pointerHandlers。
 */
import { useRef } from 'react'

export interface KeyGlide {
  /** 键的 onClick 里检查：true 时跳过（滑奏已发声） */
  movedRef: React.MutableRefObject<boolean>
  /** 展开挂到键盘容器 div */
  pointerHandlers: {
    onPointerDown: (e: React.PointerEvent) => void
    onPointerMove: (e: React.PointerEvent) => void
    onPointerUp: (e: React.PointerEvent) => void
    onPointerCancel: (e: React.PointerEvent) => void
  }
}

export function useKeyGlide(strike: (midi: number) => void): KeyGlide {
  const glideRef = useRef<{ pointerId: number; lastMidi: number | null } | null>(null)
  const movedRef = useRef(false)

  const onPointerDown = (e: React.PointerEvent): void => {
    if (!e.isPrimary || glideRef.current) return
    glideRef.current = { pointerId: e.pointerId, lastMidi: null }
    // 按下瞬间即发声，该键的 click 由 movedRef 抑制——发声权已归 pointerdown
    movedRef.current = true
    const key = e.target instanceof Element ? e.target.closest<HTMLElement>('[data-midi]') : null
    const midi = key ? Number(key.dataset.midi) : NaN
    if (Number.isFinite(midi)) {
      glideRef.current.lastMidi = midi
      strike(midi)
    }
  }

  const onPointerMove = (e: React.PointerEvent): void => {
    const glide = glideRef.current
    if (!glide || e.pointerId !== glide.pointerId) return
    const el = document.elementFromPoint(e.clientX, e.clientY)
    const key = el instanceof Element ? el.closest<HTMLElement>('[data-midi]') : null
    const midi = key ? Number(key.dataset.midi) : NaN
    if (!Number.isFinite(midi) || midi === glide.lastMidi) return
    glide.lastMidi = midi
    movedRef.current = true
    strike(midi)
  }

  const end = (e: React.PointerEvent): void => {
    if (glideRef.current?.pointerId !== e.pointerId) return
    glideRef.current = null
    // click 补发发生在 pointerup 之后：延迟一拍复位，让键的 onClick 跳过这一次
    setTimeout(() => {
      movedRef.current = false
    }, 0)
  }

  return {
    movedRef,
    pointerHandlers: { onPointerDown, onPointerMove, onPointerUp: end, onPointerCancel: end },
  }
}
