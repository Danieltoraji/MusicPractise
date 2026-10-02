/**
 * 工作台 dock 面板通用外壳（docs/29）：标题栏（图标 + 名称 + ✕ 关闭）+ 内容区。
 * 组件库 / 事件管理 / 变量 / 属性 四个左/右面板共用；AI 面板自带标题栏不走此壳。
 * 显隐由 GraphEditor 的 panels 状态管理（工具栏切换按钮 ↔ ✕ 双向同一真源）。
 */

import type { ReactNode } from 'react'

interface Props {
  icon: string
  title: string
  onClose: () => void
  children: ReactNode
  /** 追加到面板根（如 gdock--lib：左栏堆叠时的占比规则） */
  className?: string
}

export function DockPanel({ icon, title, onClose, children, className }: Props) {
  return (
    <section className={`gdock${className ? ` ${className}` : ''}`}>
      <header className="gdock-head">
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
