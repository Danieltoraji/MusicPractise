import { useEffect, useState } from 'react'
import { unlockAudio } from './runtime/audio'
import { HomePage } from './pages/HomePage'
import { LevelPage } from './pages/LevelPage'
import { TunerDemo } from './pages/TunerDemo'
import { RhythmDemo } from './pages/RhythmDemo'
import noteClickDoc from './sample/note-click.level.json'
import theoryChoiceDoc from './sample/theory-choice.level.json'
import melodyDictationDoc from './sample/melody-dictation.level.json'
import timedReactionDoc from './sample/timed-reaction.level.json'
import noteSpellingDoc from './sample/note-spelling.level.json'
import type { LevelDoc } from './engine/level'

const LEVELS: Record<string, LevelDoc> = {
  'note-click': noteClickDoc as unknown as LevelDoc,
  'theory-choice': theoryChoiceDoc as unknown as LevelDoc,
  'melody-dictation': melodyDictationDoc as unknown as LevelDoc,
  'timed-reaction': timedReactionDoc as unknown as LevelDoc,
  'note-spelling': noteSpellingDoc as unknown as LevelDoc,
}

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
  if (hash.startsWith('#/level/')) {
    const id = hash.slice('#/level/'.length)
    const doc = LEVELS[id]
    page = doc ? <LevelPage doc={doc} /> : <p className="muted">关卡不存在</p>
  } else if (hash === '#/tuner') {
    page = <TunerDemo />
  } else if (hash === '#/rhythm') {
    page = <RhythmDemo />
  } else {
    page = <HomePage levels={LEVELS} />
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
