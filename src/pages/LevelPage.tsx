/**
 * 关卡游玩页（v4，W9 后唯一路径）：资源库记录 → loadLevelDoc（v4 唯一管线）→ LevelRunnerV4。
 * 结算回调保存进度（本地最高分/尝试次数）并在登录态 fire-and-forget 云同步。
 */
import { useCallback, useMemo } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { db, saveProgress } from '../library/db'
import type { LevelDocV4 } from '../engine/v4/model'
import { ErrorBoundary } from '../library/ErrorBoundary'
import { loadLevelDoc } from '../library/validate'
import { LevelRunnerV4 } from '../runtime/v4/LevelRunnerV4'
import { getAccountSnapshot } from '../account/store'
import { pushProgress } from '../cloud/progress'

export function LevelPage({ id }: { id: string }) {
  const record = useLiveQuery(async () => (await db.resources.get(id)) ?? null, [id], 'loading')

  // hooks 必须在任何条件返回之前：结算回调按 id 稳定（避免 session 重建）
  const handleFinished = useCallback(
    (result: { score: unknown; passed: boolean }) => {
      void saveProgress(id, { score: Number(result.score) || 0, passed: result.passed }).then((record) => {
        // 云端上报：登录态才发，fire-and-forget 失败静默——本地已落库
        const snap = getAccountSnapshot()
        if (snap.phase === 'available' && snap.user) void pushProgress(record)
      })
    },
    [id],
  )

  // 文档装载（v4）：Dexie 重查可能返回新对象，useMemo 稳定 doc 引用，避免播放会话重建
  const load = useMemo(() => {
    if (record === 'loading' || record === null) return null
    return loadLevelDoc(record.doc)
  }, [record])

  if (record === 'loading') {
    return (
      <div className="page level-page">
        <div className="theater theater-empty">
          <p className="muted">从资源库加载…</p>
        </div>
      </div>
    )
  }
  if (record === null) {
    return (
      <div className="page">
        <header className="page-head">
          <div>
            <h1>关卡不存在</h1>
            <p className="page-sub">
              资源库中没有这个关卡（id: {id}）。到<a href="#/library">资源库</a>导入试试，
              或<a href="#/">返回首页</a>。
            </p>
          </div>
        </header>
      </div>
    )
  }
  if (load === null || !load.ok) {
    const errors = load && !load.ok ? load.errors : ['关卡文档无效']
    return (
      <div className="page">
        <header className="page-head">
          <div>
            <h1>关卡无法加载</h1>
            <p className="page-sub">该文档未通过 v4 装载校验，请回编辑器检查或重新导入。</p>
          </div>
          <div className="page-actions">
            <a className="button-like" href="#/library">
              返回资源库
            </a>
          </div>
        </header>
        <div className="boundary-error">
          <ul className="tone-error">
            {errors.map((e, i) => (
              <li key={i}>{e}</li>
            ))}
          </ul>
          <details className="json-view">
            <summary>查看原始 JSON</summary>
            <pre>{JSON.stringify(record.doc, null, 2)}</pre>
          </details>
        </div>
      </div>
    )
  }
  const doc: LevelDocV4 = load.doc

  return (
    <div className="page level-page">
      <div className="theater">
        <div className="theater-top">
          <a className="theater-back" href="#/">
            ← 返回
          </a>
          <b className="theater-title">{doc.meta.title}</b>
          <a className="theater-graph" href={`#/edit/${id}`}>
            ✏ 编辑
          </a>
        </div>
        {load.lintWarnings.length > 0 && (
          <details className="json-view theater-note">
            <summary className="tone-error">⚠ 逻辑 lint 告警（{load.lintWarnings.length}）</summary>
            <ul className="muted">
              {load.lintWarnings.map((w, i) => (
                <li key={i}>{w}</li>
              ))}
            </ul>
          </details>
        )}
        <ErrorBoundary>
          <LevelRunnerV4 doc={doc} levelId={id} onFinished={handleFinished} />
        </ErrorBoundary>
        <details className="json-view theater-note">
          <summary>查看本关卡的 JSON 定义（内容即关卡）</summary>
          <pre>{JSON.stringify(doc, null, 2)}</pre>
        </details>
      </div>
    </div>
  )
}
