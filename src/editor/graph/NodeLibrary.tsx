/**
 * 节点库（左栏）与画布右键菜单共用的菜单渲染。
 * 分组展示 + 搜索过滤（图大时快速定位）；点击项回调给容器执行 addNode。
 */
import { useState } from 'react'
import type { PaletteGroup, PaletteItem } from './palette'

interface MenuProps {
  groups: PaletteGroup[]
  onPick: (item: PaletteItem) => void
}

export function NodeLibraryPanel({ groups, onPick }: MenuProps) {
  return (
    <div className="glib">
      <div className="glib-title">节点库</div>
      {groups.map((g) => (
        <div key={g.id} className="glib-group">
          <div className="glib-group-head" title={g.hint}>
            {g.label}
          </div>
          {g.items.length === 0 ? (
            <div className="glib-empty muted">（画布里还没有可用项）</div>
          ) : (
            g.items.map((item) => (
              <button key={item.key} type="button" className="glib-item" title={item.desc} onClick={() => onPick(item)}>
                {item.label}
              </button>
            ))
          )}
        </div>
      ))}
    </div>
  )
}

/** 画布空白右键弹出的浮动菜单（与左栏同源数据；screen=屏幕定位，flow=节点落点） */
export function NodeContextMenu({
  groups,
  screen,
  onPick,
  onClose,
}: MenuProps & { screen: { x: number; y: number }; onClose: () => void }) {
  const [filter, setFilter] = useState('')
  const f = filter.trim()
  return (
    <div className="gmenu-backdrop" onMouseDown={onClose} onContextMenu={(e) => e.preventDefault()}>
      <div
        className="gmenu"
        style={{ left: screen.x, top: screen.y }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <input
          className="gmenu-filter"
          placeholder="搜索节点…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          // eslint 风格：进入菜单即聚焦（autofocus 属性在 React 受控下不可靠）
          autoFocus
        />
        {groups.map((g) => {
          const items = f ? g.items.filter((i) => `${g.label} ${i.label} ${i.desc ?? ''}`.includes(f)) : g.items
          if (items.length === 0) return null
          return (
            <div key={g.id} className="glib-group">
              <div className="glib-group-head">{g.label}</div>
              {items.map((item) => (
                <button
                  key={item.key}
                  type="button"
                  className="glib-item"
                  title={item.desc}
                  onClick={() => {
                    onPick(item)
                    onClose()
                  }}
                >
                  {item.label}
                </button>
              ))}
            </div>
          )
        })}
      </div>
    </div>
  )
}
