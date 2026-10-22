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
import { undoTargetBlocked, deleteTargetBlocked } from './keyGuard'
import { TableEditor } from './TableGrid'
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ComponentInstance, LevelDoc } from '../engine/level'
import type { Json } from '../engine/expr'
import { parseExpr, ExprError } from '../engine/expr'
import { migrateDocToV3 } from '../engine/migrateDoc'
import { copyForEditing } from './docState'
import {
  addComponent,
  addView,
  blankLevelDoc,
  parseJsonText,
  removeComponent,
  removeView,
  setMeta,
  updateComponent,
} from './docState'

type Tab = 'canvas' | 'graph' | 'script' | 'table' | 'json'

/** 节点图编辑器懒加载：@xyflow/react 体量较大，不进主包 */
const GraphEditor = lazy(() => import('./graph/GraphEditor'))
/** 脚本页与节点图同包域（依赖 script 引擎，体量小；保持同目录一致管理） */
const ScriptTab = lazy(() => import('./graph/ScriptTab'))
/** AI 助手面板（批次1 ask 模式）：全 tab 共享的统一对话右栏，懒加载不进主包 */
const AiPanel = lazy(() => import('./ai/AiPanel').then((m) => ({ default: m.AiPanel })))

/** 脚本页选区上报（行号 1 起，随 AI 提问附带上下文） */
interface ScriptRangeReport {
  startLine: number
  endLine: number
  text: string
}

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
  // AI 助手总开关：单一真源——各 tab 的面板与节点图工作台内的 AI 入坞共用（docs/29）
  const [aiOpen, setAiOpen] = useState(true)
  const [scriptRange, setScriptRange] = useState<ScriptRangeReport | null>(null)
  const [saveErrors, setSaveErrors] = useState<string[]>([])
  const [lintWarnings, setLintWarnings] = useState<string[]>([])
  // 一次性提示：跨重挂载传达（内置另存副本后 hash 切换会重建本组件，评审 P2-2）
  const [savedTip, setSavedTip] = useState(() => {
    const n = sessionStorage.getItem('edit-notice') ?? ''
    if (n) sessionStorage.removeItem('edit-notice')
    return n
  })
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
  // loadedIdRef 语义：同一关卡不重复装载（保护未保存编辑）；换 id（#/edit/A → #/edit/B）强制重装。
  // 迁移失败 → loadError 独立错误分支（docs/40 A4：此前写进 saveErrors 但 !doc 早退分支
  // 永远渲染不到错误条，用户只见无限「编辑器加载中…」）；loadTick 支持失败后重试重跑。
  const loadedIdRef = useRef<string | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [loadTick, setLoadTick] = useState(0)
  useEffect(() => {
    if (record === 'loading' || record === undefined || record === null) return
    if (loadedIdRef.current === id) return
    loadedIdRef.current = id
    if (record === 'new') {
      setDoc(blankLevelDoc())
      setLoadError(null)
      return
    }
    try {
      const migrated = migrateDocToV3((record as LibraryRecord).doc)
      setDoc(migrated)
      setLoadError(null)
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : String(err))
      setDoc(null)
      loadedIdRef.current = null
    }
  }, [record, id, loadTick])

  // ---------------------------------------------------------------------------
  // 撤销/重做栈（批次6c）：所有 update（手动+AI 写入）入栈，cap 50；
  // ref 存栈 + bump 计数驱动渲染（避免 setState updater 的 StrictMode 双调副作用）
  // ---------------------------------------------------------------------------
  const docRef = useRef<LevelDoc | null>(null)
  docRef.current = doc
  const histRef = useRef<{ past: LevelDoc[]; future: LevelDoc[] }>({ past: [], future: [] })
  const [, histBump] = useState(0)
  const HIST_CAP = 50

  /** 编辑器内所有文档修改走这里：入历史栈（撤销/重做，批次6c）、标脏、清「已保存」提示 */
  const update = useCallback(
    (next: LevelDoc) => {
      const cur = docRef.current
      if (cur) {
        const h = histRef.current
        h.past = [...h.past.slice(-(HIST_CAP - 1)), structuredClone(cur)]
        h.future = []
      }
      setSavedTip('')
      setDirty(true)
      setDoc(next)
      histBump((v) => v + 1)
    },
    [histBump],
  )

  const undo = useCallback((): void => {
    const h = histRef.current
    const cur = docRef.current
    if (h.past.length === 0 || !cur) return
    const prev = h.past[h.past.length - 1]
    h.past = h.past.slice(0, -1)
    h.future = [structuredClone(cur), ...h.future.slice(0, HIST_CAP - 1)]
    setSavedTip('')
    setDirty(true)
    setDoc(prev)
    histBump((v) => v + 1)
  }, [histBump])

  const redo = useCallback((): void => {
    const h = histRef.current
    const cur = docRef.current
    if (h.future.length === 0 || !cur) return
    const next = h.future[0]
    h.future = h.future.slice(1)
    h.past = [...h.past.slice(-(HIST_CAP - 1)), structuredClone(cur)]
    setSavedTip('')
    setDirty(true)
    setDoc(next)
    histBump((v) => v + 1)
  }, [histBump])

  // 快捷键（批次6c）：window 级监听——Ctrl/Cmd+Z 撤销、Ctrl/Cmd+Shift+Z（或 Ctrl+Y）重做。
  // 输入框/文本域/下拉内不拦截（浏览器原生文本撤销优先）；弹窗打开期间短路（docs/40 B5：
  // 此前 Ctrl+Z 穿透弹窗，弹窗草稿提交时会覆盖撤销结果）；编辑器卸载即移除。
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (!(e.ctrlKey || e.metaKey)) return
      if (undoTargetBlocked(e.target)) return
      const key = e.key.toLowerCase()
      if (key === 'y') {
        e.preventDefault()
        redo()
      } else if (key === 'z') {
        e.preventDefault()
        if (e.shiftKey) redo()
        else undo()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [undo, redo])

  const savingRef = useRef(false)
  /** 保存：普通关卡覆盖原记录；内置示例不可覆盖（会被种子重写）——自动另存为用户副本并切换过去 */
  const save = useCallback(async (): Promise<{ ok: boolean; savedId: string | null }> => {
    if (!doc || savingRef.current) return { ok: false, savedId: null } // 防重入：异步保存期间快速双击不产生双副本（评审 P2-4）
    savingRef.current = true
    try {
      const existing = await db.resources.get(doc.id)
      const isBuiltIn = existing?.builtIn === 1
      const target = isBuiltIn ? copyForEditing(doc) : doc
      const result = loadLevelDoc(target)
      if (!result.ok) {
        setSaveErrors(result.errors)
        return { ok: false, savedId: null }
      }
      setSaveErrors([])
      setLintWarnings(result.lintWarnings)
      await putResource(result.doc as never)
      setDirty(false)
      dirtyRef.current = false // 显式同步：不依赖「React 调度先于 hashchange 任务」的时序假设（评审 P2-1）
      if (isBuiltIn) {
        sessionStorage.setItem('edit-notice', '内置示例不可覆盖——已另存为你的副本，后续编辑直接保存')
        setDoc(result.doc)
        window.location.hash = `#/edit/${result.doc.id}` // 切到副本继续编辑（App 按 hash 重挂载）
      } else {
        setSavedTip(`已保存（v${result.doc.version}）`)
      }
      return { ok: true, savedId: result.doc.id }
    } finally {
      savingRef.current = false // 保存结束后必须释放，否则本次挂载内保存/试运行永久失效
    }
  }, [doc])

  async function tryRun(): Promise<void> {
    const r = await save()
    if (r.ok && r.savedId) window.location.hash = `#/level/${r.savedId}`
  }

  // 装载失败独立分支（早于加载中判定）：可读错误 + 返回资源库/重试，不再是死胡同
  if (loadError) {
    return (
      <div className="page editor">
        <div className="editor-errors">
          <b>无法打开这个关卡：</b>
          <ul>
            <li>文档迁移失败——{loadError}</li>
          </ul>
        </div>
        <p className="action-row">
          <a href="#/library">← 返回资源库</a>
          <button
            type="button"
            onClick={() => {
              setLoadError(null)
              setLoadTick((t) => t + 1)
            }}
          >
            重试
          </button>
        </p>
      </div>
    )
  }

  if (record === 'loading' || record === undefined || !doc) {
    return (
      <p className="muted page">
        {record === null && id !== 'new' ? (
          <>
            库中没有这个关卡 · <a href="#/library">返回资源库</a>
          </>
        ) : (
          '编辑器加载中…'
        )}
      </p>
    )
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
        <span className="editor-head-group">
          <button
            type="button"
            disabled={histRef.current.past.length === 0}
            title="撤销（Ctrl+Z）"
            onClick={() => undo()}
          >
            ↶
          </button>
          <button
            type="button"
            disabled={histRef.current.future.length === 0}
            title="重做（Ctrl+Shift+Z）"
            onClick={() => redo()}
          >
            ↷
          </button>
        </span>
        <span className="editor-head-group">
          <button type="button" className="primary" onClick={() => save()}>
            💾 保存{dirty ? ' *' : ''}
          </button>
          <button type="button" onClick={tryRun}>
            ▶ 试运行
          </button>
        </span>
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
        <button
          type="button"
          className={`editor-ai-toggle${aiOpen ? ' active' : ''}`}
          title="AI 助手（统一对话，跨视图共享上下文）"
          onClick={() => setAiOpen((v) => !v)}
        >
          🤖 AI
        </button>
      </div>

      <div className="editor-body">
        <ErrorBoundary>
          {tab === 'canvas' && (
            <EditorCanvas
              doc={doc}
              selected={selected}
              onSelect={setSelected}
              onChange={update}
              onRemove={() => {
                update(removeComponent(doc, selected ?? ''))
                setSelected(null)
              }}
            />
          )}

          {tab === 'graph' && (
            <Suspense fallback={<p className="muted">节点图加载中…</p>}>
              <GraphEditor doc={doc} onChange={update} aiOpen={aiOpen} onToggleAi={() => setAiOpen((v) => !v)} />
            </Suspense>
          )}

          {tab === 'script' && (
            <Suspense fallback={<p className="muted">脚本加载中…</p>}>
              <ScriptTab doc={doc} onChange={update} onSelectionReport={setScriptRange} />
            </Suspense>
          )}

          {tab === 'table' && <TableEditor doc={doc} onChange={update} />}

          {tab === 'json' && <JsonTab doc={doc} onApply={update} />}
        </ErrorBoundary>

        {/* graph tab 的 AI 面板由 GraphEditor 在工作台内入坞（随深浅主题换肤，docs/29）；
            其余 tab 在编辑器右栏渲染——同一会话 store，切 tab 对话连续 */}
        {aiOpen && tab !== 'graph' && (
          <Suspense fallback={<aside className="ai-panel ai-panel-loading">AI 面板加载中…</aside>}>
            <AiPanel
              doc={doc}
              selection={{
                tab,
                componentId: tab === 'canvas' ? selected : null,
                scriptRange: tab === 'script' ? scriptRange : null,
              }}
              onApplyDoc={update}
              onClose={() => setAiOpen(false)}
            />
          </Suspense>
        )}
      </div>
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
  onRemove,
}: {
  doc: LevelDoc
  selected: string | null
  onSelect: (id: string | null) => void
  onChange: (doc: LevelDoc) => void
  onRemove: () => void
}) {
  const canvasRef = useRef<HTMLDivElement>(null)
  const dragRef = useRef<{ id: string; grabX: number; grabY: number; rect: DOMRect } | null>(null)
  const resizeRef = useRef<{ id: string; startX: number; startY: number; w: number; h: number } | null>(null)
  // 当前编辑的视图（组件互斥渲染的编辑侧对应物；不随 doc 变化重置）
  const [view, setView] = useState(doc.content.views[0]?.id ?? 'main')
  const currentView = doc.content.views.some((v) => v.id === view) ? view : (doc.content.views[0]?.id ?? 'main')

  // Delete/Backspace 快捷删除选中组件（走 onChange 入撤销栈）。守卫统一走 keyGuard
  // （docs/40 B5/E11）：弹窗打开短路；焦点在输入/下拉/按钮上放行给控件自身——
  // 此前 SELECT 聚焦按 Delete 会误删组件。
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Delete' && e.key !== 'Backspace') return
      if (e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return
      if (deleteTargetBlocked(e.target)) return
      if (!selected || !doc.content.components.some((c) => c.id === selected)) return
      e.preventDefault()
      onChange(removeComponent(doc, selected))
      onSelect(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [selected, doc, onChange, onSelect])

  function onBoxPointerDown(e: React.PointerEvent, comp: ComponentInstance): void {
    e.currentTarget.setPointerCapture(e.pointerId)
    onSelect(comp.id)
    const rect = canvasRef.current!.getBoundingClientRect()
    const layout = comp.layout ?? { x: 0, y: 0, w: 120, h: 40 }
    dragRef.current = { id: comp.id, grabX: e.clientX - rect.left - layout.x, grabY: e.clientY - rect.top - layout.y, rect }
  }

  /** 右下角手柄拖拽调整尺寸（独立捕获路径，与移动互不干扰） */
  function onResizeDown(e: React.PointerEvent, comp: ComponentInstance): void {
    e.stopPropagation()
    e.currentTarget.setPointerCapture(e.pointerId)
    onSelect(comp.id)
    resizeRef.current = { id: comp.id, startX: e.clientX, startY: e.clientY, w: comp.layout?.w ?? 120, h: comp.layout?.h ?? 40 }
  }

  function onResizeMove(e: React.PointerEvent, comp: ComponentInstance): void {
    const rz = resizeRef.current
    if (!rz || rz.id !== comp.id) return
    const w = Math.max(40, Math.round((rz.w + (e.clientX - rz.startX)) / 2) * 2)
    const h = Math.max(28, Math.round((rz.h + (e.clientY - rz.startY)) / 2) * 2)
    const layout = comp.layout ?? { x: 0, y: 0, w: 120, h: 40 }
    if (w !== layout.w || h !== layout.h) onChange(updateComponent(doc, comp.id, { layout: { ...layout, w, h } }))
  }

  function onResizeUp(): void {
    resizeRef.current = null
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

  const selectedComp = doc.content.components.find((c) => c.id === selected) ?? null
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
          <span className="muted views-hint">互斥视图：运行时只渲染当前视图 · 随行刷新的数据展示请在节点图用 set 命令（question.loaded / view.entered）</span>
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
                {/* 预览盒已由 inset:0 定位到布局框内：把 layout.x/y 清零，
                    否则组件视图的绝对定位（boxStyle）会按画布坐标二次偏移并溢出裁切 */}
                <ComponentView
                  spec={{ ...comp, visible: true, layout: comp.layout ? { ...comp.layout, x: 0, y: 0 } : undefined }}
                  store={previewStore}
                  emit={noopEmit}
                />
              </div>
              <span className="box-label">{comp.name ?? comp.id}</span>
              <span
                className="box-resize"
                title="拖拽调整大小"
                onPointerDown={(e) => onResizeDown(e, comp)}
                onPointerMove={(e) => onResizeMove(e, comp)}
                onPointerUp={onResizeUp}
                onPointerCancel={onResizeUp}
              />
            </div>
          ))}
          {viewComps.length === 0 && (
            <p className="muted" style={{ padding: 24 }}>
              当前视图没有组件——从左侧组件面板添加
            </p>
          )}
        </div>
      </div>

      {selectedComp && (
        <Inspector
          doc={doc}
          comp={selectedComp}
          onChange={(patch) => onChange(updateComponent(doc, selectedComp.id, patch))}
          // 单次删除走外层 onRemove（EditorPage 闭包一次 update）——此前 Inspector 内再
          // 调一次 onChange(removeComponent) 造成同事件两次入撤销栈（docs/40 B3 空撤销步）
          onRemove={onRemove}
        />
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// 属性检查器（布局 / 视图归属 / props；随行数据展示统一走节点图 set 命令，docs/26）
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

  // 切换选中组件时同步文本
  useEffect(() => {
    setPropsText(JSON.stringify(comp.props ?? {}, null, 2))
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
            if (field.type === 'string' && field.options?.length) {
              // 有可选值清单的字符串字段渲染下拉（如合成器音色），避免手拼错值静默回退
              const known = field.options.includes(String(value))
              return (
                <label key={field.key} className="inspector-prop">
                  {field.label}
                  <select value={String(value ?? '')} onChange={(e) => onChange({ props: { ...raw, [field.key]: e.target.value } })}>
                    {!known && <option value={String(value ?? '')}>{String(value ?? '') || '（未设置）'}</option>}
                    {field.options.map((o) => (
                      <option key={o} value={o}>{o}</option>
                    ))}
                  </select>
                </label>
              )
            }
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
      <button type="button" className="danger" onClick={onRemove} title="删除组件（快捷键 Delete / Backspace）">
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
