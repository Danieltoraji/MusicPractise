import { useCallback, useEffect, useState, useSyncExternalStore } from 'react'
import { getAccountSnapshot, subscribeAccount } from '../account/store'
import { importDocuments, type ImportReport } from '../library/io'
import { cloudApi, CLOUD_LIMIT, type CloudSlot } from './api'

/**
 * 设置页「云盘」区（docs/31 §7，批次 B2）：仅账户可用时渲染。
 * 槽位列表按需拉取（不做全局 store——低频管理操作）；下载走 importDocuments
 * 既有管线（信封校验→闭包检查→冲突策略→事务写入→报告），与文件导入行为一致。
 */
export function CloudSection() {
  const snap = useSyncExternalStore(subscribeAccount, getAccountSnapshot)
  const [slots, setSlots] = useState<CloudSlot[] | null>(null)
  const [used, setUsed] = useState(0)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [report, setReport] = useState<ImportReport | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)

  const signedIn = snap.phase === 'available' && snap.user !== null

  const refresh = useCallback(async (): Promise<void> => {
    setError('')
    try {
      const res = await cloudApi.listSlots()
      setSlots(res.levels)
      setUsed(res.used)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setSlots([])
    }
  }, [])

  useEffect(() => {
    if (signedIn) void refresh()
    else {
      setSlots(null)
      setReport(null)
      setNotice('')
      setError('')
    }
  }, [signedIn, refresh])

  if (snap.phase !== 'available') return null

  if (!signedIn) {
    return <p className="muted cloud-status">登录后可使用云盘：把关卡上传到云端（{CLOUD_LIMIT} 个槽位），换设备随时下载。</p>
  }

  const handleDownload = async (slot: CloudSlot): Promise<void> => {
    setBusyId(slot.id)
    setError('')
    setNotice('')
    setReport(null)
    try {
      const res = await cloudApi.getSlot(slot.id)
      const report = await importDocuments([{ file: `${slot.title || slot.levelId}.json`, raw: res.level.payload }])
      setReport(report)
      await refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusyId(null)
    }
  }

  const handleDelete = async (slot: CloudSlot): Promise<void> => {
    if (!window.confirm(`从云盘删除「${slot.title}」？本地副本不受影响。`)) return
    setBusyId(slot.id)
    setError('')
    setReport(null)
    try {
      await cloudApi.deleteSlot(slot.id)
      setNotice(`已删除「${slot.title}」`)
      await refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusyId(null)
    }
  }

  const fmtKB = (bytes: number): string => (bytes >= 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${bytes} B`)

  return (
    <div className="cloud-box">
      <div className="cloud-head">
        <span>
          已用 <b>{used}</b> / {CLOUD_LIMIT} 个槽位
        </span>
        <button type="button" className="link" onClick={() => void refresh()}>
          ↻ 刷新
        </button>
      </div>
      {error && <p className="tone-error">{error}</p>}
      {notice && <p className="muted">{notice}</p>}
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
      {slots === null ? (
        <p className="muted">云盘加载中…</p>
      ) : slots.length === 0 ? (
        <p className="muted">
          还没有上传过关卡——到<a href="#/library">资源库</a>点关卡行的「☁ 上传」试试。
        </p>
      ) : (
        <ul className="cloud-list">
          {slots.map((slot) => (
            <li key={slot.id} className="cloud-row">
              <span className="cloud-title" title={slot.levelId}>
                {slot.title || slot.levelId}
              </span>
              <span className="muted">
                {fmtKB(slot.bytes)} · {new Date(slot.updatedAt).toLocaleString()}
              </span>
              <span className="row-actions">
                <button type="button" className="link" disabled={busyId !== null} onClick={() => void handleDownload(slot)}>
                  下载到本机
                </button>
                <button type="button" className="link danger" disabled={busyId !== null} onClick={() => void handleDelete(slot)}>
                  删除
                </button>
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
