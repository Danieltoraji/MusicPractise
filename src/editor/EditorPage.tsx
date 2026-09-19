/**
 * 关卡编辑器：视图管理 / 组件面板 / 画布拖放 / 属性检查器（含数据映射） / 节点图（逻辑）/ 数据表 / JSON / 保存与试运行。
 * v3：关卡 = 互斥视图（视图管理条 + 只渲染当前视图组件）+ 数据表（取代 questions，q.* 指向当前行）。
 * 组件类型与事件/命令枚举全部来自组件注册表契约（单一来源）。
 * 节点图编辑器为懒加载（@xyflow/react 不进主包）；代码页随 3-3 回归。
 */
import { useLiveQuery } from 'dexie-react-hooks'
import { db } from '../library/db'
import type { LibraryRecord } from '../library/db'
import { loadLevelDoc } from '../library/validate'
import { putResource } from '../library/db'
import { ErrorBoundary } from '../library/ErrorBoundary'
import { allContracts, ComponentStore, getDef } from '../runtime/store'
import { ComponentView } from '../components/views'
import { makeDirtyHashHandler } from './graph/dirtyGuard'
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ComponentInstance, LevelDoc } from '../engine/level'
import type { Json } from '../engine/expr'
import { parseExpr, ExprError } from '../engine/expr'
import { migrateDocToV3 } from '../engine/migrateDoc'
import {
  addComponent,
  addTableColumn,
  addTableRow,
  addView,
  blankLevelDoc,
  parseJsonText,
  removeComponent,
  removeTableColumn,
  removeTableRow,
  removeView,
  renameTableColumn,
  setMeta,
  updateComponent,
  updateTableCell,
  updateTableColumnLabel,
  updateView,
} from './docState'

type Tab = 'canvas' | 'graph' | 'script' | 'table' | 'json'

/** 节点图编辑器懒加载：@xyflow/react 体量较大，不进主包 */
const GraphEditor = lazy(() => import('./graph/GraphEditor'))
/** 脚本页与节点图同包域（依赖 script 引擎，体量小；保持同目录一致管理） */
const ScriptTab = lazy(() => import('./graph/ScriptTab'))

/** 预览层的空事件发射器（模块级稳定引用，避免内联箭头导致子组件反复重渲染） */
const noopEmit = (): void => {}

/** 表达式实时校验：语法错误返回消息，合法返回 null */
export function checkExprText(text: string): string | null {
  if (text.trim() === '') return null
  try {
    parseExpr(text)
    return null
  } catch (e) {
    return e instanceof ExprError ? e.message : String(e)
  }
}

interface Props {
  id: string
}

