/**
 * 节点库（左栏）与画布右键菜单共用的菜单渲染：分组 + 搜索过滤 + 模板组置顶。
 */
import { useState } from 'react'
import type { PaletteGroup, PaletteItem, PaletteTemplate } from './palette'

export interface NodeMenuProps {
  groups: PaletteGroup[]
  templates: PaletteTemplate[]
  onPick: (item: PaletteItem) => void
  onPickTemplate: (tpl: PaletteTemplate) => void
}

function matches(filter: string, group: PaletteGroup, item: PaletteItem): boolean {
  return `${group.label} ${item.label} ${item.desc ?? ''}`.includes(filter)
}

function TemplateButtons({ templates, onPick }: { templates: PaletteTemplate[]; onPick: (tpl: PaletteTemplate) => void }) {
  if (templates.length === 0) return null
  return (
    <div className="glib-group">
      <div className="glib-group-head" title="一键落一组预连好的常用逻辑">
        模板
      </div>
      {templates.map((tpl) => (
        <button key={tpl.key} type="button" className="glib-item glib-item-tpl" title={tpl.desc} onClick={() => onPick(tpl)}>
          ▸ {tpl.label}
        </button>
      ))}
    </div>
  )
}

export function NodeLibraryPanel({ groups, templates, onPick, onPickTemplate }: NodeMenuProps) {
  const [filter, setFilter] = useState('')
  const f = filter.trim()
  return (
    <div className="glib">
      <div className="glib-title">节点库</div>
      <input
        className="gmenu-filter"
        placeholder="搜索节点…"
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
      />
      <TemplateButtons templates={templates} onPick={onPickTemplate} />
      {groups.map((g) => {
        const items = f ? g.items.filter((i) => matches(f, g, i)) : g.items
        if (items.length === 0) return null
        return (
          <div key={g.id} className="glib-group">
            <div className="glib-group-head" title={g.hint}>
              {g.label}
            </div>
            {items.map((item) => (
              <button key={item.key} type="button" className="glib-item" title={item.desc} onClick={() => onPick(item)}>
                {item.label}
              </button>
            ))}
          </div>
        )
      })}
    </div>
  )
}

/** 画布空白右键弹出的浮动菜单（与左栏同源数据；screen=屏幕定位，落点由容器换算） */
export function NodeContextMenu({
  groups,
  templates,
  screen,
  onPick,
  onPickTemplate,
  onClose,
}: NodeMenuProps & { screen: { x: number; y: number }; onClose: () => void }) {
  const [filter, setFilter] = useState('')
  const f = filter.trim()
  // 屏幕边缘钳制：菜单宽约 250、高约 420
  const left = Math.min(screen.x, Math.max(8, window.innerWidth - 262))
  const top = Math.min(screen.y, Math.max(8, window.innerHeight - 432))
  return (
    <div className="gmenu-backdrop" onMouseDown={onClose} onContextMenu={(e) => e.preventDefault()}>
      <div
        className="gmenu"
        style={{ left, top }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <input
          className="gmenu-filter"
          placeholder="搜索节点…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          autoFocus
        />
        <TemplateButtons templates={templates} onPick={onPickTemplate} />
        {groups.map((g) => {
          const items = f ? g.items.filter((i) => matches(f, g, i)) : g.items
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

/** 事件面板（左栏）：与变量面板同级，点击即落一个 on 节点 */
export function EventsPanel({
  groups,
  onPick,
}: {
  groups: { group: string; items: { value: string; label: string; desc?: string }[] }[]
  onPick: (event: string) => void
}) {
  return (
    <div className="gevents">
      <div className="glib-title" title="点击事件 → 在画布落一个事件节点">
        事件
      </div>
      {groups.map((g) => (
        <div key={g.group}>
          <div className="glib-group-head">{g.group}</div>
          {g.items.map((i) => (
            <button key={i.value} type="button" className="glib-item" title={i.desc ?? i.value} onClick={() => onPick(i.value)}>
              + {i.label}
            </button>
          ))}
        </div>
      ))}
    </div>
  )
}
