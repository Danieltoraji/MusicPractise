import { useLiveQuery } from 'dexie-react-hooks'
import { db } from '../library/db'
import type { LevelDoc } from '../engine/level'
import { ErrorBoundary } from '../library/ErrorBoundary'
import { LevelRunner } from '../runtime/LevelRunner'

export function LevelPage({ id }: { id: string }) {
  const record = useLiveQuery(
    async () => (await db.resources.get(id)) ?? null,
    [id],
    'loading',
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

  const doc = record.doc as unknown as LevelDoc

  return (
    <div className="page">
      <div className="breadcrumb">
        <a href="#/">← 返回首页</a>
      </div>
      <ErrorBoundary>
        <LevelRunner doc={doc} />
      </ErrorBoundary>
      <details className="json-view">
        <summary>查看本关卡的 JSON 定义（内容即关卡）</summary>
        <pre>{JSON.stringify(doc, null, 2)}</pre>
      </details>
    </div>
  )
}
