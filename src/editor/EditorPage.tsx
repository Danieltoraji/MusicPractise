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
import { bumpVersion, copyForEditing } from './docState'
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
import { findDuplicateIdErrors } from '../library/validate'
import { DRAFT_SLOTS, clearDraft, loadDraft, saveDraft } from './draftStore'

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
    // App 层已有 seeded 门控（App.tsx 渲染前等待 ensureSeeded 完成），
    // 此处不再需要 150ms 重试补丁（docs/40 A9）
    return (await db.resources.get(id)) ?? null
  }, [id], 'loading')
  const [doc, setDoc] = useState<LevelDoc | null>(null)
  const [tab, setTab] = useState<Tab>('canvas')
  const [selected, setSelected] = useState<string | null>(null)
  // AI 助手总开关：单一真源——各 tab 的面板与节点图工作台内的 AI 入坞共用（docs/29）
  const [aiOpen, setAiOpen] = useState(true)
  const [scriptRange, setScriptRange] = useState<ScriptRangeReport | null>(null)
  const [saveErrors, setSaveErrors] = useState<string[]>([])
  const [lintWarnings, setLintWarnings] = useState<string[]>([])
  // 一次性提示（C5 后内置副本原地换 id，同挂载内 setSavedTip 直接展示，无需跨重挂通道）
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
  // loadedIdRef 语义：同一关卡不重复装载（保护未保存编辑）；换 id（#/edit/A → #/edit/B）强制重装。
  // 迁移失败 → loadError 独立错误分支（docs/40 A4：此前写进 saveErrors 但 !doc 早退分支
  // 永远渲染不到错误条，用户只见无限「编辑器加载中…」）；loadTick 支持失败后重试重跑。
  const loadedIdRef = useRef<string | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [loadTick, setLoadTick] = useState(0)
  // A8 外部修改检测：装载时的版本号基线；保存后随 bump 前移（引用比对不可行——Dexie 回读恒新对象）
  const baselineVersionRef = useRef<string | null>(null)
  useEffect(() => {
    if (record === 'loading' || record === undefined || record === null) return
    if (loadedIdRef.current === id) return
    loadedIdRef.current = id
    if (record === 'new') {
      setDoc(blankLevelDoc())
      setLoadError(null)
      baselineVersionRef.current = null
      return
    }
    try {
      const migrated = migrateDocToV3((record as LibraryRecord).doc)
      setDoc(migrated)
      setLoadError(null)
      baselineVersionRef.current = String((record as LibraryRecord).version ?? '')
      // 装载宽松告警（D5）：重复 id 不拦截（「先放行后清洗」铁律），提示待保存时修正——
      // 保存路径走 loadLevelDoc 严格拦截
      setLintWarnings(findDuplicateIdErrors(migrated))
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
  // 保存落库的 doc 引用（「干净基线」）：undo/redo/update 回到该引用即视为未修改（撤销回保存点不再要求再保存）
  const cleanDocRef = useRef<LevelDoc | null>(null)
  // 连续性 tag（docs/40 B1）：与栈顶入栈时携带的 tag 相同的连续 update 合并不压栈；
  // 无 tag 的 update、undo/redo 都会打断合并（一次用户操作 = 一条撤销步）
  const pendingTagRef = useRef<string | null>(null)

  /**
   * 编辑器内所有文档修改走这里：入历史栈（撤销/重做）、标脏、清「已保存」提示。
   * docs/40 R3 纪律：
   * - 历史条目存 doc 引用而非 structuredClone——docState 全部变换恒返回新对象、
   *   全仓「禁原地 mutation」纪律保证已提交 doc 不再被改（每次入栈省一次整文档深拷贝）；
   * - 同 tag 连续 update（标题逐键/表格单元格逐键）合并且不重复压栈；
   * - next === cur 引用相等短路（无 no-op 入栈）；
   * - dirty 判定 = next !== cleanDocRef（撤销回保存点自动清脏）。
   */
  const update = useCallback(
    (next: LevelDoc, tag?: string) => {
      const cur = docRef.current
      if (cur) {
        if (next === cur) return // no-op 短路
        const h = histRef.current
        if (!(tag !== undefined && pendingTagRef.current === tag)) {
          h.past = [...h.past.slice(-(HIST_CAP - 1)), cur]
        }
        pendingTagRef.current = tag ?? null
        h.future = []
      }
      setSavedTip('')
      setDirty(next !== cleanDocRef.current)
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
    h.future = [cur, ...h.future.slice(0, HIST_CAP - 1)]
    pendingTagRef.current = null
    setSavedTip('')
    setDirty(prev !== cleanDocRef.current)
    setDoc(prev)
    histBump((v) => v + 1)
  }, [histBump])

  const redo = useCallback((): void => {
    const h = histRef.current
    const cur = docRef.current
    if (h.future.length === 0 || !cur) return
    const next = h.future[0]
    h.future = h.future.slice(1)
    h.past = [...h.past.slice(-(HIST_CAP - 1)), cur]
    pendingTagRef.current = null
    setSavedTip('')
    setDirty(next !== cleanDocRef.current)
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
  const [saving, setSaving] = useState(false)
  /**
   * 保存（docs/40 A1/A2/A3/A6/A7 收口）：
   * - 以「await 窗口内的最新编辑」为保存对象（docRef.current），而非点击瞬间的闭包快照；
   * - put 完成后仅当期间没有新编辑才清脏并回写规范化结果（bump 后版本 + 迁移器规范化）；
   *   期间又有编辑则保留脏标并提示再次保存（绝不静默丢弃）；
   * - 版本自动升修订号（A3 裁决）：与导入/云盘「同 id 同版本跳过」规则自洽；
   * - 失败 catch → 可读错误条，脏标保留、按钮复位可重试（A2）；
   * - #/edit/new 首存成功后 replaceState 原地切真实 id（A7，不触发重挂）；
   * - 内置示例不可覆盖：另存副本并切换（C6：notice 按副本 id 键控）。
   */
  const save = useCallback(async (): Promise<{ ok: boolean; savedId: string | null }> => {
    if (!doc || savingRef.current) return { ok: false, savedId: null } // 防重入：异步保存期间快速双击不产生双副本（评审 P2-4）
    savingRef.current = true
    setSaving(true)
    try {
      const existing = await db.resources.get(doc.id)
      const latest = docRef.current ?? doc // await 窗口内的最新编辑（A1）
      const isBuiltIn = existing?.builtIn === 1
      const target = isBuiltIn ? copyForEditing(latest) : latest
      const result = loadLevelDoc(target)
      if (!result.ok) {
        setSaveErrors(result.errors)
        return { ok: false, savedId: null }
      }
      setSaveErrors([])
      setLintWarnings(result.lintWarnings)
      const saved = bumpVersion(result.doc)
      await putResource(saved as never)
      baselineVersionRef.current = String(saved.version)
      if (isBuiltIn) {
        // C5（docs/40）：原地换 id 而非 hash 重挂——重挂会清空撤销栈/面板/草稿。
        // replaceState 不触发 hashchange，props.id 仍指内置记录（其 record 不会被本保存触碰，
        // useLiveQuery 无扰动）；刷新后 App 按新 hash 正常装载副本。
        setDoc(saved)
        cleanDocRef.current = saved
        pendingTagRef.current = null
        loadedIdRef.current = id // 防装载 effect 因 record 引用变化重复装载
        baselineVersionRef.current = String(saved.version)
        setDirty(false)
        dirtyRef.current = false
        setSavedTip('内置示例不可覆盖——已另存为你的副本，后续编辑直接保存')
        window.history.replaceState(null, '', `#/edit/${saved.id}`)
        prevHashRef.current = window.location.hash
        return { ok: true, savedId: saved.id }
      }
      if (docRef.current === latest) {
        setDoc(saved) // A6：内存与库内一致（规范化 + 新版本），消除列类型等漂移
        cleanDocRef.current = saved // R3：干净基线前移——undo 回到这里自动清脏
        pendingTagRef.current = null // 保存是操作分界：保存后的连续输入不与保存前的编辑合并（B1）
        setDirty(false)
        dirtyRef.current = false // 显式同步：不依赖「React 调度先于 hashchange 任务」的时序假设（评审 P2-1）
        if (id === 'new') {
          window.history.replaceState(null, '', `#/edit/${saved.id}`) // A7：不触发 hashchange/重挂
          prevHashRef.current = window.location.hash // dirty-guard 回滚基线同步前移
        }
        setSavedTip(`已保存（v${saved.version}）`)
      } else {
        setSavedTip(`已保存（v${saved.version}）——保存期间又有新的修改，请再次保存`)
      }
      return { ok: true, savedId: saved.id }
    } catch (err) {
      setSaveErrors([`保存失败：${err instanceof Error ? err.message : String(err)}`])
      return { ok: false, savedId: null }
    } finally {
      savingRef.current = false // 保存结束后必须释放，否则本次挂载内保存/试运行永久失效
      setSaving(false)
    }
  }, [doc, id])

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

  // A8：库内记录版本与基线不同 = 其他窗口/导入覆盖过此文档（loadedIdRef 拦截重装后用户不可见）
  const externalChanged =
    !!(record && typeof record === 'object' && doc && loadedIdRef.current === id && baselineVersionRef.current !== null) &&
    (record as LibraryRecord).version !== baselineVersionRef.current

  return (
    <div className="page editor">
      <div className="editor-head">
        <a href="#/library">← 资源库</a>
        <input
          className="editor-title"
          value={String(doc.meta.title ?? '')}
          onChange={(e) => update(setMeta(doc, { title: e.target.value }), 'title')} // tag：一次连续输入合并为一条撤销步（docs/40 B1）
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
          <button type="button" className="primary" onClick={() => void save()} disabled={saving}>
            {saving ? '保存中…' : `💾 保存${dirty ? ' *' : ''}`}
          </button>
          <button type="button" onClick={tryRun}>
            ▶ 试运行
          </button>
        </span>
      </div>
      {externalChanged && (
        <div className="editor-lint">
          ⚠ 文档已在其他窗口被修改（库内版本 v{String((record as LibraryRecord).version)}）。继续编辑并保存将覆盖外部版本。
          <button
            type="button"
            onClick={() => {
              const rec = record as LibraryRecord
              try {
                const migrated = migrateDocToV3(rec.doc)
                setDoc(migrated)
                baselineVersionRef.current = String(rec.version)
                setDirty(false)
                dirtyRef.current = false
                setSavedTip('')
                setLintWarnings(findDuplicateIdErrors(migrated))
              } catch (err) {
                setSaveErrors([`外部版本装载失败：${err instanceof Error ? err.message : String(err)}`])
              }
            }}
          >
            加载外部版本（覆盖当前编辑）
          </button>
        </div>
      )}
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
            其余 tab 在编辑器右栏渲染——同一会话 store，切 tab 对话连续。
            B6（docs/40）：AI 写入携带 tag='ai'——一次 run 的连续写工具在撤销栈中合并，
            一次 Ctrl+Z 回退整个 AI 任务；用户手动编辑（无 tag）自然打断分段 */}
        {aiOpen && tab !== 'graph' && (
          <Suspense fallback={<aside className="ai-panel ai-panel-loading">AI 面板加载中…</aside>}>
            <AiPanel
              doc={doc}
              selection={{
                tab,
                componentId: tab === 'canvas' ? selected : null,
                scriptRange: tab === 'script' ? scriptRange : null,
              }}
              onApplyDoc={(next) => update(next, 'ai')}
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
  // 拖拽/缩放中间帧走 transient 状态（docs/40 B2，照 GraphEditor dragPos 模式）：
  // pointermove 只更新本态（不写 doc、不入撤销栈），落点一次性 commit——
  // 此前每帧 updateComponent 整文档深拷贝 ×2 + 全组件重渲染 + 撤销栈逐帧膨胀。
  // ref 镜像保证 pointerup 与最后一次 move 同帧到达时也 commit 到最新位置
  //（渲染闭包快照在同帧同步序列里会滞后一帧）。
  const [transient, setTransient] = useState<{ id: string; layout: { x: number; y: number; w: number; h: number } } | null>(null)
  const transientRef = useRef<{ id: string; layout: { x: number; y: number; w: number; h: number } } | null>(null)
  const setTransientBoth = useCallback((v: { id: string; layout: { x: number; y: number; w: number; h: number } } | null) => {
    transientRef.current = v
    setTransient(v)
  }, [])
  // 当前编辑的视图（组件互斥渲染的编辑侧对应物）。草稿跨 Tab 存活（docs/40 C1：
  // 此前切到 JSON 再切回，视图退回首视图）；视图被删除时回落首视图
  const [view, setView] = useState(() => loadDraft<string>(doc.id, DRAFT_SLOTS.canvasView) ?? doc.content.views[0]?.id ?? 'main')
  useEffect(() => {
    saveDraft(doc.id, DRAFT_SLOTS.canvasView, view)
  }, [doc.id, view])
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
    // 合成事件/非活跃 pointerId 下 setPointerCapture 抛 InvalidPointerId（GraphEditor startSplitDrag 同款坑）：
    // 捕获失败不阻断选中与拖拽状态记录，window 无兜底监听时仅影响「指针移出盒子后的跟手」
    try {
      e.currentTarget.setPointerCapture(e.pointerId)
    } catch {
      // ignore
    }
    onSelect(comp.id)
    const rect = canvasRef.current!.getBoundingClientRect()
    const layout = comp.layout ?? { x: 0, y: 0, w: 120, h: 40 }
    dragRef.current = { id: comp.id, grabX: e.clientX - rect.left - layout.x, grabY: e.clientY - rect.top - layout.y, rect }
  }

  /** 右下角手柄拖拽调整尺寸（独立捕获路径，与移动互不干扰） */
  function onResizeDown(e: React.PointerEvent, comp: ComponentInstance): void {
    e.stopPropagation()
    try {
      e.currentTarget.setPointerCapture(e.pointerId)
    } catch {
      // ignore
    }
    onSelect(comp.id)
    resizeRef.current = { id: comp.id, startX: e.clientX, startY: e.clientY, w: comp.layout?.w ?? 120, h: comp.layout?.h ?? 40 }
  }

  function onResizeMove(e: React.PointerEvent, comp: ComponentInstance): void {
    const rz = resizeRef.current
    if (!rz || rz.id !== comp.id) return
    const w = Math.max(40, Math.round((rz.w + (e.clientX - rz.startX)) / 2) * 2)
    const h = Math.max(28, Math.round((rz.h + (e.clientY - rz.startY)) / 2) * 2)
    const layout = comp.layout ?? { x: 0, y: 0, w: 120, h: 40 }
    if (w !== layout.w || h !== layout.h) setTransientBoth({ id: comp.id, layout: { ...layout, w, h } })
  }

  /** 拖拽/缩放落点：transient 有值才 commit 一次（pointerup/pointercancel 共用）。
   *  从 ref 读最新值（不用 setState updater——updater 必须纯函数，副作用在并发下会双调）。 */
  function commitTransient(): void {
    const cur = transientRef.current
    if (cur) onChange(updateComponent(doc, cur.id, { layout: cur.layout }))
    setTransientBoth(null)
    resizeRef.current = null
    dragRef.current = null
  }

  function onResizeUp(): void {
    commitTransient()
  }

  function onBoxPointerMove(e: React.PointerEvent, comp: ComponentInstance): void {
    const drag = dragRef.current
    if (!drag || drag.id !== comp.id) return
    const rect = drag.rect
    const snap = (v: number) => Math.round(v / 10) * 10
    const base = transient?.id === comp.id ? transient.layout : (comp.layout ?? { x: 0, y: 0, w: 120, h: 40 })
    const boxW = base.w
    const boxH = base.h
    // 双向 clamp：画布内自由拖动，不出界
    const x = Math.min(rect.width - boxW, Math.max(0, snap(e.clientX - rect.left - drag.grabX)))
    const y = Math.min(rect.height - boxH, Math.max(0, snap(e.clientY - rect.top - drag.grabY)))
    if (x !== base.x || y !== base.y) setTransientBoth({ id: comp.id, layout: { ...base, x, y } })
  }

  function onBoxPointerUp(): void {
    commitTransient()
  }

  const palette = allContracts()

  // 真组件预览：专用 store（组件初始态驱动）。按「id:type:props」签名 memo（docs/40 B2）：
  // 预览初始态只与组件定义相关——标题/表格/逻辑等无关编辑不再整 store 重建
  //（拖拽期间 doc 不写、签名不变，本就零重建）。compsRef 绕开 memo 对数组引用的依赖。
  const compsRef = useRef(doc.content.components)
  compsRef.current = doc.content.components
  const previewCompsSig = useMemo(
    () => doc.content.components.map((c) => `${c.id}:${c.type}:${JSON.stringify(c.props ?? {})}`).join(','),
    [doc.content.components],
  )
  const previewStore = useMemo(() => {
    const s = new ComponentStore()
    s.init(compsRef.current.map((c) => ({ ...c, visible: true })))
    return s
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 签名不变时复用 store（组件清单从 ref 取最新）
  }, [previewCompsSig])

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
          {viewComps.map((comp) => {
            const tl = transient?.id === comp.id ? transient.layout : null
            const layout = tl ?? comp.layout
            return (
              <div
                key={comp.id}
                className={`editor-box ${selected === comp.id ? 'is-selected' : ''} ${comp.visible === false ? 'is-ghost' : ''}`}
                style={layout ? { left: layout.x, top: layout.y, width: layout.w, height: layout.h } : undefined}
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
                    spec={{ ...comp, visible: true, layout: layout ? { ...layout, x: 0, y: 0 } : undefined }}
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
            )
          })}
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

  // 同步信号 = [comp.id, comp.props 引用]（docs/40 D7）：仅按 id 曾让 undo/AI/结构化
  // 控件改动后 textarea 停留旧 JSON，继续编辑会整体覆盖新值。正在报错（编辑中草稿）不覆盖。
  useEffect(() => {
    if (!propsErr) setPropsText(JSON.stringify(comp.props ?? {}, null, 2))
    // eslint-disable-next-line react-hooks/exhaustive-deps -- propsErr 变化本身不应触发覆盖
  }, [comp.id, comp.props])

  const applyProps = (text: string): void => {
    setPropsText(text)
    const v = parseJsonText(text)
    if (v === null && text.trim() !== '') {
      // 裁决（docs/40 D7）：props 不允许 null——必须是 JSON 对象；报错文案明示
      setPropsErr('props 必须是 JSON 对象（写成 {} 清空全部属性；null 不是对象）')
    } else {
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
  // 草稿跨 Tab 存活（docs/40 C1）：未应用的 JSON 文本经 draftStore 保留——
  // 此前切走 Tab 卸载即丢（「回到原样」承诺冲突）；应用成功后清除草稿
  const [text, setText] = useState(() => loadDraft<string>(doc.id, DRAFT_SLOTS.jsonText) ?? JSON.stringify(doc, null, 2))
  const [err, setErr] = useState('')

  // 草稿持久化（卸载/切 Tab 不丢）；经 effect 同步，避免渲染期副作用
  useEffect(() => {
    saveDraft(doc.id, DRAFT_SLOTS.jsonText, text)
  }, [doc.id, text])

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
            // 应用前走完整 loadLevelDoc 预检（docs/40 D5/A5：schema + 重复 id 拦截，
            // 与保存/导入/AI 写入同一管线——此前直贴 migrate 会放进毒结构到画布才崩）
            parsed.id = doc.id
            const result = loadLevelDoc(parsed)
            if (!result.ok) {
              setErr(result.errors.slice(0, 8).join('\n'))
              return
            }
            onApply(result.doc)
            clearDraft(doc.id, DRAFT_SLOTS.jsonText) // 已落地：下次挂载从 doc 重新生成
            setErr('')
          } catch (e) {
            setErr(String(e instanceof Error ? e.message : e))
          }
        }}
      >
        应用 JSON 到编辑器
      </button>
      {err && <pre className="tone-error" style={{ marginLeft: 12, whiteSpace: 'pre-wrap' }}>{err}</pre>}
      <textarea rows={24} value={text} onChange={(e) => setText(e.target.value)} />
    </div>
  )
}
