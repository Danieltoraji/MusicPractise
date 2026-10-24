/**
 * 编辑器统一弹窗外壳（docs/40 D4）：对话框语义 + 焦点陷阱 + ESC + 焦点归还 + 滚动锁。
 * 此前三个弹窗（JSON 单元格/五线谱/列表）各自为政：无 role/aria-modal、ESC 覆盖不全、
 * 关闭后焦点丢失、背景可滚动。样式沿用 .tjson-backdrop/.tjson-modal（跨页复用的既有契约类名）。
 * 挂载即注册 keyGuard 模态计数（编辑器全局快捷键短路，B5）。
 */
import { useEffect, useRef, type ReactNode } from 'react'
import { registerModalOpen } from './keyGuard'

const FOCUSABLE = 'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'

export function Modal(props: {
  title: ReactNode
  onClose: () => void
  children: ReactNode
  /** 头部右侧动作区（取消/应用按钮由调用方渲染，便于定制文案与主次） */
  actions?: ReactNode
  /** 内容区额外类名（如五线谱弹窗的宽体） */
  contentClassName?: string
}): React.ReactElement {
  const panelRef = useRef<HTMLDivElement>(null)
  const restoreRef = useRef<HTMLElement | null>(null)

  // 模态计数（快捷键短路）+ 焦点管理 + 滚动锁
  useEffect(() => {
    const unregister = registerModalOpen()
    restoreRef.current = document.activeElement as HTMLElement | null
    // 打开时聚焦面板内第一个可聚焦元素
    const first = panelRef.current?.querySelector<HTMLElement>(FOCUSABLE)
    ;(first ?? panelRef.current)?.focus()
    const prevOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      unregister()
      document.body.style.overflow = prevOverflow
      restoreRef.current?.focus?.()
    }
  }, [])

  // ESC 关闭（捕获阶段，先于子组件快捷键）；Tab 焦点陷阱
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        props.onClose()
        return
      }
      if (e.key !== 'Tab') return
      const panel = panelRef.current
      if (!panel) return
      const items = [...panel.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => !el.hasAttribute('disabled'))
      if (items.length === 0) return
      const first = items[0]
      const last = items[items.length - 1]
      const active = document.activeElement as HTMLElement | null
      if (e.shiftKey && (active === first || !panel.contains(active))) {
        e.preventDefault()
        last.focus()
      } else if (!e.shiftKey && active === last) {
        e.preventDefault()
        first.focus()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- onClose 由调用方保证稳定（或接受重挂）
  }, [props.onClose])

  return (
    <div
      className="tjson-backdrop modal-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) props.onClose()
      }}
    >
      <div
        ref={panelRef}
        className={`tjson-modal modal-shell${props.contentClassName ? ` ${props.contentClassName}` : ''}`}
        role="dialog"
        aria-modal="true"
        data-testid="modal"
        tabIndex={-1}
      >
        <div className="tjson-modal-head modal-head">
          <b>{props.title}</b>
          {props.actions}
        </div>
        {props.children}
      </div>
    </div>
  )
}
