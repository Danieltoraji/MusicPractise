/**
 * v4 编辑器容器（docs/53 §13.1–§13.2；W5.1）：路由入口 `#/edit/:id` 在过渡期由
 * `EditorPage`（Lead 单写路由分派）按记录 `schemaVersion === 4` 分派到这里。
 *
 * 职责（与 v3 `EditorPage` 对齐，语义不漂移）：
 * - 装载：db.resources.get → `loadLevelDocV4`（schema + 结构/引用 + lint）；结构坏但身份合法的
 *   文档走宽松通道打开（“先放行后清洗”，错误作为 lintWarnings 展示，保存时仍会被拦截）；
 * - 保存：`loadLevelDocV4` 预检 → `bumpVersionV4` → `putResource`；内置示例不可覆盖 →
 *   另存副本（新 id +「（副本）」+ 版本归零 → bump），并迁移按 docId 键控的草稿与撤销栈身份；
 *   保存 await 窗口内的新编辑保留脏标（A1 语义），绝不静默丢弃；
 * - 撤销/重做：`history.ts` 的 HISTORY_CAP 语义（cap 50、cleanDocRef 判脏、同 tag 合并）；
 * - revision 同步计数器（AI 冲突检测）、dirty、tag、外部修改横幅（A8）、dirty-guard。
 *
 * 缺口（登记给 W7/W8，见 W5 交付报告）：
 * - AI run 归属迁移（stopAgent / AI 会话·检查点·runLog 重命名）在 v4 AI 面板（W8）接入时补齐；
 * - debugRun 归属（W7 · PreviewTab）由 W7 实现，本文件只保留槽位注入。
 */
import { useLiveQuery } from 'dexie-react-hooks'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { LevelDocV4 } from '../../engine/v4/model'
import { normalizeLevelDocV4 } from '../../engine/v4/model'
import { validateLevelDocV4 } from '../../engine/v4/validate'
import { db, putResource } from '../../library/db'
import type { LibraryRecord } from '../../library/db'
import { loadLevelDocV4 } from '../../library/validate'
import { renameDrafts } from '../draftStore'
import { HISTORY_CAP } from '../history'
import { undoTargetBlocked } from '../keyGuard'
import './v4-editor.css'
import {
  bumpVersionV4,
  blankLevelDocV4,
  copyForEditingV4,
  remapHistoryForCopyV4,
  type EditorHistoryV4,
} from './docStateV4'
import { V4EditorShell, type V4EditorSlots, type V4EditorTab } from './V4EditorShell'

export interface EditorPageV4Props {
  /** 路由 id；`new` = 从零建 v4 关 */
  id: string
  /**
   * W6/W7 可插槽区域（流程 / 行为 / 舞台 / 预览 / AI 面板）。
   * 过渡期集成由路由/Lead 传入；不传时各 Tab 显示占位说明。
   */
  slots?: V4EditorSlots
}

type Opened = { ok: true; doc: LevelDocV4; warnings: string[] } | { ok: false; error: string }

/**
 * 打开库内文档：
 * - 严格通道 = `loadLevelDocV4`（与保存/导入同一管线）；
 * - 宽松通道 = 身份（schemaversion/kind/id）合法但结构错误时 normalize + 结构校验，
 *   错误作为「无法保存」前缀的 lintWarnings 展示（编辑器仍可打开修 JSON）；
 * - 身份不合法（如 v3 文档被误分派到此）→ 明确错误，不猜。
 */
function openRecordDoc(raw: unknown): Opened {
  const strict = loadLevelDocV4(raw)
  if (strict.ok) return { ok: true, doc: strict.doc, warnings: strict.lintWarnings }
  const source = raw as { schemaVersion?: unknown; kind?: unknown; id?: unknown } | null
  if (source === null || typeof source !== 'object' || source.schemaVersion !== 4 || source.kind !== 'level') {
    return { ok: false, error: strict.errors.join('\n') }
  }
  try {
    const normalized = normalizeLevelDocV4(raw)
    if (normalized.id !== source.id) return { ok: false, error: strict.errors.join('\n') }
    const check = validateLevelDocV4(normalized)
    const warnings = [
      ...strict.errors.map((message) => `[无法保存] ${message}`),
      ...check.errors.map((issue) => `[无法保存] ${issue.message}`),
      ...check.warnings.map((issue) => issue.message),
    ]
    return { ok: true, doc: normalized, warnings }
  } catch (err) {
    return { ok: false, error: `${strict.errors.join('\n')}\n${err instanceof Error ? err.message : String(err)}` }
  }
}

