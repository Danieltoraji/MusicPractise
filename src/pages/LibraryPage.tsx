/**
 * 资源库：系列 = 文件夹（可展开：系列 ▸ 专题 ▸ 关卡），未被引用的资源归入「未整理」区。
 * 文件管理器操作（docs/39 H1）：新建系列/专题、重命名、移动/复制、删除（容器删除不级联，子级回落未整理）。
 * 关卡可直接编辑（内置示例保存时自动另存为副本）；支持标题搜索、导入导出。
 * 内置（builtIn）文档只读：不可改名/删除/移动、不可作为组织目标（种子每次启动会重放内置记录）。
 */
import { useLiveQuery } from 'dexie-react-hooks'
import { Fragment, useRef, useState, useSyncExternalStore } from 'react'
import type { LibraryRecord } from '../library/db'
import { db, deleteResource, putResource } from '../library/db'
import { downloadBlob, exportResource, importFromFiles, type ImportReport } from '../library/io'
import { buildLibraryTree, childIds, filterTree, type LibraryTreeRow } from '../library/browse'
import {
  appendRefId,
  blankSeriesDoc,
  blankTopicDoc,
  copyLevelDoc,
  copySeriesTree,
  moveLevelIntoTopic,
  moveTopicIntoSeries,
  renameDoc,
  type ContainerDoc,
  type LevelLike,
  type SeriesDoc,
  type TopicDoc,
} from '../library/manage'
import { blankLevelDoc } from '../editor/docState'
import { getAccountSnapshot, subscribeAccount } from '../account/store'
import { uploadLibraryFolder, uploadLibraryLevel } from '../cloud/api'

const KIND_ICON: Record<string, string> = { series: '📚', topic: '📂', level: '🎯', instrument: '🎹' }
const BUILTIN_HINT = '内置示例不可改动'

