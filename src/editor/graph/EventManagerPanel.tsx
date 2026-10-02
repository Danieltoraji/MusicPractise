/**
 * 事件管理器（docs/29）：节点图可用事件的统一入口，派生式注册表——
 * 系统事件（关卡/题目/视图）+ 组件事件（各实例契约）+ 内部事件（图中 on/emit 出现过的 名:名）。
 * 不持久化事件清单：事件「存在」= 图中有节点引用它；「新增内部事件」直接落 on 节点即注册。
 * 行内动作：+ 处理器（落 on 节点）；内部事件另有 emit（落 emit 节点）与 定位（聚焦首个处理器）。
 */
import { useMemo, useState } from 'react'
import type { LevelDoc } from '../../engine/level'
import { buildEventGroups } from './palette'

/** 引擎 graphProgram 的 EVENT_RE 同款（内部事件额外要求含 : 分隔） */
const INTERNAL_EVENT_RE = /^[A-Za-z_][A-Za-z0-9_]*:[A-Za-z_][A-Za-z0-9_]*$/

interface Props {
  doc: LevelDoc
  onAddOn: (event: string) => void
  onAddEmit: (event: string) => void
  onFocusNode: (nodeId: string) => void
}

export function EventManagerPanel({ doc, onAddOn, onAddEmit, onFocusNode }: Props) {
  const [filter, setFilter] = useState('')
  const [newName, setNewName] = useState('')
  const [newErr, setNewErr] = useState<string | null>(null)

  const groups = useMemo(() => buildEventGroups(doc), [doc])
  // 内部事件 → 首个 on 处理器节点 id（定位用；emit 声明但无人处理时不可定位）
  const internalHandler = useMemo(() => {
    const map = new Map<string, string>()
    for (const n of doc.content.logic.nodes) {
      if (n.kind === 'on' && n.event.includes(':') && !map.has(n.event)) map.set(n.event, n.id)
    }
    return map
  }, [doc])
  const internalGroup = groups.find((g) => g.group === '内部事件')
  const knownInternal = new Set((internalGroup?.items ?? []).map((i) => i.value))

  const f = filter.trim()
  const shown = groups
    .map((g) => ({ ...g, items: f ? g.items.filter((i) => `${i.value} ${i.label} ${i.desc ?? ''}`.includes(f)) : g.items }))
    .filter((g) => g.items.length > 0)

  const addInternal = (): void => {
    const name = newName.trim()
    if (!INTERNAL_EVENT_RE.test(name)) {
      setNewErr('需形如「名:名」（字母数字下划线），如 app:hint')
      return
    }
    if (knownInternal.has(name)) {
      setNewErr('该内部事件已在图中使用')
      return
    }
    setNewErr(null)
    setNewName('')
    onAddOn(name)
  }

  const row = (value: string, label: string, desc: string | undefined, internal: boolean): React.ReactNode => (
    <div key={value} className="gem-row" title={desc ?? value}>
      <button type="button" className="gem-add" title={`添加处理器：on ${value}`} onClick={() => onAddOn(value)}>
        + {label}
      </button>
      {internal && (
        <>
          <button type="button" className="gem-act" title={`落一个 emit 节点派发 ${value}`} onClick={() => onAddEmit(value)}>
            emit
          </button>
          <button
            type="button"
            className="gem-act"
            disabled={!internalHandler.has(value)}
            title={internalHandler.has(value) ? `定位处理器节点 ${internalHandler.get(value)}` : '尚无处理器（只有 emit 引用）'}
            onClick={() => {
              const id = internalHandler.get(value)
              if (id) onFocusNode(id)
            }}
          >
            定位
          </button>
        </>
      )}
    </div>
  )

  return (
    <div className="gem">
      <input className="gmenu-filter" placeholder="搜索事件…" value={filter} onChange={(e) => setFilter(e.target.value)} />
      {shown.map((g) => (
        <div key={g.group}>
          <div className="glib-group-head" title={g.group === '内部事件' ? '图中 on/emit 引用过的 名:名 事件' : undefined}>
            {g.group}
          </div>
          {g.items.map((i) => row(i.value, i.label, i.desc, g.group === '内部事件'))}
        </div>
      ))}
      {shown.length === 0 && <div className="glib-empty muted">没有匹配的事件</div>}
      {!internalGroup && !f && (
        <div className="glib-empty muted">暂无内部事件——在下方注册一个，或从节点库「控制流」添加 emit 节点。</div>
      )}
      <div className="gem-new">
        <input
          placeholder="新内部事件，如 app:hint"
          value={newName}
          onChange={(e) => {
            setNewName(e.target.value)
            setNewErr(null)
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') addInternal()
          }}
        />
        <button type="button" onClick={addInternal} title="注册并立即添加它的处理器节点">
          + 处理器
        </button>
      </div>
      {newErr && <div className="gem-err">{newErr}</div>}
    </div>
  )
}
