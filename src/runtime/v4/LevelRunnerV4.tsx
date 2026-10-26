/**
 * v4 关卡运行器（docs/52 W3.2 / docs/53 §11）：
 * `.level-runner` → `.level-head`（`.level-progress`，数据 = session 快照 progress）
 * → `LevelStageV4`（800×470 单次 fit 内 shell+surface）→ `.level-foot`
 * （`.result-bar pass|nopass` 结算：分数 / 重玩 session.restart() / 返回链接）。
 *
 * 职责边界：流程/题目语义全在 V4Session；本组件只负责——
 * - session 生命周期（effect 内 new V4Session → start → cleanup dispose）；
 * - 音频接线（effects 经 audioHost；进关采样预热 preloadV4Audio）；
 * - 运行日志（error 事件写 runlog:<levelId>，与 v3 同键）与 onFinished 透传；
 * - 渲染进度/结算条/重玩（重玩调 session.restart()，不重建会话）。
 */
import { useEffect, useRef, useState } from 'react'
import { EDITOR_HOOKS } from '../../editor/editorHooks'
import type { LevelDocV4, RunResult } from '../../engine/v4/model'
import { appendRunLog, clearRunLog } from '../runLog'
import { LevelStageV4 } from './LevelStageV4'
import { V4Session } from './session'
import { createV4SessionHost, preloadV4Audio, useV4Snapshot } from './sessionHost'

export interface LevelRunnerV4Props {
  doc: LevelDocV4
  /** 关卡 id：运行日志按它持久化（节点图/调试面板读取展示） */
  levelId: string
  /** 结算回调（每轮一次）：宿主保存进度/云同步等 */
  onFinished?(result: RunResult): void
  /** 结算条返回链接（默认回首页） */
  backHref?: string
  backLabel?: string
}

export function LevelRunnerV4({
  doc,
  levelId,
  onFinished,
  backHref = '#/',
  backLabel = '回首页',
}: LevelRunnerV4Props) {
  const [session, setSession] = useState<V4Session | null>(null)
  const snapshot = useV4Snapshot(session)
  // 回调经 ref 转发：父组件重渲染不重建会话（文档内容变化才重建）
  const onFinishedRef = useRef(onFinished)

  useEffect(() => {
    onFinishedRef.current = onFinished
  }, [onFinished])

  useEffect(() => {
    clearRunLog(levelId) // 「最近一次试运行」语义（与 v3 一致）：进入/重开清上一轮日志
    preloadV4Audio(doc) // 采样预热：进关即下载，首击即响（不依赖用户手势）
    const next = new V4Session(
      doc,
      createV4SessionHost({
        onFinished: (result) => {
          onFinishedRef.current?.(result)
        },
        onRunEvent: (event) => {
          // 运行日志只收错误级（RunLogEntry 是 error/command 两类，warning 留在会话内存日志里）
          if (event.kind === 'error') {
            appendRunLog(levelId, { kind: 'error', message: event.message, nodeId: event.nodeId, t: event.t })
          }
        },
      }),
    )
    setSession(next)
    next.start()
    return () => {
      next.dispose()
    }
  }, [doc, levelId])

  const progress = snapshot?.progress ?? { index: 0, total: 0 }
  const result = snapshot?.result ?? null
  const shownIndex = Math.min(progress.index, progress.total)
  const percent = progress.total > 0 ? (shownIndex / progress.total) * 100 : 0

  const restart = (): void => {
    session?.restart()
  }

  return (
    <div className="level-runner">
      <div className="level-head">
        <div
          className="level-progress"
          data-testid="v4-level-progress"
          role="progressbar"
          aria-label="关卡进度"
          aria-valuemin={0}
          aria-valuemax={progress.total}
          aria-valuenow={shownIndex}
        >
          <span className="level-progress-track" aria-hidden="true">
            <i style={{ width: `${percent}%` }} />
          </span>
          <span className="level-progress-text">
            {shownIndex} / {progress.total}
          </span>
        </div>
      </div>
      {session && snapshot ? (
        <LevelStageV4
          session={session}
          snapshot={snapshot}
          viewportClassName="level-canvas-wrap"
          canvasClassName="level-canvas"
        />
      ) : (
        <div className={`${EDITOR_HOOKS.stageViewport} level-canvas-wrap`} aria-hidden="true" />
      )}
      <div className="level-foot">
        {result ? (
          <div
            className={`result-bar ${result.passed ? 'pass' : 'nopass'}`}
            data-testid="v4-result"
            aria-live="polite"
          >
            <span className="result-icon" aria-hidden="true">
              {result.passed ? '🎉' : '💪'}
            </span>
            <span className="result-text">{result.passed ? '通过' : '未通过'}</span>
            <span className="result-score">得分 {result.score}</span>
            <span className="result-actions">
              <button type="button" data-testid="v4-replay" onClick={restart}>
                ↻ 重玩
              </button>
              <a className="button-like" href={backHref}>
                {backLabel}
              </a>
            </span>
          </div>
        ) : (
          <button type="button" className="link" data-testid="v4-restart" onClick={restart}>
            ↻ 重开本关
          </button>
        )}
      </div>
    </div>
  )
}
