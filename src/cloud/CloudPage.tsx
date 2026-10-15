/**
 * 我的云盘（docs/39 批次 H2，#/cloud）：私有云盘域的独立管理页。
 * 关卡与系列文件夹两类槽位；「已用」为合并口径（关卡数 + Σ文件夹内含关卡数），上限 10。
 * 上传从本机资源库选择（点击即传）；下载走 importDocuments 既有管线（信封校验→闭包→冲突策略→事务）。
 * 设置页 CloudSection 保留摘要与本页入口。
 */
import { useCallback, useEffect, useState, useSyncExternalStore } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { getAccountSnapshot, subscribeAccount } from '../account/store'
import { db, type LibraryRecord } from '../library/db'
import { collectSeriesDocs } from '../library/manage'
import { importDocuments, type ImportReport } from '../library/io'
import { cloudApi, CLOUD_LIMIT, uploadLibraryFolder, uploadLibraryLevel, type CloudFolder, type CloudSlot } from './api'

const KIND_ICON: Record<string, string> = { series: '📚', topic: '📂', level: '🎯', instrument: '🎹' }

function fmtKB(bytes: number): string {
  return bytes >= 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${bytes} B`
}

export function CloudPage() {
  const snap = useSyncExternalStore(subscribeAccount, getAccountSnapshot)
  const signedIn = snap.phase === 'available' && snap.user !== null
  const [data, setData] = useState<{ levels: CloudSlot[]; folders: CloudFolder[]; used: number; limit: number } | null>(null)
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)
  const [report, setReport] = useState<ImportReport | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [pickerOpen, setPickerOpen] = useState(false)
  // 本机资源库（上传选择器数据源）
  const localRows = useLiveQuery(() => db.resources.orderBy('importedAt').toArray(), [], undefined)

  const refresh = useCallback(async (): Promise<void> => {
    try {
      setData(await cloudApi.listSlots())
    } catch (err) {
      setMsg({ ok: false, text: err instanceof Error ? err.message : String(err) })
      setData({ levels: [], folders: [], used: 0, limit: CLOUD_LIMIT })
    }
  }, [])

  useEffect(() => {
    if (signedIn) void refresh()
    else {
      setData(null)
      setMsg(null)
      setReport(null)
    }
  }, [signedIn, refresh])

  if (snap.phase === 'probing') {
    return (
      <div className="page">
        <p className="muted">账户信息加载中…</p>
      </div>
    )
  }
  if (snap.phase !== 'available') {
    return (
      <div className="page">
        <p className="tone-error">后端不可用，云盘暂时无法使用——本地资源库不受影响。</p>
      </div>
    )
  }
  if (!signedIn) {
    return (
      <div className="page">
        <header className="page-head">
          <div>
            <h1>我的云盘</h1>
            <p className="page-sub">把关卡与系列文件夹存到云端，换设备随时下载。</p>
          </div>
        </header>
        <p className="muted">
          云盘需要登录（{CLOUD_LIMIT} 个槽位，系列按内含关卡数占用）——<a href="#/settings">去设置页登录 →</a>
        </p>
      </div>
    )
  }

  async function uploadOne(rec: LibraryRecord): Promise<void> {
    setMsg(null)
    setReport(null)
    setBusyId(rec.id)
    try {
      if (rec.kind === 'series') {
        const rows = localRows ?? []
        const { folder } = await uploadLibraryFolder(rec, rows)
        setMsg({ ok: true, text: `「${rec.title}」已上传云盘（${folder.levelCount} 个关卡，占 ${folder.levelCount} 个槽位）` })
      } else {
        const { level } = await uploadLibraryLevel(rec)
        setMsg({ ok: true, text: `「${rec.title}」已上传云盘（${fmtKB(level.bytes)}）` })
      }
      setPickerOpen(false)
      await refresh()
    } catch (err) {
      setMsg({ ok: false, text: err instanceof Error ? err.message : String(err) })
    } finally {
      setBusyId(null)
    }
  }

  async function handleDownloadLevel(slot: CloudSlot): Promise<void> {
    setMsg(null)
    setReport(null)
    setBusyId(slot.id)
    try {
      const res = await cloudApi.getSlot(slot.id)
      setReport(await importDocuments([{ file: `${slot.title || slot.levelId}.json`, raw: res.level.payload }]))
      await refresh()
    } catch (err) {
      setMsg({ ok: false, text: err instanceof Error ? err.message : String(err) })
    } finally {
      setBusyId(null)
    }
  }

  async function handleDownloadFolder(folder: CloudFolder): Promise<void> {
    setMsg(null)
    setReport(null)
    setBusyId(folder.id)
    try {
      const res = await cloudApi.getFolder(folder.id)
      setReport(await importDocuments(res.docs.map((d) => ({ file: `${d.id}.json`, raw: d.payload }))))
      await refresh()
    } catch (err) {
      setMsg({ ok: false, text: err instanceof Error ? err.message : String(err) })
    } finally {
      setBusyId(null)
    }
  }

  async function handleDeleteLevel(slot: CloudSlot): Promise<void> {
    if (!window.confirm(`从云盘删除「${slot.title}」？本地副本不受影响。`)) return
    setMsg(null)
    setBusyId(slot.id)
    try {
      await cloudApi.deleteSlot(slot.id)
      setMsg({ ok: true, text: `已删除「${slot.title}」` })
      await refresh()
    } catch (err) {
      setMsg({ ok: false, text: err instanceof Error ? err.message : String(err) })
    } finally {
      setBusyId(null)
    }
  }

  async function handleDeleteFolder(folder: CloudFolder): Promise<void> {
    if (!window.confirm(`从云盘删除文件夹「${folder.title}」？将释放 ${folder.levelCount} 个槽位，本地副本不受影响。`)) return
    setMsg(null)
    setBusyId(folder.id)
    try {
      await cloudApi.deleteFolder(folder.id)
      setMsg({ ok: true, text: `已删除「${folder.title}」（释放 ${folder.levelCount} 个槽位）` })
      await refresh()
    } catch (err) {
      setMsg({ ok: false, text: err instanceof Error ? err.message : String(err) })
    } finally {
      setBusyId(null)
    }
  }

  // 上传选择器：本机库的系列与关卡（系列标注内含关卡数，缺件标注不可传）
  const candidates = (localRows ?? []).filter((r) => r.kind === 'series' || r.kind === 'level')
  const isEmpty = (data?.levels.length ?? 0) === 0 && (data?.folders.length ?? 0) === 0

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1>我的云盘</h1>
          <p className="page-sub">关卡与系列文件夹存到云端，换设备随时下载。系列按内含关卡数占用槽位，覆盖更新不重复占槽。</p>
        </div>
        <div className="page-actions">
          <button type="button" className="primary" onClick={() => setPickerOpen(true)}>
            ☁ 上传
          </button>
          <button type="button" onClick={() => void refresh()}>
            ↻ 刷新
          </button>
        </div>
      </header>

      <div className="cloud-box">
        <div className="cloud-head">
          <span>
            已用 <b>{data?.used ?? 0}</b> / {data?.limit ?? CLOUD_LIMIT} 个槽位
          </span>
        </div>
        {msg && <p className={msg.ok ? 'muted' : 'tone-error'}>{msg.text}</p>}
        {report && (
          <div className="import-report">
            <b>下载完成</b>：新增 {report.added.length} · 更新 {report.updated.length} · 跳过 {report.skipped.length} · 拒绝{' '}
            {report.rejected.length}
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
        {data === null ? (
          <p className="muted">云盘加载中…</p>
        ) : isEmpty ? (
          <p className="muted">
            云盘还是空的——点上方「☁ 上传」从本机资源库选择关卡或系列，或到<a href="#/library">资源库</a>点行内「☁ 上传」。
          </p>
        ) : (
          <>
            {data.folders.length > 0 && (
              <>
                <div className="lib-divider">📚 系列文件夹</div>
                <ul className="cloud-list">
                  {data.folders.map((folder) => (
                    <li key={folder.id} className="cloud-row">
                      <span className="cloud-title" title={folder.folderId}>
                        {folder.title}
                      </span>
                      <span className="muted">
                        {folder.levelCount} 个关卡 · {fmtKB(folder.bytes)} · {new Date(folder.updatedAt).toLocaleString()}
                      </span>
                      <span className="row-actions">
                        <button type="button" className="link" disabled={busyId !== null} onClick={() => void handleDownloadFolder(folder)}>
                          下载到本机
                        </button>
                        <button type="button" className="link danger" disabled={busyId !== null} onClick={() => void handleDeleteFolder(folder)}>
                          删除
                        </button>
                      </span>
                    </li>
                  ))}
                </ul>
              </>
            )}
            {data.levels.length > 0 && (
              <>
                <div className="lib-divider">🎯 关卡</div>
                <ul className="cloud-list">
                  {data.levels.map((slot) => (
                    <li key={slot.id} className="cloud-row">
                      <span className="cloud-title" title={slot.levelId}>
                        {slot.title || slot.levelId}
                      </span>
                      <span className="muted">
                        {fmtKB(slot.bytes)} · {new Date(slot.updatedAt).toLocaleString()}
                      </span>
                      <span className="row-actions">
                        <button type="button" className="link" disabled={busyId !== null} onClick={() => void handleDownloadLevel(slot)}>
                          下载到本机
                        </button>
                        <button type="button" className="link danger" disabled={busyId !== null} onClick={() => void handleDeleteLevel(slot)}>
                          删除
                        </button>
                      </span>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </>
        )}
      </div>

      {pickerOpen && (
        <div
          className="tjson-backdrop"
          onClick={(e) => {
            if (e.target === e.currentTarget) setPickerOpen(false)
          }}
        >
          <div className="tjson-modal tlist-modal">
            <div className="tjson-modal-head">
              <b>从本机资源库上传…</b>
              <button type="button" className="link" onClick={() => setPickerOpen(false)}>
                取消
              </button>
            </div>
            <div className="tlist-rows">
              {candidates.map((rec) => {
                let hint = ''
                let disabled = busyId !== null
                if (rec.kind === 'series') {
                  try {
                    const { levelCount } = collectSeriesDocs(rec, localRows ?? [])
                    hint = `（${levelCount} 个关卡，占 ${levelCount} 个槽位）`
                  } catch (err) {
                    hint = `（${err instanceof Error ? err.message : '缺件，无法上传'}）`
                    disabled = true
                  }
                }
                return (
                  <div className="tlist-row" key={rec.id}>
                    <button
                      type="button"
                      className="lib-move-target"
                      disabled={disabled}
                      title="点击上传（已在云端的同 id 内容将被覆盖更新）"
                      onClick={() => void uploadOne(rec)}
                    >
                      {KIND_ICON[rec.kind] ?? '•'} {rec.title}
                      <span className="muted"> {hint}</span>
                    </button>
                  </div>
                )
              })}
              {candidates.length === 0 && <span className="muted">本机资源库是空的——先到资源库新建或导入。</span>}
            </div>
            <span className="muted">系列将连同其专题与关卡整体上传；已在云端的同 id 内容覆盖更新、不重复占槽。</span>
          </div>
        </div>
      )}
    </div>
  )
}
