import { lazy, Suspense, useEffect, useState, useSyncExternalStore } from 'react'
import { unlockAudio } from './runtime/audio'
import { HomePage } from './pages/HomePage'
import { LevelPage } from './pages/LevelPage'
import { LibraryPage } from './pages/LibraryPage'
import { SeriesPage } from './pages/SeriesPage'
import { SettingsPage } from './pages/SettingsPage'
import { ensureSeeded } from './library/db'
import { getAccountSnapshot, probeAccount, subscribeAccount } from './account/store'
import { getSkinSnapshot, initSkin, subscribeSkin } from './skin/store'

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
const SkinCenterPage = lazy(() => import('./skin/SkinCenterPage').then((m) => ({ default: m.SkinCenterPage })))
const CloudPage = lazy(() => import('./cloud/CloudPage').then((m) => ({ default: m.CloudPage })))
const HubPage = lazy(() => import('./hub/HubPage').then((m) => ({ default: m.HubPage })))

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
  const skin = useSyncExternalStore(subscribeSkin, getSkinSnapshot)

  // 皮肤装载（docs/35）：读偏好 → 解析本地资产 → data-skin/--user-* 变量；失败不阻塞首屏
  useEffect(() => {
    void initSkin()
  }, [])

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
  } else if (hash === '#/cloud') {
    page = (
      <Suspense fallback={PageLoading}>
        <CloudPage />
      </Suspense>
    )
  } else if (hash === '#/hub') {
    page = (
      <Suspense fallback={PageLoading}>
        <HubPage />
      </Suspense>
    )
  } else if (hash === '#/docs' || hash.startsWith('#/docs/')) {
    page = (
      <Suspense fallback={PageLoading}>
        <DocsPage subId={hash.slice('#/docs/'.length)} />
      </Suspense>
    )
  } else if (hash === '#/skins') {
    page = (
      <Suspense fallback={PageLoading}>
        <SkinCenterPage />
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

  const isHome = hash === '' || hash === '#/' || hash === '#'

  // 主导航：docs/36 §2.2 —— 侧边栏（桌面）/横向 chips（移动端）共用同一份清单
  const NAV: { href: string; ico: string; label: string; active: boolean }[] = [
    { href: '#/', ico: '🏠', label: '首页', active: isHome },
    { href: '#/library', ico: '📚', label: '资源库', active: hash === '#/library' },
    { href: '#/cloud', ico: '☁️', label: '我的云盘', active: hash === '#/cloud' },
    { href: '#/hub', ico: '🎼', label: '关卡库', active: hash === '#/hub' },
    { href: '#/docs', ico: '📄', label: '文档', active: hash.startsWith('#/docs') },
    { href: '#/tuner', ico: '🎯', label: '校音器', active: hash === '#/tuner' },
    { href: '#/rhythm', ico: '🥁', label: '节奏', active: hash === '#/rhythm' },
  ]
  const NAV_FOOT: { href: string; ico: string; label: string; active: boolean }[] = [
    { href: '#/skins', ico: '🎨', label: '皮肤中心', active: hash === '#/skins' },
    { href: '#/settings', ico: '⚙️', label: '设置', active: hash === '#/settings' },
  ]

  return (
    <div className="shell">
      {/* 背景图/水印层（docs/35 §2）：fixed + pointer-events:none，z 序在 body 背景上、内容下，
          不拦截任何交互；「仅首页」范围随路由显隐。图片与透明度由皮肤变量驱动 */}
      {skin.rt.bgUrl && (skin.bg.scope === 'all' || isHome) && <div className="user-bg" aria-hidden="true" />}
      {skin.rt.wmUrl && <div className="watermark" aria-hidden="true" />}
      <aside className="sidenav">
        <a className="sidenav-brand" href="#/" title="音乐练习">
          🎵<b>音乐练习</b>
          <span className="brand-note">UGC 平台</span>
        </a>
        <nav className="sidenav-nav" aria-label="主导航">
          {NAV.map((it) => (
            <a key={it.href} href={it.href} className={`sidenav-item${it.active ? ' active' : ''}`}>
              <span className="ico" aria-hidden>
                {it.ico}
              </span>
              <span>{it.label}</span>
            </a>
          ))}
          <div className="sidenav-gap" role="presentation" />
          {NAV_FOOT.map((it) => (
            <a key={it.href} href={it.href} className={`sidenav-item${it.active ? ' active' : ''}`} title={it.label}>
              <span className="ico" aria-hidden>
                {it.ico}
              </span>
              <span>{it.label}</span>
            </a>
          ))}
        </nav>
        <div className="sidenav-foot">
          {account.user && (
            <a className="sidenav-user" href="#/settings" title="账户设置">
              <span className="ico" aria-hidden>
                👤
              </span>
              <span>{account.user.nickname}</span>
            </a>
          )}
        </div>
      </aside>
      <div className="shell-main">
        <main>{page}</main>
      </div>
    </div>
  )
}