export function LibraryPage() {
  const resources = useLiveQuery(() => db.resources.orderBy('importedAt').toArray(), [], undefined)
  const [report, setReport] = useState<ImportReport | null>(null)
  const [error, setError] = useState('')
  const [importing, setImporting] = useState(false)
  const [query, setQuery] = useState('')
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const fileInput = useRef<HTMLInputElement>(null)
  // 云盘上传（批次 B2）：登录态显示行级入口；结果内联反馈
  const account = useSyncExternalStore(subscribeAccount, getAccountSnapshot)
  const cloudReady = account.phase === 'available' && account.user !== null
  const [cloudMsg, setCloudMsg] = useState<{ ok: boolean; text: string } | null>(null)
  const [cloudUploadingId, setCloudUploadingId] = useState<string | null>(null)
  // 移动/复制选目标弹窗（docs/39 H1）
  const [moveDialog, setMoveDialog] = useState<{ mode: 'move' | 'copy'; rec: LibraryRecord } | null>(null)

  async function handleCloudUpload(rec: LibraryRecord): Promise<void> {
    setCloudMsg(null)
    setCloudUploadingId(rec.id)
    try {
      if (rec.kind === 'series') {
        // docs/39 H2：系列整包上传，占槽位 = 内含关卡数（缺件/超槽位在本地即报错）
        const { folder } = await uploadLibraryFolder(rec, rows)
        setCloudMsg({ ok: true, text: `「${rec.title}」已上传云盘（${folder.levelCount} 个关卡，占 ${folder.levelCount} 个槽位）` })
      } else {
        const { level } = await uploadLibraryLevel(rec)
        setCloudMsg({ ok: true, text: `「${rec.title}」已上传云盘（${level.bytes >= 1024 ? `${(level.bytes / 1024).toFixed(1)} KB` : `${level.bytes} B`}）` })
      }
    } catch (e) {
      setCloudMsg({ ok: false, text: e instanceof Error ? e.message : String(e) })
    } finally {
      setCloudUploadingId(null)
    }
  }

  const searching = query.trim() !== ''

  const toggle = (id: string): void => {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  async function handleImport(files: FileList | null): Promise<void> {
    if (!files || files.length === 0) return
    setError('')
    setReport(null)
    setImporting(true)
    try {
      const entries = await Promise.all(
        [...files].map(async (f) => ({ name: f.name, bytes: new Uint8Array(await f.arrayBuffer()) })),
      )
      setReport(await importFromFiles(entries))
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setImporting(false)
      if (fileInput.current) fileInput.current.value = ''
    }
  }

  async function handleExport(rec: LibraryRecord): Promise<void> {
    setError('')
    try {
      const file = await exportResource(rec.id)
      downloadBlob(file.bytes, file.filename, file.mime)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  async function handleDelete(rec: LibraryRecord): Promise<void> {
    const msg =
      rec.kind === 'series'
        ? `删除系列「${rec.title}」？其中的专题与关卡不会被删除，将回到「未整理」区。`
        : rec.kind === 'topic'
          ? `删除专题「${rec.title}」？其中的关卡不会被删除，将回到「未整理」区。`
          : `删除「${rec.title}」？此操作不可撤销。`
    if (!window.confirm(msg)) return
    setError('')
    try {
      await deleteResource(rec.id)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  async function handleNew(): Promise<void> {
    setError('')
    try {
      const doc = blankLevelDoc()
      await putResource(doc as never)
      window.location.hash = `#/edit/${doc.id}`
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  /** 输入名称的公共前置：取消返回 null；空串报错返回 null */
  function promptTitle(header: string, fallback: string): string | null {
    const input = window.prompt(header, fallback)
    if (input === null) return null
    const title = input.trim()
    if (title === '') {
      setError('名称不能为空')
      return null
    }
    setError('')
    return title
  }

  async function handleCreateContainer(kind: 'series' | 'topic'): Promise<void> {
    const isSeries = kind === 'series'
    const title = promptTitle(isSeries ? '新建系列：输入名称' : '新建专题：输入名称', isSeries ? '未命名系列' : '未命名专题')
    if (title === null) return
    try {
      const doc = isSeries ? blankSeriesDoc(title) : blankTopicDoc(title)
      await putResource(doc)
      if (isSeries) setExpanded((prev) => new Set(prev).add(doc.id))
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  async function handleRename(rec: LibraryRecord): Promise<void> {
    const title = promptTitle(`重命名「${rec.title}」`, rec.title)
    if (title === null) return
    try {
      await putResource(renameDoc(rec.doc as ContainerDoc, title))
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  async function handleCreateTopicIn(seriesRec: LibraryRecord): Promise<void> {
    const title = promptTitle(`在「${seriesRec.title}」下新建专题：输入名称`, '未命名专题')
    if (title === null) return
    try {
      const topic = blankTopicDoc(title)
      await putResource(topic)
      await putResource(appendRefId(seriesRec.doc as ContainerDoc, 'topicIds', topic.id))
      setExpanded((prev) => new Set(prev).add(topic.id))
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  async function commitDocs(docs: Parameters<typeof putResource>[0][]): Promise<void> {
    for (const d of docs) await putResource(d)
  }

  async function handleMoveTarget(
    rec: LibraryRecord,
    target: { topicId?: string | null; seriesId?: string | null },
  ): Promise<void> {
    setError('')
    try {
      if (rec.kind === 'level') {
        const topics = rows.filter((r) => r.kind === 'topic').map((r) => r.doc as ContainerDoc)
        const next = moveLevelIntoTopic(rec.id, target.topicId ?? null, topics)
        await commitDocs(next.filter((d, i) => d !== topics[i]))
      } else if (rec.kind === 'topic') {
        const series = rows.filter((r) => r.kind === 'series').map((r) => r.doc as ContainerDoc)
        const next = moveTopicIntoSeries(rec.id, target.seriesId ?? null, series)
        await commitDocs(next.filter((d, i) => d !== series[i]))
      }
      setMoveDialog(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  async function handleCopyLevel(rec: LibraryRecord, targetTopicId: string | null): Promise<void> {
    setError('')
    try {
      const copy = copyLevelDoc(rec.doc as LevelLike)
      await putResource(copy)
      if (targetTopicId !== null) {
        const trec = rows.find((r) => r.id === targetTopicId)
        if (trec) await putResource(appendRefId(trec.doc as ContainerDoc, 'levelIds', copy.id))
      }
      setMoveDialog(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  async function handleCopySeries(rec: LibraryRecord): Promise<void> {
    setError('')
    try {
      const seriesDoc = rec.doc as SeriesDoc
      const topicRecs = childIds(seriesDoc, 'topicIds')
        .map((id) => rows.find((r) => r.id === id))
        .filter((r): r is LibraryRecord => r !== undefined && r.kind === 'topic')
      const levelIds = new Set<string>()
      for (const t of topicRecs) {
        for (const id of childIds(t.doc, 'levelIds')) levelIds.add(id)
      }
      const levelRecs = [...levelIds]
        .map((id) => rows.find((r) => r.id === id))
        .filter((r): r is LibraryRecord => r !== undefined && r.kind === 'level')
      if (
        !window.confirm(
          `复制系列「${rec.title}」（${topicRecs.length} 个专题、${levelRecs.length} 个关卡）？将生成全新 id 的副本，原系列不受影响。`,
        )
      ) {
        return
      }
      const tree = copySeriesTree(
        seriesDoc,
        topicRecs.map((r) => r.doc as TopicDoc),
        levelRecs.map((r) => r.doc as LevelLike),
      )
      await commitDocs([tree.series, ...tree.topics, ...tree.levels])
      setExpanded((prev) => new Set(prev).add(tree.series.id))
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  // AI 新建关卡（批次4）：建空白关卡 → 带用户描述跳编辑器，AI 面板自动以 agent 模式开工
  const [aiPrompt, setAiPrompt] = useState('')
  const [aiFormOpen, setAiFormOpen] = useState(false)

  async function handleAiNew(): Promise<void> {
    const prompt = aiPrompt.trim()
    if (prompt === '') {
      setError('先描述一下想做的关卡（如：大三和弦听辨练习，10 题，每题 10 分）')
      return
    }
    setError('')
    try {
      const doc = blankLevelDoc()
      await putResource(doc as never)
      // 按 docId 键控（docs/40 C6）：单槽键在连续创建两个 AI 关卡时会被后一个覆盖
      sessionStorage.setItem(`ai-kickoff:${doc.id}`, JSON.stringify({ docId: doc.id, prompt }))
      window.location.hash = `#/edit/${doc.id}`
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  // meta.featured 的内置资源置顶展示（教程/示例；其余按入库时间）
  const isFeatured = (r: LibraryRecord): boolean =>
    r.builtIn === 1 && (r.doc as { meta?: { featured?: boolean } })?.meta?.featured === true
  const rows = resources ?? []
  const { series, loose } = buildLibraryTree(rows)
  const visibleSeries = filterTree(series, query)
  const visibleLoose = filterTree(loose, query)
  const featuredRows = visibleLoose.filter((r) => isFeatured(r.rec))
  const restLoose = visibleLoose.filter((r) => !isFeatured(r.rec))

  const openMove = (rec: LibraryRecord): void => setMoveDialog({ mode: 'move', rec })
  const openCopy = (rec: LibraryRecord): void => {
    if (rec.kind === 'series') void handleCopySeries(rec)
    else setMoveDialog({ mode: 'copy', rec })
  }

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1>资源库</h1>
          <p className="page-sub">
            系列 = 文件夹：可新建系列/专题，重命名、移动与复制。删除容器不删内容，子级回到「未整理」。
            关卡可直接编辑（内置示例的修改会自动另存为你的副本）。支持 <code>.json</code> 单文档与 <code>.zip</code> 系列包导入。
          </p>
        </div>
        <div className="page-actions">
          <input
            className="library-search"
            value={query}
            placeholder="🔍 按标题搜索…"
            onChange={(e) => setQuery(e.target.value)}
          />
          <button type="button" className="primary" onClick={() => void handleNew()}>
            ✏ 新建关卡
          </button>
          <button type="button" onClick={() => void handleCreateContainer('series')}>
            📚 新建系列
          </button>
          <button type="button" onClick={() => void handleCreateContainer('topic')}>
            📂 新建专题
          </button>
          <button
            type="button"
            className={aiFormOpen ? 'primary' : ''}
            onClick={() => setAiFormOpen((v) => !v)}
            title="描述需求，AI 在编辑器里以 agent 模式从零搭建关卡"
          >
            🤖 AI 新建关卡
          </button>
          <button type="button" disabled={importing} onClick={() => fileInput.current?.click()}>
            {importing ? '导入中…' : '⬆ 导入'}
          </button>
          <input
            ref={fileInput}
            type="file"
            accept=".json,.zip"
            multiple
            hidden
            onChange={(e) => void handleImport(e.target.files)}
          />
        </div>
      </header>

      {aiFormOpen && (
        <div className="ai-new-form">
          <textarea
            rows={2}
            placeholder="描述想做的关卡，如：大三和弦听辨练习，10 题，每题 10 分，答错播放低音提示…"
            value={aiPrompt}
            onChange={(e) => setAiPrompt(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                void handleAiNew()
              }
            }}
          />
          <button type="button" className="primary" onClick={() => void handleAiNew()}>
            创建并让 AI 开工
          </button>
          <span className="muted">将创建空白关卡并进入编辑器，AI 助手自动以 agent 模式按描述搭建（可随时回滚）。</span>
        </div>
      )}

      {error && <p className="tone-error">{error}</p>}
      {cloudMsg && <p className={cloudMsg.ok ? 'muted' : 'tone-error'}>{cloudMsg.text}</p>}
      {report && (
        <div className="import-report">
          <b>导入完成</b>：新增 {report.added.length} · 更新 {report.updated.length} · 跳过{' '}
          {report.skipped.length} · 拒绝 {report.rejected.length}
          {report.aborted && '（因缺件整包未写入）'}
          <ul>
            {report.missing.map((m) => (
              <li key={m.id} className="tone-error">
                缺件：{m.id}（被 {m.neededBy} 引用）
              </li>
            ))}
            {report.rejected.map((r) => (
              <li key={r.file} className="tone-error">
                {r.file}：{r.reasons.join('；')}
              </li>
            ))}
          </ul>
        </div>
      )}

      {resources === undefined ? (
        <p className="muted">资源库加载中…</p>
      ) : rows.length === 0 ? (
        <p className="muted">库是空的——导入或刷新页面以载入内置示例。</p>
      ) : visibleSeries.length === 0 && visibleLoose.length === 0 ? (
        <p className="muted">没有匹配「{query}」的资源。</p>
      ) : (
        <div className="lib-tree">
          {featuredRows.length > 0 && (
            <>
              <div className="lib-divider">🎵 教程与示例</div>
              {featuredRows.map((row) => (
                <TreeRow
                  key={row.rec.id}
                  row={row}
                  depth={0}
                  searching={searching}
                  expanded={expanded}
                  onToggle={toggle}
                  onExport={handleExport}
                  onDelete={handleDelete}
                  onCloudUpload={handleCloudUpload}
                  cloudUploadingId={cloudUploadingId}
                  cloudReady={cloudReady}
                  onCreateTopic={(r) => void handleCreateTopicIn(r)}
                  onRename={(r) => void handleRename(r)}
                  onMove={openMove}
                  onCopy={openCopy}
                />
              ))}
            </>
          )}
          {visibleSeries.length > 0 && (
            <>
              <div className="lib-divider">系列</div>
              {visibleSeries.map((row) => (
                <TreeRow
                  key={row.rec.id}
                  row={row}
                  depth={0}
                  searching={searching}
                  expanded={expanded}
                  onToggle={toggle}
                  onExport={handleExport}
                  onDelete={handleDelete}
                  onCloudUpload={handleCloudUpload}
                  cloudUploadingId={cloudUploadingId}
                  cloudReady={cloudReady}
                  onCreateTopic={(r) => void handleCreateTopicIn(r)}
                  onRename={(r) => void handleRename(r)}
                  onMove={openMove}
                  onCopy={openCopy}
                />
              ))}
            </>
          )}
          {restLoose.length > 0 && (
            <>
              <div className="lib-divider">未整理</div>
              {restLoose.map((row) => (
                <TreeRow
                  key={row.rec.id}
                  row={row}
                  depth={0}
                  searching={searching}
                  expanded={expanded}
                  onToggle={toggle}
                  onExport={handleExport}
                  onDelete={handleDelete}
                  onCloudUpload={handleCloudUpload}
                  cloudUploadingId={cloudUploadingId}
                  cloudReady={cloudReady}
                  onCreateTopic={(r) => void handleCreateTopicIn(r)}
                  onRename={(r) => void handleRename(r)}
                  onMove={openMove}
                  onCopy={openCopy}
                />
              ))}
            </>
          )}
        </div>
      )}

      {moveDialog && (
        <MoveDialog
          mode={moveDialog.mode}
          rec={moveDialog.rec}
          rows={rows}
          onClose={() => setMoveDialog(null)}
          onTarget={(target) => {
            const { rec, mode } = moveDialog
            if (mode === 'move') void handleMoveTarget(rec, target)
            else void handleCopyLevel(rec, target.topicId ?? null)
          }}
        />
      )}
    </div>
  )
}

/** 移动/复制选目标弹窗：单列目标清单（未整理 + 各容器，标注当前位置，内置容器禁选） */
function MoveDialog(props: {
  mode: 'move' | 'copy'
  rec: LibraryRecord
  rows: LibraryRecord[]
  onTarget: (target: { topicId?: string | null; seriesId?: string | null }) => void
  onClose: () => void
}): React.ReactNode {
  const { rec, mode, rows } = props
  const isLevel = rec.kind === 'level'
  const verb = mode === 'move' ? '移动' : '复制'

  const currentParents = new Set<string>()
  if (isLevel) {
    for (const r of rows) {
      if (r.kind === 'topic' && childIds(r.doc, 'levelIds').includes(rec.id)) currentParents.add(r.id)
    }
  } else if (rec.kind === 'topic') {
    for (const r of rows) {
      if (r.kind === 'series' && childIds(r.doc, 'topicIds').includes(rec.id)) currentParents.add(r.id)
    }
  }

  const targets: { key: string; label: string; disabled: boolean; hint?: string; value: { topicId?: string | null; seriesId?: string | null } }[] = []
  if (isLevel) {
    targets.push({
      key: '__loose',
      label: '📄 未整理（移出所有专题）',
      disabled: mode === 'move' && currentParents.size === 0,
      value: { topicId: null },
    })
    const parentSeries = new Map<string, string>()
    for (const s of rows) {
      if (s.kind !== 'series') continue
      for (const tid of childIds(s.doc, 'topicIds')) {
        if (!parentSeries.has(tid)) parentSeries.set(tid, s.title)
      }
    }
    for (const t of rows) {
      if (t.kind !== 'topic') continue
      const parentBuiltIn = parentSeries.has(t.id) && rows.find((s) => s.id === parentSeries.get(t.id))?.builtIn === 1
      const builtInChain = t.builtIn === 1 || parentBuiltIn
      const isCurrent = mode === 'move' && currentParents.has(t.id)
      targets.push({
        key: t.id,
        label: `📂 ${t.title}${parentSeries.has(t.id) ? ` — 📚 ${parentSeries.get(t.id)}` : ''}${isCurrent ? '（当前位置）' : ''}`,
        hint: builtInChain ? BUILTIN_HINT : undefined,
        disabled: builtInChain || isCurrent,
        value: { topicId: t.id },
      })
    }
  } else {
    targets.push({
      key: '__loose',
      label: '📄 未整理（移出所有系列）',
      disabled: mode === 'move' && currentParents.size === 0,
      value: { seriesId: null },
    })
    for (const s of rows) {
      if (s.kind !== 'series') continue
      const isCurrent = mode === 'move' && currentParents.has(s.id)
      targets.push({
        key: s.id,
        label: `📚 ${s.title}${isCurrent ? '（当前位置）' : ''}`,
        hint: s.builtIn === 1 ? BUILTIN_HINT : undefined,
        disabled: s.builtIn === 1 || isCurrent,
        value: { seriesId: s.id },
      })
    }
  }

  const kindLabel = isLevel ? '关卡' : '专题'

  return (
    <div
      className="tjson-backdrop"
      onClick={(e) => {
        if (e.target === e.currentTarget) props.onClose()
      }}
    >
      <div className="tjson-modal tlist-modal">
        <div className="tjson-modal-head">
          <b>
            {verb}
            {kindLabel}「{rec.title}」到…
          </b>
          <button type="button" className="link" onClick={props.onClose}>
            取消
          </button>
        </div>
        <div className="tlist-rows">
          {targets.map((t) => (
            <div className="tlist-row" key={t.key}>
              <button
                type="button"
                className="lib-move-target"
                disabled={t.disabled}
                title={t.hint}
                onClick={() => props.onTarget(t.value)}
              >
                {t.label}
              </button>
            </div>
          ))}
        </div>
        <span className="muted">移动为单亲语义：{kindLabel}同一时刻只属于一个容器；复制生成新 id 副本。</span>
      </div>
    </div>
  )
}

function TreeRow(props: {
  row: LibraryTreeRow
  depth: number
  searching: boolean
  expanded: Set<string>
  onToggle: (id: string) => void
  onExport: (rec: LibraryRecord) => Promise<void>
  onDelete: (rec: LibraryRecord) => Promise<void>
  onCloudUpload: (rec: LibraryRecord) => Promise<void>
  cloudUploadingId: string | null
  cloudReady: boolean
  onCreateTopic: (rec: LibraryRecord) => void
  onRename: (rec: LibraryRecord) => void
  onMove: (rec: LibraryRecord) => void
  onCopy: (rec: LibraryRecord) => void
}): React.ReactNode {
  const { row, depth, searching, expanded, onToggle } = props
  const rec = row.rec
  const isContainer = row.children !== undefined
  const childCount = row.children?.length ?? 0
  const open = searching || expanded.has(rec.id)
  const frozen = rec.builtIn === 1

  return (
    <Fragment>
      <div className={`lib-row${isContainer ? ' is-container' : ''}`} style={{ paddingLeft: 8 + depth * 20 }}>
        {isContainer ? (
          <button
            type="button"
            className="lib-twist"
            title={open ? '收起' : '展开'}
            onClick={() => onToggle(rec.id)}
          >
            {open ? '▾' : '▸'}
          </button>
        ) : (
          <span className="lib-twist lib-leaf" aria-hidden>
            ·
          </span>
        )}
        <span className="lib-icon" aria-hidden>
          {KIND_ICON[rec.kind] ?? '•'}
        </span>
        {rec.kind === 'level' ? (
          <a className="lib-title" href={`#/level/${rec.id}`} title="试玩">
            {rec.title}
          </a>
        ) : isContainer ? (
          <button type="button" className="lib-title lib-title-btn" title={open ? '收起' : '像文件夹一样打开'} onClick={() => onToggle(rec.id)}>
            {rec.title}
            <span className="muted lib-count">
              {rec.kind === 'series' ? `${childCount} 个专题` : `${childCount} 个关卡`}
            </span>
          </button>
        ) : (
          <span className="lib-title">{rec.title}</span>
        )}
        {rec.builtIn ? <span className="lib-badge">内置</span> : null}
        <span className="muted id-hint">{rec.id}</span>
        <span className="row-actions">
          {rec.kind === 'level' && (
            <>
              <a href={`#/edit/${rec.id}`} title="直接编辑（内置示例保存时自动另存为副本）">
                编辑
              </a>
              <a href={`#/level/${rec.id}`}>试玩</a>
            </>
          )}
          {(rec.kind === 'level' || rec.kind === 'topic') && (
            <button
              type="button"
              className="link"
              disabled={frozen}
              title={frozen ? BUILTIN_HINT : '移动到其他容器（单亲语义）'}
              onClick={() => props.onMove(rec)}
            >
              移动…
            </button>
          )}
          <button type="button" className="link" title="复制（生成新 id 副本）" onClick={() => props.onCopy(rec)}>
            {rec.kind === 'series' ? '复制' : '复制…'}
          </button>
          {rec.kind === 'series' && (
            <button
              type="button"
              className="link"
              disabled={frozen}
              title={frozen ? BUILTIN_HINT : '在此系列下新建专题'}
              onClick={() => props.onCreateTopic(rec)}
            >
              新建专题
            </button>
          )}
          {rec.kind === 'series' && props.cloudReady && (
            <button
              type="button"
              className="link"
              title={props.cloudUploadingId === rec.id ? '上传中…' : '整包上传系列（占槽位 = 内含关卡数）'}
              disabled={props.cloudUploadingId !== null}
              onClick={() => void props.onCloudUpload(rec)}
            >
              {props.cloudUploadingId === rec.id ? '☁ 上传中…' : '☁ 上传'}
            </button>
          )}
          {!frozen && (
            <button type="button" className="link" title="重命名" onClick={() => props.onRename(rec)}>
              重命名
            </button>
          )}
          {rec.kind === 'level' && props.cloudReady && (
            <button
              type="button"
              className="link"
              title={props.cloudUploadingId === rec.id ? '上传中…' : '上传到云盘（登录后可用）'}
              disabled={props.cloudUploadingId !== null}
              onClick={() => void props.onCloudUpload(rec)}
            >
              {props.cloudUploadingId === rec.id ? '☁ 上传中…' : '☁ 上传'}
            </button>
          )}
          <button type="button" className="link" onClick={() => void props.onExport(rec)}>
            导出
          </button>
          {!frozen && (
            <button type="button" className="link danger" onClick={() => void props.onDelete(rec)}>
              删除
            </button>
          )}
        </span>
      </div>
      {isContainer && open && childCount === 0 && (
        <div className="lib-row lib-empty-child" style={{ paddingLeft: 8 + (depth + 1) * 20 }}>
          （空）
        </div>
      )}
      {isContainer && open && childCount > 0 && (
        <div className="lib-children">
          {row.children!.map((child) => (
            <TreeRow
              key={child.rec.id}
              row={child}
              depth={depth + 1}
              searching={searching}
              expanded={expanded}
              onToggle={onToggle}
              onExport={props.onExport}
              onDelete={props.onDelete}
              onCloudUpload={props.onCloudUpload}
              cloudUploadingId={props.cloudUploadingId}
              cloudReady={props.cloudReady}
              onCreateTopic={props.onCreateTopic}
              onRename={props.onRename}
              onMove={props.onMove}
              onCopy={props.onCopy}
            />
          ))}
        </div>
      )}
    </Fragment>
  )
}
