import { useCallback } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { db, saveProgress } from '../library/db'
import type { LevelDoc } from '../engine/level'
import { ErrorBoundary } from '../library/ErrorBoundary'
import { loadLevelDoc } from '../library/validate'
import { LevelRunner } from '../runtime/LevelRunner'


export function LevelPage({ id }: { id: string }) {
  const record = useLiveQuery(
    async () => (await db.resources.get(id)) ?? null,
    [id],
    'loading',
  )

  // hooks 必须在任何条件返回之前：结算回调按 id 稳定（避免 session 重建）
  const handleFinished = useCallback(
    (result: { score: unknown; passed: boolean }) => {
      void saveProgress(id, { score: Number(result.score) || 0, passed: result.passed })
    },
    [id],
  )

  if (record === 'loading') return <p className="muted page">从资源库加载…</p>
  if (record === null) {
    return (
      <div className="page">
        <div className="breadcrumb">
          <a href="#/">← 返回首页</a>
        </div>
        <p className="muted">资源库中没有这个关卡（id: {id}）。到<a href="#/library">资源库</a>导入试试。</p>
      </div>
    )
  }

  // 装载管线：信封 schema → schemaVersion → 逻辑 lint（警告不阻断）
  const load = loadLevelDoc(record.doc)
  if (!load.ok) {
    return (
      <div className="page">
        <div className="breadcrumb">
          <a href="#/">← 返回首页</a>
        </div>
        <div className="boundary-error">
          <h2>该文档未通过装载校验</h2>
          <ul className="tone-error">
            {load.errors.map((e, i) => (
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
  const doc = load.doc as unknown as LevelDoc

  return (
    <div className="page">
      <div className="breadcrumb">
        <a href="#/">← 返回首页</a> · <a href={`#/graph/${id}`}>🧭 逻辑图谱</a>
      </div>
      {load.lintWarnings.length > 0 && (
        <details className="json-view">
          <summary className="tone-error">⚠ 逻辑 lint 告警（{load.lintWarnings.length}）</summary>
          <ul className="muted">
            {load.lintWarnings.map((w, i) => (
              <li key={i}>{w}</li>
            ))}
          </ul>
        </details>
      )}
      <ErrorBoundary>
        <LevelRunner doc={doc} onFinished={handleFinished} />
      </ErrorBoundary>
      <details className="json-view">
        <summary>查看本关卡的 JSON 定义（内容即关卡）</summary>
        <pre>{JSON.stringify(doc, null, 2)}</pre>
      </details>
    </div>
  )
}
