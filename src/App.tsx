import { lazy, Suspense, useEffect, useState, useSyncExternalStore } from 'react'
import { unlockAudio } from './runtime/audio'
import { HomePage } from './pages/HomePage'
import { LevelPage } from './pages/LevelPage'
import { LibraryPage } from './pages/LibraryPage'
import { SeriesPage } from './pages/SeriesPage'
import { SettingsPage } from './pages/SettingsPage'
import { ensureSeeded } from './library/db'
import { getAccountSnapshot, probeAccount, subscribeAccount } from './account/store'

/**
 * 路由级懒加载（批次11 Bundle 瘦身）：重组件只随路由按需加载，控制主包体积。
 * 编辑器（含 React Flow/VexFlow/StaffEditor 子树）、校音器（pitchy）、节奏训练不进首屏。
 */
const GraphPage = lazy(() => import('./pages/GraphPage').then((m) => ({ default: m.GraphPage })))
const EditorPage = lazy(() => import('./editor/EditorPage').then((m) => ({ default: m.EditorPage })))
const TunerDemo = lazy(() => import('./pages/TunerDemo').then((m) => ({ default: m.TunerDemo })))
const RhythmDemo = lazy(() => import('./pages/RhythmDemo').then((m) => ({ default: m.RhythmDemo })))
const AdminPage = lazy(() => import('./admin/AdminPage').then((m) => ({ default: m.AdminPage })))
const DocsPage = lazy(() => import('./pages/DocsPage').then((m) => ({ default: m.DocsPage })))

const PageLoading = (
  <p className="muted" style={{ padding: 24 }}>
    加载中…
  </p>
)

function useHashRoute(): string {
  const [hash, setHash] = useState(() => window.location.hash)
  useEffect(() => {
    const onChange = () => setHash(window.location.hash)
    window.addEventListener('hashchange', onChange)
    return () => window.removeEventListener('hashchange', onChange)
  }, [])
  return hash
}

export default function App() {
  const hash = useHashRoute()
  const [seeded, setSeeded] = useState(false)
  const [seedError, setSeedError] = useState('')
  const [seedAttempt, setSeedAttempt] = useState(0)
  const account = useSyncExternalStore(subscribeAccount, getAccountSnapshot)

  // 首次启动把内置示例关卡入库；此后一切内容只从库读取
  useEffect(() => {
    setSeedError('')
    ensureSeeded().then(
      () => setSeeded(true),
      (err) => setSeedError(String(err instanceof Error ? err.message : err)),
    )
  }, [seedAttempt])

  // 账户探测（docs/31 §7）：后台运行不阻塞首屏；结果驱动设置页账户区与顶栏昵称
  useEffect(() => {
    void probeAccount()
  }, [])

  // 浏览器自动播放策略：首次手势解锁 AudioContext（touchend 兜底老 Android/微信内核——
  // 部分内核只认 touch 系事件；passive 避免阻塞滚动）
  useEffect(() => {
    const unlock = () => unlockAudio()
    window.addEventListener('pointerdown', unlock, { once: true })
    window.addEventListener('keydown', unlock, { once: true })
    window.addEventListener('touchend', unlock, { once: true, passive: true })
    return () => {
      window.removeEventListener('pointerdown', unlock)
      window.removeEventListener('keydown', unlock)
      window.removeEventListener('touchend', unlock)
    }
  }, [])

  let page: React.ReactNode
  if (!seeded) {
    page = seedError ? (
      <div className="page boundary-error">
        <h2>资源库初始化失败</h2>
        <p className="muted">{seedError}</p>
        <button type="button" onClick={() => setSeedAttempt((n) => n + 1)}>
          重试
        </button>
      </div>
    ) : (
      <p className="muted">资源库初始化中…</p>
    )
  } else if (hash.startsWith('#/level/')) {
    page = <LevelPage key={hash} id={hash.slice('#/level/'.length)} />
  } else if (hash.startsWith('#/series/')) {
    page = <SeriesPage key={hash} id={hash.slice('#/series/'.length)} />
  } else if (hash.startsWith('#/graph/')) {
    page = (
      <Suspense fallback={<p className="muted">加载中…</p>}>
        <GraphPage key={hash} id={hash.slice('#/graph/'.length)} />
      </Suspense>
    )
  } else if (hash.startsWith('#/edit/')) {
    page = (
      <Suspense fallback={PageLoading}>
        <EditorPage key={hash} id={hash.slice('#/edit/'.length)} />
      </Suspense>
    )
  } else if (hash === '#/library') {
    page = <LibraryPage />
  } else if (hash === '#/docs' || hash.startsWith('#/docs/')) {
    page = (
      <Suspense fallback={PageLoading}>
        <DocsPage subId={hash.slice('#/docs/'.length)} />
      </Suspense>
    )
  } else if (hash === '#/settings') {
    page = <SettingsPage />
  } else if (hash === '#/admin') {
    page = (
      <Suspense fallback={PageLoading}>
        <AdminPage />
      </Suspense>
    )
  } else if (hash === '#/tuner') {
    page = (
      <Suspense fallback={PageLoading}>
        <TunerDemo />
      </Suspense>
    )
  } else if (hash === '#/rhythm') {
    page = (
      <Suspense fallback={PageLoading}>
        <RhythmDemo />
      </Suspense>
    )
  } else {
    page = <HomePage />
  }

  return (
    <div className="app">
      <header className="topbar">
        <a className="brand" href="#/">
          🎵 音乐练习 <small>UGC POC</small>
        </a>
        <nav>
          <a href="#/" className={hash === '' || hash === '#/' || hash === '#' ? 'active' : ''}>
            首页
          </a>
          <a href="#/library" className={hash === '#/library' ? 'active' : ''}>
            资源库
          </a>
          <a href="#/docs" className={hash.startsWith('#/docs') ? 'active' : ''}>
            文档
          </a>
          <a href="#/tuner" className={hash === '#/tuner' ? 'active' : ''}>
            校音器
          </a>
          <a href="#/rhythm" className={hash === '#/rhythm' ? 'active' : ''}>
            节奏
          </a>
          <a href="#/settings" className={hash === '#/settings' ? 'active' : ''} title="AI 接入等设置">
            ⚙ 设置
          </a>
        </nav>
        {account.user && (
          <a className="topbar-user" href="#/settings" title="账户设置">
            👤 {account.user.nickname}
          </a>
        )}
      </header>
      <main>{page}</main>
    </div>
  )
}
