/**
 * 关卡运行器（React 薄壳）：所有流程逻辑在 LevelSession 里，本组件只做渲染与挂载。
 * v3：只渲染当前视图的组件（互斥视图）；题面 = 表格当前行的 prompt 列。
 */
import { useEffect, useMemo, useState } from 'react'
import type { LevelDoc, TableRow } from '../engine/level'
import type { Json } from '../engine/expr'
import { LevelSession } from './levelSession'
import { getCtx, playNotes } from './audio'
import { appendRunLog, clearRunLog } from './runLog'
import { ComponentView } from '../components/views'

export function LevelRunner({
  doc,
  levelId,
  onFinished,
}: {
  doc: LevelDoc
  /** 关卡 id：运行日志按它持久化（节点图编辑页读取展示） */
  levelId: string
  /** 结算回调（每关完成时一次）：供宿主存进度等 */
  onFinished?: (result: { score: Json; passed: boolean }) => void
}) {
  const [runKey, setRunKey] = useState(0)
  return (
    <RunnerCore
      key={runKey}
      doc={doc}
      levelId={levelId}
      onRetry={() => setRunKey((k) => k + 1)}
      onFinished={onFinished}
    />
  )
}

/** 题面文本：prompt 列支持对象 {text} 或纯字符串两种形态 */
function promptText(row: TableRow | null): string {
  const p = row?.prompt
  if (typeof p === 'string') return p
  if (p !== null && typeof p === 'object' && !Array.isArray(p)) {
    const t = (p as Record<string, Json>).text
    if (typeof t === 'string') return t
  }
  return ''
}

function RunnerCore({
  doc,
  levelId,
  onRetry,
  onFinished,
}: {
  doc: LevelDoc
  levelId: string
  onRetry: () => void
  onFinished?: (result: { score: Json; passed: boolean }) => void
}) {
  const firstView = doc.content.views[0]?.id ?? 'main'
  const [progress, setProgress] = useState({ index: 0, total: doc.content.table.rows.length })
  const [finished, setFinished] = useState<{ score: Json; passed: boolean } | null>(null)
  const [row, setRow] = useState<TableRow | null>(null)
  const [view, setView] = useState(firstView)

  const session = useMemo(
    () =>
      new LevelSession(doc, {
        onRow: (index, total, r) => {
          setProgress({ index, total })
          setRow(r)
        },
        onView: (id) => setView(id),
        onFinished: (result) => {
          setFinished(result)
          onFinished?.(result)
        },
        runEffects: (effects) => {
          for (const eff of effects) {
            if (eff.type === 'audio.play') playNotes(eff.notes, eff.tempo, eff.mode)
          }
        },
        getNowSeconds: () => getCtx().currentTime,
        onLogicEvent: (e) => appendRunLog(levelId, e),
      }),
    [doc, onFinished, levelId],
  )

  useEffect(() => {
    clearRunLog(levelId) // 「最近一次试运行」语义：每次进入/重开清掉上一轮日志
    session.start()
    return () => session.dispose()
  }, [session])

  const visibleComps = doc.content.components.filter((c) => (c.view ?? firstView) === view)

  return (
    <div className="level-runner">
      <div className="level-head">
        <span className="level-title">{String(doc.meta.title ?? '未命名关卡')}</span>
        {promptText(row) && <span className="level-prompt">{promptText(row)}</span>}
        <span className="level-progress">
          第 {Math.min(progress.index + 1, progress.total)} / {progress.total} 题
        </span>
      </div>
      <div className="level-canvas-wrap">
        <div className="level-canvas">
          {visibleComps.map((c) => (
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
