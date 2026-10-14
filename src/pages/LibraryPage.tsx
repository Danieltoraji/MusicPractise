/**
 * 资源库：系列 = 文件夹（可展开：系列 ▸ 专题 ▸ 关卡），未被引用的资源归入「未整理」区。
 * 关卡可直接编辑（内置示例保存时自动另存为副本）；支持标题搜索、导入导出、新建。
 */
import { useLiveQuery } from 'dexie-react-hooks'
import { Fragment, useRef, useState, useSyncExternalStore } from 'react'
import type { LibraryRecord } from '../library/db'
import { db, deleteResource, putResource } from '../library/db'
import { downloadBlob, exportResource, importFromFiles, type ImportReport } from '../library/io'
import { buildLibraryTree, filterTree, type LibraryTreeRow } from '../library/browse'
import { blankLevelDoc } from '../editor/docState'
import { getAccountSnapshot, subscribeAccount } from '../account/store'
import { uploadLibraryLevel } from '../cloud/api'

const KIND_ICON: Record<string, string> = { series: '📚', topic: '📂', level: '🎯', instrument: '🎹' }

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

  async function handleCloudUpload(rec: LibraryRecord): Promise<void> {
    setCloudMsg(null)
    setCloudUploadingId(rec.id)
    try {
      const { level } = await uploadLibraryLevel(rec)
      setCloudMsg({ ok: true, text: `「${rec.title}」已上传云盘（${level.bytes >= 1024 ? `${(level.bytes / 1024).toFixed(1)} KB` : `${level.bytes} B`}）` })
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
    if (!window.confirm(`删除「${rec.title}」？此操作不可撤销。`)) return
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
      sessionStorage.setItem('ai-kickoff', JSON.stringify({ docId: doc.id, prompt }))
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

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1>资源库</h1>
          <p className="page-sub">
            系列 = 文件夹：点开即可浏览其中的专题与关卡。关卡可直接编辑（内置示例的修改会自动另存为你的副本）。
            支持 <code>.json</code> 单文档与 <code>.zip</code> 系列包导入。
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
                <TreeRow key={row.rec.id} row={row} depth={0} searching={searching} expanded={expanded} onToggle={toggle} onExport={handleExport} onDelete={handleDelete} onCloudUpload={handleCloudUpload} cloudUploadingId={cloudUploadingId} cloudReady={cloudReady} />
              ))}
            </>
          )}
          {visibleSeries.length > 0 && (
            <>
              <div className="lib-divider">系列</div>
              {visibleSeries.map((row) => (
                <TreeRow key={row.rec.id} row={row} depth={0} searching={searching} expanded={expanded} onToggle={toggle} onExport={handleExport} onDelete={handleDelete} onCloudUpload={handleCloudUpload} cloudUploadingId={cloudUploadingId} cloudReady={cloudReady} />
              ))}
            </>
          )}
          {restLoose.length > 0 && (
            <>
              <div className="lib-divider">未整理</div>
              {restLoose.map((row) => (
                <TreeRow key={row.rec.id} row={row} depth={0} searching={searching} expanded={expanded} onToggle={toggle} onExport={handleExport} onDelete={handleDelete} onCloudUpload={handleCloudUpload} cloudUploadingId={cloudUploadingId} cloudReady={cloudReady} />
              ))}
            </>
          )}
        </div>
      )}
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
}): React.ReactNode {
  const { row, depth, searching, expanded, onToggle } = props
  const rec = row.rec
  const isContainer = row.children !== undefined
  const childCount = row.children?.length ?? 0
  const open = searching || expanded.has(rec.id)

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
          {!rec.builtIn && (
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
            />
          ))}
        </div>
      )}
    </Fragment>
  )
}