/** 保存结果：ok 时携带实际落库 id（内置示例另存副本后会换 id） */
export interface V4SaveResult {
  ok: boolean
  savedId: string | null
}

export function EditorPageV4({ id, slots }: EditorPageV4Props): React.ReactElement {
  // activeId 语义同 v3（docs/42 §4.6 C5）：内置副本另存 / #/edit/new 首存后前移到真实 id
  const [activeId, setActiveId] = useState(id)
  useEffect(() => {
    setActiveId(id)
  }, [id])

  const record = useLiveQuery(async () => {
    if (activeId === 'new') return 'new'
    return (await db.resources.get(activeId)) ?? null
  }, [activeId], 'loading')

  const [doc, setDoc] = useState<LevelDocV4 | null>(null)
  const [tab, setTab] = useState<V4EditorTab>('content')
  const [saveErrors, setSaveErrors] = useState<string[]>([])
  const [lintWarnings, setLintWarnings] = useState<string[]>([])
  const [savedTip, setSavedTip] = useState('')
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [loadTick, setLoadTick] = useState(0)

  // 文档修订号（F1 冲突检测接口）：每次 update/undo/redo/保存回写/外部装载同步自增
  const revisionRef = useRef(0)
  const bumpRevision = useCallback((): void => {
    revisionRef.current += 1
  }, [])

  // dirty-guard（刷新/关闭 + 站内 hash 跳转）；回声抑制由 prevHashRef 比对完成
  const dirtyRef = useRef(dirty)
  dirtyRef.current = dirty
  const prevHashRef = useRef(window.location.hash)
  useEffect(() => {
    const onBeforeUnload = (e: BeforeUnloadEvent): void => {
      if (!dirtyRef.current) return
      e.preventDefault()
      e.returnValue = ''
    }
    const onHashChange = (e: HashChangeEvent): void => {
      const current = window.location.hash
      if (current === prevHashRef.current) return // 回滚触发的回声
      if (!dirtyRef.current) {
        prevHashRef.current = current
        return
      }
      if (window.confirm('有未保存的更改，离开将丢失。确定离开吗？')) {
        prevHashRef.current = current
        return
      }
      e.preventDefault()
      e.stopPropagation()
      window.location.hash = prevHashRef.current
    }
    window.addEventListener('beforeunload', onBeforeUnload)
    window.addEventListener('hashchange', onHashChange, true)
    return () => {
      window.removeEventListener('beforeunload', onBeforeUnload)
      window.removeEventListener('hashchange', onHashChange, true)
    }
  }, [])

  // 装载：同一 activeId 不重复装载（保护未保存编辑）；换 id 强制重装
  const loadedIdRef = useRef<string | null>(null)
  const baselineVersionRef = useRef<string | null>(null)
  useEffect(() => {
    if (record === 'loading' || record === undefined || record === null) return
    if (record === 'new') {
      if (activeId !== 'new') return
    } else if ((record as LibraryRecord).id !== activeId) {
      return
    }
    if (loadedIdRef.current === activeId) return
    loadedIdRef.current = activeId
    if (record === 'new') {
      setDoc(blankLevelDocV4())
      setLoadError(null)
      baselineVersionRef.current = null
      setDirty(false)
      setLintWarnings([])
      bumpRevision()
      return
    }
    const opened = openRecordDoc((record as LibraryRecord).doc)
    if (!opened.ok) {
      setLoadError(opened.error)
      setDoc(null)
      loadedIdRef.current = null
      return
    }
    setDoc(opened.doc)
    setLoadError(null)
    setLintWarnings(opened.warnings)
    baselineVersionRef.current = String((record as LibraryRecord).version ?? '')
    setDirty(false)
    bumpRevision()
  }, [record, activeId, loadTick, bumpRevision])

  // -------------------------------------------------------------------------
  // 撤销/重做栈（cap 50；ref 存栈 + bump 计数驱动渲染）
  // -------------------------------------------------------------------------
  const docRef = useRef<LevelDocV4 | null>(null)
  docRef.current = doc
  const histRef = useRef<EditorHistoryV4>({ past: [], future: [] })
  const [, histBump] = useState(0)
  const cleanDocRef = useRef<LevelDocV4 | null>(null)
  const pendingTagRef = useRef<string | null>(null)

  /**
   * 单一更新入口：入撤销栈 + 标脏 + 清保存提示 + revision 自增。
   * - next === cur 引用短路（no-op 不入栈）；
   * - 同 tag 连续 update 合并且不重复压栈（标题/单元格/行元数据/列连续编辑）；
   * - dirty = next !== cleanDocRef（撤销回保存点自动清脏）。
   */
  const update = useCallback(
    (next: LevelDocV4, tag?: string): void => {
      const current = docRef.current
      if (current) {
        if (next === current) return
        const history = histRef.current
        if (!(tag !== undefined && pendingTagRef.current === tag)) {
          history.past = [...history.past.slice(-(HISTORY_CAP - 1)), current]
        }
        pendingTagRef.current = tag ?? null
        history.future = []
      }
      setSavedTip('')
      setDirty(next !== cleanDocRef.current)
      setDoc(next)
      bumpRevision()
      histBump((value) => value + 1)
    },
    [bumpRevision],
  )

  const undo = useCallback((): void => {
    const history = histRef.current
    const current = docRef.current
    if (history.past.length === 0 || !current) return
    const previous = history.past[history.past.length - 1]
    history.past = history.past.slice(0, -1)
    history.future = [current, ...history.future.slice(0, HISTORY_CAP - 1)]
    pendingTagRef.current = null
    setSavedTip('')
    setDirty(previous !== cleanDocRef.current)
    setDoc(previous)
    bumpRevision()
    histBump((value) => value + 1)
  }, [bumpRevision])

  const redo = useCallback((): void => {
    const history = histRef.current
    const current = docRef.current
    if (history.future.length === 0 || !current) return
    const next = history.future[0]
    history.future = history.future.slice(1)
    history.past = [...history.past.slice(-(HISTORY_CAP - 1)), current]
    pendingTagRef.current = null
    setSavedTip('')
    setDirty(next !== cleanDocRef.current)
    setDoc(next)
    bumpRevision()
    histBump((value) => value + 1)
  }, [bumpRevision])

  // 全局快捷键：Ctrl/Cmd+Z 撤销、Ctrl/Cmd+Shift+Z / Ctrl+Y 重做（输入框/弹窗内不拦截）
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

  // -------------------------------------------------------------------------
  // 保存
  // -------------------------------------------------------------------------
  const savingRef = useRef(false)
  const save = useCallback(async (): Promise<V4SaveResult> => {
    if (!doc || savingRef.current) return { ok: false, savedId: null }
    savingRef.current = true
    setSaving(true)
    try {
      const existing = await db.resources.get(doc.id)
      const latest = docRef.current ?? doc
      const isBuiltIn = existing?.builtIn === 1
      const target = isBuiltIn ? copyForEditingV4(latest) : latest
      const result = loadLevelDocV4(target)
      if (!result.ok) {
        setSaveErrors(result.errors)
        return { ok: false, savedId: null }
      }
      setSaveErrors([])
      setLintWarnings(result.lintWarnings)
      const saved = bumpVersionV4(result.doc)
      await putResource(saved as never)
      baselineVersionRef.current = String(saved.version)
      const raced = docRef.current !== latest

      if (isBuiltIn) {
        // 内置示例另存副本 = 文档身份迁移（C5）：草稿按 docId 键控 → 迁移；撤销栈身份 → 重映射
        const oldDocId = doc.id
        renameDrafts(oldDocId, saved.id)
        histRef.current = remapHistoryForCopyV4(histRef.current, saved)
        histBump((value) => value + 1)
        pendingTagRef.current = null
        // await 期间可能又有编辑：以此刻最新 doc 为准（身份换副本，内容保留；标题尊重用户输入）
        const stillRaced = docRef.current !== latest
        const racedDoc = docRef.current ?? latest
        const baseTitle = String(latest.meta.title ?? '')
        const racedTitle = String(racedDoc.meta.title ?? '')
        const rebased: LevelDocV4 = {
          ...racedDoc,
          id: saved.id,
          version: saved.version,
          meta: { ...racedDoc.meta, title: racedTitle === baseTitle ? String(saved.meta.title ?? racedTitle) : racedTitle },
        }
        setDoc(stillRaced ? rebased : saved)
        cleanDocRef.current = saved
        loadedIdRef.current = saved.id
        baselineVersionRef.current = String(saved.version)
        setActiveId(saved.id)
        setDirty(stillRaced)
        dirtyRef.current = stillRaced
        setSavedTip(
          stillRaced
            ? '已另存为你的副本；保存期间又有新的修改，已保留，请再次保存'
            : '内置示例不可覆盖——已另存为你的副本，后续编辑直接保存',
        )
        window.history.replaceState(null, '', `#/edit/${saved.id}`)
        prevHashRef.current = window.location.hash
        bumpRevision()
        return { ok: true, savedId: saved.id }
      }

      if (!raced) {
        setDoc(saved)
        cleanDocRef.current = saved
        pendingTagRef.current = null
        setDirty(false)
        dirtyRef.current = false
        setSavedTip(`已保存（v${saved.version}）`)
      } else {
        // 保存窗口期又有编辑：写库内容只代表点击时刻，窗口期编辑保留并要求再存一次（A1）
        setDoc({ ...(docRef.current ?? latest), version: saved.version })
        cleanDocRef.current = saved
        pendingTagRef.current = null
        setDirty(true)
        dirtyRef.current = true
        setSavedTip(`已保存（v${saved.version}）——保存期间又有新的修改，已保留，请再次保存`)
      }
      bumpRevision()
      if (loadedIdRef.current !== saved.id) {
        loadedIdRef.current = saved.id
        setActiveId(saved.id)
      }
      if (activeId === 'new') {
        window.history.replaceState(null, '', `#/edit/${saved.id}`)
        prevHashRef.current = window.location.hash
      }
      return { ok: true, savedId: saved.id }
    } catch (err) {
      setSaveErrors([`保存失败：${err instanceof Error ? err.message : String(err)}`])
      return { ok: false, savedId: null }
    } finally {
      savingRef.current = false
      setSaving(false)
    }
  }, [doc, activeId, bumpRevision])

  const tryRun = useCallback(async (): Promise<void> => {
    const result = await save()
    if (result.ok && result.savedId) window.location.hash = `#/level/${result.savedId}`
  }, [save])

  // -------------------------------------------------------------------------
  // 装载失败 / 加载中
  // -------------------------------------------------------------------------
  if (loadError) {
    return (
      <div className="page editor">
        <div className="editor-errors" data-testid="v4-load-error">
          <b>无法打开这个关卡：</b>
          <ul>
            {loadError.split('\n').slice(0, 20).map((line, index) => (
              <li key={index}>{line}</li>
            ))}
          </ul>
        </div>
        <p className="action-row">
          <a href="#/library">← 返回资源库</a>
          <button
            type="button"
            onClick={() => {
              setLoadError(null)
              setLoadTick((tick) => tick + 1)
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
        {record === null && activeId !== 'new' ? (
          <>
            库中没有这个关卡 · <a href="#/library">返回资源库</a>
          </>
        ) : (
          '编辑器加载中…'
        )}
      </p>
    )
  }

  // A8：库内版本与基线不同 = 其他窗口/导入覆盖过此文档
  const liveRecord = record && typeof record === 'object' ? (record as LibraryRecord) : null
  const externalChanged =
    !!liveRecord &&
    doc.id === activeId &&
    liveRecord.id === activeId &&
    loadedIdRef.current === activeId &&
    baselineVersionRef.current !== null &&
    liveRecord.version !== baselineVersionRef.current

  const banner = externalChanged && liveRecord ? (
    <div className="editor-lint" data-testid="v4-external-banner">
      ⚠ 文档已在其他窗口被修改（库内版本 v{liveRecord.version}）。继续编辑并保存将覆盖外部版本。
      <button
        type="button"
        onClick={() => {
          if (!window.confirm('加载库内最新版本？当前未保存的编辑将被覆盖（可通过 Ctrl+Z 撤销）。')) return
          const opened = openRecordDoc(liveRecord.doc)
          if (!opened.ok) {
            setSaveErrors([`外部版本装载失败：${opened.error}`])
            return
          }
          update(opened.doc)
          cleanDocRef.current = opened.doc
          baselineVersionRef.current = String(liveRecord.version)
          setDirty(false)
          dirtyRef.current = false
          setSavedTip('')
          setLintWarnings(opened.warnings)
        }}
      >
        加载外部版本（覆盖当前编辑）
      </button>
    </div>
  ) : undefined

  return (
    <V4EditorShell
      doc={doc}
      onChange={update}
      onSave={save}
      dirty={dirty}
      revision={revisionRef.current}
      lintWarnings={lintWarnings}
      saving={saving}
      saveErrors={saveErrors}
      savedTip={savedTip}
      canUndo={histRef.current.past.length > 0}
      canRedo={histRef.current.future.length > 0}
      onUndo={undo}
      onRedo={redo}
      banner={banner}
      activeTab={tab}
      onTabChange={setTab}
      onTryRun={() => void tryRun()}
      renderFlow={slots?.renderFlow}
      renderBehavior={slots?.renderBehavior}
      renderShell={slots?.renderShell}
      renderPreview={slots?.renderPreview}
      renderAiPanel={slots?.renderAiPanel}
    />
  )
}
