/**
 * 工作台 dock 面板通用外壳（docs/29）：标题栏（图标 + 名称 + ✕ 关闭）+ 内容区。
 * 组件库 / 事件管理 / 变量 / 属性 面板共用；AI 面板自带标题栏不走此壳。
 * 标题栏同时是拖拽手柄（跨列槽移动/列内排序，GraphEditor 统一管理 DnD 状态）；
 * 显隐由 dock.hidden 管理（工具栏切换按钮 ↔ ✕ 双向同一真源）。
 */

import type { CSSProperties, DragEvent, ReactNode } from 'react'

interface Props {
  icon: string
  title: string
  onClose: () => void
  children: ReactNode
  /** 追加到面板根（drag-src 拖拽源半透明等） */
  className?: string
  /** 面板根内联样式（列内定高） */
  style?: CSSProperties
  /** 提供即启用标题栏拖拽（面板 id） */
  dragId?: string
  onDragStart?: (id: string) => void
  onDragEnd?: () => void
  /** 标题栏 dragover：由宿主计算插入位置（上/下半） */
  onHeaderDragOver?: (e: DragEvent) => void
}

export function DockPanel({ icon, title, onClose, children, className, style, dragId, onDragStart, onDragEnd, onHeaderDragOver }: Props) {
  return (
    <section className={`gdock${className ? ` ${className}` : ''}`} style={style}>
      <header
        className={`gdock-head${dragId ? ' is-draggable' : ''}`}
        draggable={!!dragId}
        title={dragId ? `${title}：拖动标题栏可移动到其它列或调整顺序` : undefined}
        onDragStart={(e) => {
          // jsdom 合成事件无 dataTransfer——try/catch 容错（真实浏览器正常写入）
          try {
            e.dataTransfer.setData('text/plain', dragId ?? '')
            e.dataTransfer.effectAllowed = 'move'
          } catch {
            // ignore
          }
          onDragStart?.(dragId ?? '')
        }}
        onDragEnd={() => onDragEnd?.()}
        onDragOver={(e) => onHeaderDragOver?.(e)}
      >
        <span className="gdock-title">
          {icon} {title}
        </span>
        <button type="button" className="gdock-close" title={`收起「${title}」（可从工具栏按钮重新打开）`} onClick={onClose}>
          ✕
        </button>
      </header>
      <div className="gdock-body">{children}</div>
    </section>
  )
}
