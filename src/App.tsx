import { useEffect, useState } from 'react'
import { unlockAudio } from './runtime/audio'
import { HomePage } from './pages/HomePage'
import { LevelPage } from './pages/LevelPage'
import { LibraryPage } from './pages/LibraryPage'
import { SeriesPage } from './pages/SeriesPage'
import { GraphPage } from './pages/GraphPage'
import { EditorPage } from './editor/EditorPage'
import { TunerDemo } from './pages/TunerDemo'
import { RhythmDemo } from './pages/RhythmDemo'
import { ensureSeeded } from './library/db'

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

  // 首次启动把内置示例关卡入库；此后一切内容只从库读取
  useEffect(() => {
    setSeedError('')
    ensureSeeded().then(
      () => setSeeded(true),
      (err) => setSeedError(String(err instanceof Error ? err.message : err)),
    )
  }, [seedAttempt])

  // 浏览器自动播放策略：首次手势解锁 AudioContext
  useEffect(() => {
    const unlock = () => unlockAudio()
    window.addEventListener('pointerdown', unlock, { once: true })
    window.addEventListener('keydown', unlock, { once: true })
    return () => {
      window.removeEventListener('pointerdown', unlock)
      window.removeEventListener('keydown', unlock)
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
    page = <GraphPage key={hash} id={hash.slice('#/graph/'.length)} />
  } else if (hash.startsWith('#/edit/')) {
    page = <EditorPage key={hash} id={hash.slice('#/edit/'.length)} />
  } else if (hash === '#/library') {
    page = <LibraryPage />
  } else if (hash === '#/tuner') {
    page = <TunerDemo />
  } else if (hash === '#/rhythm') {
    page = <RhythmDemo />
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
          <a href="#/tuner" className={hash === '#/tuner' ? 'active' : ''}>
            校音器
          </a>
          <a href="#/rhythm" className={hash === '#/rhythm' ? 'active' : ''}>
            节奏
          </a>
        </nav>
      </header>
      <main>{page}</main>
    </div>
  )
}