export function EditorPage({ id }: Props) {
  const record = useLiveQuery(async () => {
    if (id === 'new') return 'new'
    let got = await db.resources.get(id)
    if (!got) {
      // 防御 ensureSeeded 与首次查询并发的理论窗口：短暂等待后重试一次
      await new Promise((r) => setTimeout(r, 150))
      got = await db.resources.get(id)
    }
    return got ?? null
  }, [id], 'loading')
  const [doc, setDoc] = useState<LevelDoc | null>(null)
  const [tab, setTab] = useState<Tab>('canvas')
  const [selected, setSelected] = useState<string | null>(null)
  const [saveErrors, setSaveErrors] = useState<string[]>([])
  const [lintWarnings, setLintWarnings] = useState<string[]>([])
  const [savedTip, setSavedTip] = useState('')
  const [dirty, setDirty] = useState(false)

  // dirty-guard：刷新/关闭前浏览器原生确认；站内 hash 跳转在捕获阶段确认，取消则回滚 hash。
  // 回滚会再触发一次 hashchange——回声抑制：location.hash 已等于 prevHash 时直接放行。
  const dirtyRef = useRef(dirty)
  dirtyRef.current = dirty
  const prevHashRef = useRef(window.location.hash)
  const onHashChangeCapture = useMemo(
    () =>
      makeDirtyHashHandler({
        dirtyRef,
        prevHashRef,
        confirm: (m) => window.confirm(m),
        getLocationHash: () => window.location.hash,
        rollback: (hash) => {
          window.location.hash = hash
        },
      }),
    [],
  )
  useEffect(() => {
    const onBeforeUnload = (e: BeforeUnloadEvent): void => {
      if (!dirtyRef.current) return
      e.preventDefault()
      e.returnValue = '' // Safari 兼容
    }
    window.addEventListener('beforeunload', onBeforeUnload)
    window.addEventListener('hashchange', onHashChangeCapture, true)
    return () => {
      window.removeEventListener('beforeunload', onBeforeUnload)
      window.removeEventListener('hashchange', onHashChangeCapture, true)
    }
  }, [onHashChangeCapture])

  // 装载：new = 空白模板；否则取库内文档（可能是 v1/v2 旧记录——装载即迁移出 v3，评审 P1-1）。
  // loadedIdRef 语义：同一关卡不重复装载（保护未保存编辑）；换 id（#/edit/A → #/edit/B）强制重装
  const loadedIdRef = useRef<string | null>(null)
  useEffect(() => {
    if (record === 'loading' || record === undefined || record === null) return
    if (loadedIdRef.current === id) return
    loadedIdRef.current = id
    if (record === 'new') {
      setDoc(blankLevelDoc())
      return
    }
    try {
      const migrated = migrateDocToV3((record as LibraryRecord).doc)
      setDoc(migrated)
    } catch (err) {
      setSaveErrors([`文档迁移失败: ${err instanceof Error ? err.message : String(err)}`])
      setDoc(null)
      loadedIdRef.current = null
    }
  }, [record, id])
  const selectedComp = doc?.content.components.find((c) => c.id === selected) ?? null

  /** 编辑器内所有文档修改走这里：修改即标脏并清「已保存」提示 */
  const update = useCallback((next: LevelDoc) => {
    setSavedTip('')
    setDirty(true)
    setDoc(next)
  }, [])

  const save = useCallback(async (): Promise<boolean> => {
    if (!doc) return false
    const result = loadLevelDoc(doc)
    if (!result.ok) {
      setSaveErrors(result.errors)
      return false
    }
    // 内置示例不可被编辑器覆盖保存（会让 builtIn 记录被翻成用户文档）
    const existing = await db.resources.get(doc.id)
    if (existing?.builtIn === 1) {
      setSaveErrors(['内置示例不可直接覆盖保存——请在资源库对该关卡使用「编辑副本」获得可保存的副本'])
      return false
    }
    setSaveErrors([])
    setLintWarnings(result.lintWarnings)
    await putResource(result.doc as never)
    setDirty(false)
    setSavedTip(`已保存（v${result.doc.version}）`)
    return true
  }, [doc])

  async function tryRun(): Promise<void> {
    if ((await save()) && doc) window.location.hash = `#/level/${doc.id}`
  }

  if (record === 'loading' || record === undefined || !doc) {
    return <p className="muted page">{record === null && id !== 'new' ? '库中没有这个关卡' : '编辑器加载中…'}</p>
  }

  return (
    <div className="page editor">
      <div className="editor-head">
        <a href="#/library">← 资源库</a>
        <input
          className="editor-title"
          value={String(doc.meta.title ?? '')}
          onChange={(e) => update(setMeta(doc, { title: e.target.value }))}
        />
        <button type="button" className="primary" onClick={() => save()}>
          💾 保存{dirty ? ' *' : ''}
        </button>
        <button type="button" onClick={tryRun}>
          ▶ 试运行
        </button>
      </div>
      {saveErrors.length > 0 && (
        <div className="editor-errors">
          <b>无法保存，请修正：</b>
          <ul>
            {saveErrors.map((e, i) => (
              <li key={i}>{e}</li>
            ))}
          </ul>
        </div>
      )}
      {lintWarnings.length > 0 && (
        <div className="editor-lint">
          ⚠ lint：{lintWarnings.join('；')}
        </div>
      )}
      {savedTip && <div className="editor-saved">{savedTip}</div>}

      <div className="editor-tabs">
        {([
          ['canvas', '画布'],
          ['graph', '节点图'],
          ['script', '脚本'],
          ['table', '数据表'],
          ['json', 'JSON'],
        ] as [Tab, string][]).map(([t, label]) => (
          <button key={t} type="button" className={tab === t ? 'active' : ''} onClick={() => setTab(t)}>
            {label}
          </button>
        ))}
      </div>

      <ErrorBoundary>
        {tab === 'canvas' && (
          <EditorCanvas doc={doc} selected={selected} onSelect={setSelected} onChange={update} />
        )}

        {tab === 'graph' && (
          <Suspense fallback={<p className="muted">节点图加载中…</p>}>
            <GraphEditor doc={doc} onChange={update} />
          </Suspense>
        )}

        {tab === 'script' && (
          <Suspense fallback={<p className="muted">脚本加载中…</p>}>
            <ScriptTab doc={doc} onChange={update} />
          </Suspense>
        )}

        {tab === 'table' && <TableEditor doc={doc} onChange={update} />}

        {tab === 'json' && <JsonTab doc={doc} onApply={update} />}
      </ErrorBoundary>
      {tab === 'canvas' && selectedComp && (
        <Inspector
          doc={doc}
          comp={selectedComp}
          onChange={(patch) => update(updateComponent(doc, selectedComp.id, patch))}
          onRemove={() => {
            update(removeComponent(doc, selectedComp.id))
            setSelected(null)
          }}
        />
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// 画布 + 视图管理 + 组件面板
// ---------------------------------------------------------------------------

function EditorCanvas({
  doc,
  selected,
  onSelect,
  onChange,
}: {
  doc: LevelDoc
  selected: string | null
  onSelect: (id: string | null) => void
  onChange: (doc: LevelDoc) => void
}) {
  const canvasRef = useRef<HTMLDivElement>(null)
  const dragRef = useRef<{ id: string; grabX: number; grabY: number; rect: DOMRect } | null>(null)
  // 当前编辑的视图（组件互斥渲染的编辑侧对应物；不随 doc 变化重置）
  const [view, setView] = useState(doc.content.views[0]?.id ?? 'main')
  const currentView = doc.content.views.some((v) => v.id === view) ? view : (doc.content.views[0]?.id ?? 'main')

  function onBoxPointerDown(e: React.PointerEvent, comp: ComponentInstance): void {
    e.currentTarget.setPointerCapture(e.pointerId)
    onSelect(comp.id)
    const rect = canvasRef.current!.getBoundingClientRect()
    const layout = comp.layout ?? { x: 0, y: 0, w: 120, h: 40 }
    dragRef.current = { id: comp.id, grabX: e.clientX - rect.left - layout.x, grabY: e.clientY - rect.top - layout.y, rect }
  }

  function onBoxPointerMove(e: React.PointerEvent, comp: ComponentInstance): void {
    const drag = dragRef.current
    if (!drag || drag.id !== comp.id) return
    const rect = drag.rect
    const snap = (v: number) => Math.round(v / 10) * 10
    const boxW = comp.layout?.w ?? 120
    const boxH = comp.layout?.h ?? 40
    // 双向 clamp：画布内自由拖动，不出界
    const x = Math.min(rect.width - boxW, Math.max(0, snap(e.clientX - rect.left - drag.grabX)))
    const y = Math.min(rect.height - boxH, Math.max(0, snap(e.clientY - rect.top - drag.grabY)))
    onChange(updateComponent(doc, comp.id, { layout: { ...(comp.layout ?? { w: 120, h: 40 }), x, y } }))
  }

  function onBoxPointerUp(): void {
    dragRef.current = null
  }

  const palette = allContracts()

  // 真组件预览：专用 store（组件初始态驱动），组件列表变化即重建。
  // 预览层禁交互（pointer-events:none），事件类组件不会误发事件；visible=false 的组件以幽灵框呈现。
  const previewStore = useMemo(() => {
    const s = new ComponentStore()
    s.init(doc.content.components.map((c) => ({ ...c, visible: true })))
    return s
  }, [doc.content.components])

  const viewComps = doc.content.components.filter((c) => (c.view ?? doc.content.views[0]?.id) === currentView)

  return (
    <div className="editor-canvas-layout">
      <div className="palette">
        <b>组件面板</b>
        {(['music', 'ui', 'hidden'] as const).map((cat) => (
          <div key={cat}>
            <div className="palette-cat">{cat === 'music' ? '音乐' : cat === 'ui' ? '交互' : '隐形'}</div>
            {palette
              .filter((c) => c.category === cat)
              .map((c) => (
                <button key={c.type} type="button" onClick={() => onChange(addComponent(doc, c.type, currentView))}>
                  + {c.displayName}
                </button>
              ))}
          </div>
        ))}
      </div>

      <div className="canvas-main">
        <div className="views-bar">
          {doc.content.views.map((v) => (
            <span key={v.id} className={`views-chip${v.id === currentView ? ' is-current' : ''}`} title={v.id}>
              <button type="button" className="views-open" onClick={() => setView(v.id)}>
                {v.id === currentView ? '▸ ' : ''}
                {v.name || v.id}
                {v.template ? ' 📋' : ''}
              </button>
              <button
                type="button"
                className={v.template ? 'views-tpl on' : 'views-tpl'}
                title={v.template ? '模版视图：换行后自动切换到这里并重放数据绑定（点击取消）' : '设为模版视图（换行后自动切换到这里）'}
                onClick={() => onChange(updateView(doc, v.id, { template: !v.template }))}
              >
                ⭐
              </button>
              <button
                type="button"
                className="views-del"
                title={doc.content.views.length <= 1 ? '至少保留一个视图' : `删除视图 ${v.name || v.id}（其组件一并删除）`}
                onClick={() => {
                  if (doc.content.views.length <= 1) return
                  const comps = doc.content.components.filter((c) => (c.view ?? doc.content.views[0].id) === v.id)
                  if (comps.length > 0 && !window.confirm(`视图「${v.name || v.id}」还有 ${comps.length} 个组件，删除将一并移除。确定？`)) return
                  onChange(removeView(doc, v.id))
                  if (v.id === currentView) setView(doc.content.views.find((x) => x.id !== v.id)?.id ?? 'main')
                }}
              >
                ×
              </button>
            </span>
          ))}
          <button type="button" onClick={() => {
            const { doc: next, id } = addView(doc)
            onChange(next)
            setView(id)
          }}>
            + 视图
          </button>
          <span className="muted views-hint">互斥视图：运行时只渲染当前视图 · 📋/⭐ = 模版视图（换行自动切换+重放绑定）</span>
        </div>
        <div
          ref={canvasRef}
          className="editor-canvas"
          onPointerDown={() => onSelect(null)}
        >
          {viewComps.map((comp) => (
            <div
              key={comp.id}
              className={`editor-box ${selected === comp.id ? 'is-selected' : ''} ${comp.visible === false ? 'is-ghost' : ''}`}
              style={comp.layout ? { left: comp.layout.x, top: comp.layout.y, width: comp.layout.w, height: comp.layout.h } : undefined}
              data-comp-type={comp.type}
              onPointerDown={(e) => {
                e.stopPropagation()
                onBoxPointerDown(e, comp)
              }}
              onPointerMove={(e) => onBoxPointerMove(e, comp)}
              onPointerUp={onBoxPointerUp}
              onPointerCancel={onBoxPointerUp}
              title={`${comp.type} · ${comp.name ?? comp.id}`}
            >
              <div className="editor-box-preview" inert={true as unknown as boolean}>
                <ComponentView spec={{ ...comp, visible: true }} store={previewStore} emit={noopEmit} />
              </div>
              <span className="box-label">{comp.name ?? comp.id}</span>
            </div>
          ))}
          {viewComps.length === 0 && (
            <p className="muted" style={{ padding: 24 }}>
              当前视图没有组件——从左侧组件面板添加
            </p>
          )}
        </div>
      </div>

      <InspectorHint />
    </div>
  )
}

function InspectorHint() {
  return (
    <p className="muted" style={{ margin: '6px 2px' }}>
      拖拽移动组件；选中后在右侧属性检查器编辑。未选中的点击落在画布空白处即取消选中。
    </p>
  )
}

// ---------------------------------------------------------------------------
// 属性检查器（含数据映射：模版视图的「字段 → 显示值」绑定）
// ---------------------------------------------------------------------------

function Inspector({
  doc,
  comp,
  onChange,
  onRemove,
}: {
  doc: LevelDoc
  comp: ComponentInstance
  onChange: (patch: Partial<ComponentInstance>) => void
  onRemove: () => void
}) {
  const contract = safeContract(comp.type)
  const [propsText, setPropsText] = useState(() => JSON.stringify(comp.props ?? {}, null, 2))
  const [propsErr, setPropsErr] = useState('')
  const [bindText, setBindText] = useState(() => JSON.stringify(comp.bindings ?? {}, null, 2))
  const [bindErr, setBindErr] = useState('')

  // 切换选中组件时同步文本
  useEffect(() => {
    setPropsText(JSON.stringify(comp.props ?? {}, null, 2))
    setBindText(JSON.stringify(comp.bindings ?? {}, null, 2))
  }, [comp.id])

  const applyProps = (text: string): void => {
    setPropsText(text)
    const v = parseJsonText(text)
    if (v === null && text.trim() !== '') setPropsErr('不是合法 JSON')
    else {
      setPropsErr('')
      onChange({ props: v ?? {} })
    }
  }

  const applyBindings = (text: string): void => {
    setBindText(text)
    const v = parseJsonText(text)
    if (v === null || typeof v !== 'object' || Array.isArray(v)) setBindErr('需为 JSON 对象')
    else {
      setBindErr('')
      onChange({ bindings: v as Record<string, Json> })
    }
  }

  const num = (label: string, key: 'x' | 'y' | 'w' | 'h') => (
    <label>
      {label}{' '}
      <input
        type="number"
        value={(comp.layout ?? { x: 0, y: 0, w: 120, h: 40 })[key]}
        onChange={(e) => {
          const v = Number(e.target.value)
          if (Number.isFinite(v)) {
            const layout = { ...(comp.layout ?? { x: 0, y: 0, w: 120, h: 40 }), [key]: v }
            onChange({ layout })
          }
        }}
      />
    </label>
  )

  const bindingSlots = Object.keys(contract.bindings ?? {})
  const columnKeys = doc.content.table.columns.map((c) => c.key)

  return (
    <div className="inspector">
      <b>属性 · {comp.type}</b>
      <label>
        名称 <input value={comp.name ?? ''} onChange={(e) => onChange({ name: e.target.value })} />
      </label>
      <label>
        <input type="checkbox" checked={comp.visible !== false} onChange={(e) => onChange({ visible: e.target.checked })} /> 可见
      </label>
      <label>
        所属视图
        <select value={comp.view ?? doc.content.views[0]?.id ?? 'main'} onChange={(e) => onChange({ view: e.target.value })}>
          {doc.content.views.map((v) => (
            <option key={v.id} value={v.id}>{v.name || v.id}</option>
          ))}
        </select>
      </label>
      <div className="inspector-layout">
        {num('X', 'x')}
        {num('Y', 'y')}
        {num('宽', 'w')}
        {num('高', 'h')}
      </div>
      {contract.propsDoc && <p className="muted props-doc">{contract.propsDoc}</p>}
      {contract.propsFields && contract.propsFields.length > 0 && (
        <div className="inspector-props">
          <b>属性设置</b>
          {contract.propsFields.map((field) => {
            const raw = (comp.props ?? {}) as Record<string, Json>
            const value = raw[field.key] ?? field.fallback
            if (field.type === 'boolean') {
              return (
                <label key={field.key} className="inspector-prop">
                  <input
                    type="checkbox"
                    checked={value !== false}
                    onChange={(e) =>
                      onChange({ props: { ...raw, [field.key]: e.target.checked } })
                    }
                  />{' '}
                  {field.label}
                </label>
              )
            }
            if (field.type === 'number') {
              return (
                <label key={field.key} className="inspector-prop">
                  {field.label}
                  <input
                    type="number"
                    value={typeof value === 'number' ? value : ''}
                    onChange={(e) => {
                      const v = Number(e.target.value)
                      if (Number.isFinite(v)) onChange({ props: { ...raw, [field.key]: v } })
                    }}
                  />
                </label>
              )
            }
            return (
              <label key={field.key} className="inspector-prop">
                {field.label}
                <input
                  value={typeof value === 'string' ? value : ''}
                  onChange={(e) => onChange({ props: { ...raw, [field.key]: e.target.value } })}
                />
              </label>
            )
          })}
        </div>
      )}
      {bindingSlots.length > 0 && (
        <div className="inspector-bindings">
          <b>数据映射（字段 → 显示值）</b>
          <p className="muted">选一列后，组件进入视图/换行时自动显示该行的值（$q.列名）</p>
          {bindingSlots.map((slot) => {
            const raw = (comp.bindings ?? {}) as Record<string, Json>
            const cur = typeof raw[slot] === 'string' ? (raw[slot] as string) : ''
            return (
              <label key={slot} className="inspector-prop">
                {slot}
                <input
                  value={cur}
                  list="inspector-column-options"
                  placeholder="（未绑定）"
                  onChange={(e) => onChange({ bindings: { ...raw, [slot]: e.target.value } })}
                />
              </label>
            )
          })}
          <datalist id="inspector-column-options">
            {columnKeys.map((k) => (
              <option key={k} value={`$q.${k}`} />
            ))}
          </datalist>
        </div>
      )}
      <details
        onToggle={(e) => {
          if ((e.target as HTMLDetailsElement).open) setPropsText(JSON.stringify(comp.props ?? {}, null, 2))
        }}
      >
        <summary className="muted">props JSON（高级）</summary>
        <label>
          props JSON
          <textarea rows={4} value={propsText} onChange={(e) => applyProps(e.target.value)} />
          {propsErr && <span className="tone-error">{propsErr}</span>}
        </label>
      </details>
      {(comp.bindings || bindingSlots.length > 0) && (
        <details
          onToggle={(e) => {
            if ((e.target as HTMLDetailsElement).open) setBindText(JSON.stringify(comp.bindings ?? {}, null, 2))
          }}
        >
          <summary className="muted">bindings JSON（高级）</summary>
          <label>
            bindings JSON
            <textarea rows={4} value={bindText} onChange={(e) => applyBindings(e.target.value)} />
            {bindErr && <span className="tone-error">{bindErr}</span>}
          </label>
        </details>
      )}
      <button type="button" className="danger" onClick={onRemove}>
        删除组件
      </button>
      <p className="muted">id：{comp.id}</p>
    </div>
  )
}

function safeContract(type: string) {
  try {
    return getDef(type).contract
  } catch {
    return { type, displayName: type, category: 'ui' as const, events: {}, commands: {} }
  }
}

// ---------------------------------------------------------------------------
// 数据表编辑器（v3：取代题目编辑器）
// ---------------------------------------------------------------------------

/** 单元格显示文本：对象/数组 → JSON，其余 → String */
function cellText(v: Json | undefined): string {
  if (v === undefined || v === null) return ''
  if (typeof v === 'object') return JSON.stringify(v)
  return String(v)
}

/** 单元格解析：'' → null；[/{ 开头按 JSON；true/false → 布尔；数字 → number；其余字符串 */
function parseCell(text: string): { value: Json; error?: string } {
  const t = text.trim()
  if (t === '') return { value: null }
  if (t.startsWith('[') || t.startsWith('{')) {
    const v = parseJsonText(t)
    if (v === null) return { value: text, error: '不是合法 JSON' }
    return { value: v }
  }
  if (t === 'true') return { value: true }
  if (t === 'false') return { value: false }
  if (!Number.isNaN(Number(t))) return { value: Number(t) }
  return { value: text }
}

export function TableEditor({ doc, onChange }: { doc: LevelDoc; onChange: (doc: LevelDoc) => void }) {
  const table = doc.content.table
  const [newCol, setNewCol] = useState('')
  const [colErr, setColErr] = useState('')

  const addColumn = (): void => {
    const key = newCol.trim()
    try {
      onChange(addTableColumn(doc, key))
      setNewCol('')
      setColErr('')
    } catch (err) {
      setColErr(err instanceof Error ? err.message : String(err))
    }
  }

  return (
    <div className="questions-editor table-editor">
      <div className="rules-toolbar">
        <b>题目数据表</b>
        <span className="muted">
          每行一条题目数据；q.&lt;列名&gt; 指向当前行（如 q.data、q.scoring.max）。运行顺序（顺序/乱序、题数、通过线）在 JSON 页配置。
        </span>
        <button type="button" onClick={() => onChange(addTableRow(doc))}>
          + 添加行
        </button>
      </div>

      <div className="table-cols">
        {table.columns.map((c) => (
          <span key={c.key} className="table-col">
            <input
              className="table-col-key"
              defaultValue={c.key}
              title={`列名（表达式 q.${c.key}）`}
              onBlur={(e) => {
                const key = e.currentTarget.value.trim()
                if (key === c.key) return
                try {
                  onChange(renameTableColumn(doc, c.key, key))
                } catch (err) {
                  e.currentTarget.value = c.key
                  setColErr(err instanceof Error ? err.message : String(err))
                }
              }}
            />
            <input
              className="table-col-label"
              defaultValue={c.label ?? ''}
              placeholder="显示名"
              onBlur={(e) => {
                if (e.currentTarget.value !== (c.label ?? '')) onChange(updateTableColumnLabel(doc, c.key, e.currentTarget.value))
              }}
            />
            <button
              type="button"
              className="ginsp-argdel"
              title={`删除列 ${c.key}`}
              onClick={() => onChange(removeTableColumn(doc, c.key))}
            >
              ×
            </button>
          </span>
        ))}
        <span className="table-col">
          <input
            className="table-col-key"
            value={newCol}
            placeholder="新列名…"
            onChange={(e) => setNewCol(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') addColumn()
            }}
          />
          <button type="button" onClick={addColumn}>
            + 添加列
          </button>
        </span>
      </div>
      {colErr && <div className="tone-error">{colErr}</div>}

      {table.rows.length === 0 && <p className="muted">还没有数据行——点「+ 添加行」创建第一题的数据。</p>}
      {table.rows.map((row, i) => (
        <div key={i} className="rule-card">
          <div className="rule-head">
            <b>第 {i + 1} 行</b>
            <button type="button" className="link danger" onClick={() => onChange(removeTableRow(doc, i))}>
              删除行
            </button>
          </div>
          <div className="table-row-cells">
            {table.columns.map((c) => (
              <label key={c.key} className="inspector-prop">
                {c.label || c.key}
                <input
                  value={cellText(row[c.key])}
                  onChange={(e) => {
                    // 受控：删行/插行后不会残留旧行文本（评审 P1-2——非受控 defaultValue 会串值写坏行）
                    const { value, error } = parseCell(e.currentTarget.value)
                    if (error) return // 非法 JSON 不提交，输入框保持作者文本
                    onChange(updateTableCell(doc, i, { [c.key]: value }))
                  }}
                />
              </label>
            ))}
          </div>
        </div>
      ))}
    </div>
  )
}

// ---------------------------------------------------------------------------
// JSON 视图
// ---------------------------------------------------------------------------

function JsonTab({ doc, onApply }: { doc: LevelDoc; onApply: (doc: LevelDoc) => void }) {
  const [text, setText] = useState(() => JSON.stringify(doc, null, 2))
  const [err, setErr] = useState('')

  // doc 外部变化（保存/试运行返回等）时同步文本；应用 JSON 引起的 setDoc
  // 会带上新 doc 再触发本 effect，文本被格式化刷新属预期
  useEffect(() => {
    setText(JSON.stringify(doc, null, 2))
  }, [doc])

  return (
    <div className="json-tab">
      <button
        type="button"
        onClick={() => {
          try {
            const parsed = JSON.parse(text)
            if (parsed.kind !== 'level') {
              setErr('kind 必须是 level')
              return
            }
            // 保留当前关卡 id：应用 JSON 改 id 会让保存落为新记录、URL 与库脱节；
            // 迁移器统一出 v3（评审 P1-1：防止 JSON 页注入 v1 形态致画布崩溃）
            parsed.id = doc.id
            onApply(migrateDocToV3(parsed))
            setErr('')
          } catch (e) {
            setErr(String(e instanceof Error ? e.message : e))
          }
        }}
      >
        应用 JSON 到编辑器
      </button>
      {err && <span className="tone-error" style={{ marginLeft: 12 }}>{err}</span>}
      <textarea rows={24} value={text} onChange={(e) => setText(e.target.value)} />
    </div>
  )
}
