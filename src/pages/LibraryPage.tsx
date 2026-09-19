/**
 * 资源库：系列 = 文件夹（可展开：系列 ▸ 专题 ▸ 关卡），未被引用的资源归入「未整理」区。
 * 关卡可直接编辑（内置示例保存时自动另存为副本）；支持标题搜索、导入导出、新建。
 */
import { useLiveQuery } from 'dexie-react-hooks'
import { Fragment, useRef, useState } from 'react'
import type { LibraryRecord } from '../library/db'
import { db, deleteResource, putResource } from '../library/db'
import { downloadBlob, exportResource, importFromFiles, type ImportReport } from '../library/io'
import { buildLibraryTree, filterTree, type LibraryTreeRow } from '../library/browse'
import { blankLevelDoc } from '../editor/docState'

const KIND_ICON: Record<string, string> = { series: '📚', topic: '📂', level: '🎯', instrument: '🎹' }

export function LibraryPage() {
  const resources = useLiveQuery(() => db.resources.orderBy('importedAt').toArray(), [], undefined)
  const [report, setReport] = useState<ImportReport | null>(null)
  const [error, setError] = useState('')
  const [importing, setImporting] = useState(false)
  const [query, setQuery] = useState('')
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const fileInput = useRef<HTMLInputElement>(null)

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
      <h1>资源库</h1>
      <p className="muted">
        系列 = 文件夹：点开即可浏览其中的专题与关卡。关卡可直接编辑（内置示例的修改会自动另存为你的副本）。
        支持 <code>.json</code> 单文档与 <code>.zip</code> 系列包导入。
      </p>

      <div className="library-actions">
        <button type="button" className="primary" onClick={() => void handleNew()}>
          ✏ 新建关卡
        </button>
        <button type="button" className="primary" disabled={importing} onClick={() => fileInput.current?.click()}>
          {importing ? '导入中…' : '⬆ 导入（.json / .zip）'}
        </button>
        <input
          ref={fileInput}
          type="file"
          accept=".json,.zip"
          multiple
          hidden
          onChange={(e) => void handleImport(e.target.files)}
        />
        <input
          className="library-search"
          value={query}
          placeholder="🔍 按标题搜索…"
          onChange={(e) => setQuery(e.target.value)}
        />
        <a className="button-like" href="#/">
          ← 返回首页
        </a>
      </div>

      {error && <p className="tone-error">{error}</p>}
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
                <TreeRow key={row.rec.id} row={row} depth={0} searching={searching} expanded={expanded} onToggle={toggle} onExport={handleExport} onDelete={handleDelete} />
              ))}
            </>
          )}
          {visibleSeries.length > 0 && (
            <>
              <div className="lib-divider">系列</div>
              {visibleSeries.map((row) => (
                <TreeRow key={row.rec.id} row={row} depth={0} searching={searching} expanded={expanded} onToggle={toggle} onExport={handleExport} onDelete={handleDelete} />
              ))}
            </>
          )}
          {restLoose.length > 0 && (
            <>
              <div className="lib-divider">未整理</div>
              {restLoose.map((row) => (
                <TreeRow key={row.rec.id} row={row} depth={0} searching={searching} expanded={expanded} onToggle={toggle} onExport={handleExport} onDelete={handleDelete} />
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
            />
          ))}
        </div>
      )}
    </Fragment>
  )
}
