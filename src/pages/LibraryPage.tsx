import { useLiveQuery } from 'dexie-react-hooks'
import { useRef, useState } from 'react'
import type { LibraryRecord, ResourceKind } from '../library/db'
import { db, deleteResource } from '../library/db'
import { downloadBlob, exportResource, importFromFiles, type ImportReport } from '../library/io'

const KIND_LABEL: Record<ResourceKind, string> = { series: '📚 系列', topic: '📂 专题', level: '🎯 关卡', instrument: '🎹 乐器' }

export function LibraryPage() {
  const resources = useLiveQuery(() => db.resources.orderBy('importedAt').toArray(), [], undefined)
  const [report, setReport] = useState<ImportReport | null>(null)
  const [error, setError] = useState('')
  const fileInput = useRef<HTMLInputElement>(null)

  async function handleImport(files: FileList | null): Promise<void> {
    if (!files || files.length === 0) return
    setError('')
    setReport(null)
    try {
      const entries = await Promise.all(
        [...files].map(async (f) => ({ name: f.name, bytes: new Uint8Array(await f.arrayBuffer()) })),
      )
      setReport(await importFromFiles(entries))
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
    if (fileInput.current) fileInput.current.value = ''
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
    setError('')
    try {
      await deleteResource(rec.id)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  return (
    <div className="page">
      <h1>资源库</h1>
      <p className="muted">
        所有内容（内置示例与导入的文档）都存放在浏览器本地库。支持导入 <code>.json</code> 单文档或{' '}
        <code>.zip</code> 系列包；导出关卡为 JSON、系列为自包含 zip。
      </p>

      <div className="library-actions">
        <button type="button" className="primary" onClick={() => fileInput.current?.click()}>
          ⬆ 导入（.json / .zip）
        </button>
        <input
          ref={fileInput}
          type="file"
          accept=".json,.zip"
          multiple
          hidden
          onChange={(e) => void handleImport(e.target.files)}
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
      ) : resources.length === 0 ? (
        <p className="muted">库是空的——导入或刷新页面以载入内置示例。</p>
      ) : (
        <table className="library-table">
          <thead>
            <tr>
              <th>类型</th>
              <th>标题</th>
              <th>版本</th>
              <th>来源</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            {resources.map((rec) => (
              <tr key={rec.id}>
                <td>{KIND_LABEL[rec.kind] ?? rec.kind}</td>
                <td>
                  {rec.kind === 'level' ? <a href={`#/level/${rec.id}`}>{rec.title}</a> : rec.title}
                  <span className="muted id-hint">{rec.id}</span>
                </td>
                <td>{rec.version}</td>
                <td>{rec.builtIn ? '内置' : '导入'}</td>
                <td className="row-actions">
                  {rec.kind === 'level' && (
                    <a href={`#/level/${rec.id}`}>试玩</a>
                  )}
                  <button type="button" className="link" onClick={() => void handleExport(rec)}>
                    导出
                  </button>
                  {!rec.builtIn && (
                    <button type="button" className="link danger" onClick={() => void handleDelete(rec)}>
                      删除
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  )
}
