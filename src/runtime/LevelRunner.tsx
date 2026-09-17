/**
 * 关卡运行器（React 薄壳）：所有流程逻辑在 LevelSession 里，本组件只做渲染与挂载。
 */
import { useEffect, useMemo, useState } from 'react'
import type { LevelDoc, Question } from '../engine/level'
import type { Json } from '../engine/expr'
import { LevelSession } from './levelSession'
import { getCtx, playNotes } from './audio'
import { ComponentView } from '../components/views'

export function LevelRunner({ doc }: { doc: LevelDoc }) {
  const [runKey, setRunKey] = useState(0)
  return <RunnerCore key={runKey} doc={doc} onRetry={() => setRunKey((k) => k + 1)} />
}

function RunnerCore({ doc, onRetry }: { doc: LevelDoc; onRetry: () => void }) {
  const [progress, setProgress] = useState({ index: 0, total: doc.content.questions.length })
  const [finished, setFinished] = useState<{ score: Json; passed: boolean } | null>(null)
  const [question, setQuestion] = useState<Question | null>(null)

  const session = useMemo(
    () =>
      new LevelSession(doc, {
        onQuestion: (index, total, q) => {
          setProgress({ index, total })
          setQuestion(q)
        },
        onFinished: (result) => setFinished(result),
        runEffects: (effects) => {
          for (const eff of effects) {
            if (eff.type === 'audio.play') playNotes(eff.notes, eff.tempo, eff.mode)
          }
        },
        getNowSeconds: () => getCtx().currentTime,
      }),
    [doc],
  )

  useEffect(() => {
    session.start()
    return () => session.dispose()
  }, [session])

  return (
    <div className="level-runner">
      <div className="level-head">
        <span className="level-title">{String(doc.meta.title ?? '未命名关卡')}</span>
        {question?.prompt?.text && <span className="level-prompt">{question.prompt.text}</span>}
        <span className="level-progress">
          第 {Math.min(progress.index + 1, progress.total)} / {progress.total} 题
        </span>
      </div>
      <div className="level-canvas-wrap">
        <div className="level-canvas">
          {doc.content.components.map((c) => (
            <ComponentView key={c.id} spec={c} store={session.store} emit={session.emitFor(c.id)} />
          ))}
        </div>
      </div>
      <div className="level-foot">
        {finished ? (
          <span className={finished.passed ? 'pass' : 'nopass'}>
            已完成 · 得分 {String(finished.score)} · {finished.passed ? '通过 🎉' : '未通过'}
          </span>
        ) : (
          <button type="button" className="link" onClick={onRetry}>
            重开本关
          </button>
        )}
      </div>
    </div>
  )
}
