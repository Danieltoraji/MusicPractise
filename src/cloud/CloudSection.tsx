import { useEffect, useState, useSyncExternalStore } from 'react'
import { getAccountSnapshot, subscribeAccount } from '../account/store'
import { cloudApi, CLOUD_LIMIT } from './api'

/**
 * 设置页「云盘」区（docs/31 批次 B2；docs/39 H2 起降级为摘要）：
 * 完整的槽位管理（上传/下载/删除/文件夹）已迁至独立页 #/cloud，此处只显示
 * 合并口径用量并提供入口。列表按需拉取，不做全局 store。
 */
export function CloudSection() {
  const snap = useSyncExternalStore(subscribeAccount, getAccountSnapshot)
  const [used, setUsed] = useState<number | null>(null)
  const signedIn = snap.phase === 'available' && snap.user !== null

  useEffect(() => {
    if (!signedIn) {
      setUsed(null)
      return
    }
    let cancelled = false
    cloudApi
      .listSlots()
      .then((res) => {
        if (!cancelled) setUsed(res.used)
      })
      .catch(() => {
        if (!cancelled) setUsed(null)
      })
    return () => {
      cancelled = true
    }
  }, [signedIn])

  if (snap.phase !== 'available') return null

  if (!signedIn) {
    return <p className="muted cloud-status">登录后可使用云盘：把关卡与系列文件夹上传到云端（{CLOUD_LIMIT} 个槽位），换设备随时下载。</p>
  }

  return (
    <div className="cloud-box">
      <div className="cloud-head">
        <span>
          已用 <b>{used ?? '…'}</b> / {CLOUD_LIMIT} 个槽位
        </span>
        <a href="#/cloud">前往我的云盘 →</a>
      </div>
    </div>
  )
}
