import { useLiveQuery } from 'dexie-react-hooks'
import { db, type LibraryRecord, type ProgressRecord } from '../library/db'
import { childIds } from '../library/browse'
import type { LevelDoc } from '../engine/level'
import { ErrorBoundary } from '../library/ErrorBoundary'

function diffStars(doc: LevelDoc): string {
  const diff = Math.min(5, Math.max(1, Number(doc.meta.difficulty) || 1))
  return '★'.repeat(diff)
}

type TopicRecord = LibraryRecord | undefined

export function SeriesPage({ id }: { id: string }) {
  // 所有 hooks 前置（Rules of Hooks）：判空在渲染阶段处理
  const seriesRecord = useLiveQuery(
    async () => (await db.resources.get(id)) ?? null,
    [id],
    'loading' as const,
  )
  const topics = useLiveQuery(
    async () => {
      if (!seriesRecord || seriesRecord === 'loading') return [] as TopicRecord[]
      return db.resources.bulkGet(childIds(seriesRecord.doc, 'topicIds'))
    },
    [seriesRecord],
    [] as TopicRecord[],
  )
  const allLevels = useLiveQuery(
    () => db.resources.where('kind').equals('level').toArray(),
    [],
    [] as LibraryRecord[],
  )
  const progress = useLiveQuery(() => db.progress.toArray(), [], [] as ProgressRecord[])

  if (seriesRecord === 'loading') return <p className="muted page">从资源库加载…</p>
  if (seriesRecord === null) {
    return (
      <div className="page">
        <div className="breadcrumb"><a href="#/">← 返回首页</a></div>
        <p className="muted">资源库中没有这个系列（id: {id}）。</p>
      </div>
    )
  }

  const sdoc = seriesRecord.doc as unknown as {
    meta: { title: string; description?: string }
    content: { topicIds: string[] }
  }
  const levelById = new Map(allLevels.map((l) => [l.id, l]))

  return (
    <ErrorBoundary>
      <div className="page">
        <div className="breadcrumb"><a href="#/">← 返回首页</a></div>
        <section className="hero">
          <h1>📚 {sdoc.meta.title}</h1>
          <p>{sdoc.meta.description ?? ''}</p>
        </section>

        {topics.map((topic, ti) => {
          if (!topic) {
            return (
              <div key={`missing-topic-${ti}`} className="level-row missing">
                专题缺件：可到<a href="#/library">资源库</a>导入缺失的专题文档
              </div>
            )
          }
          const tdoc = topic.doc as unknown as {
            meta: { title: string; brief?: string }
            content: { levelIds?: unknown }
          }
          // childIds 自带数组防护：topicIds 误指到非 topic 记录时不致整页崩溃
          const levelIds = childIds(topic.doc, 'levelIds')
          return (
            <section key={topic.id} className="topic-section">
              <h2>📂 {tdoc.meta.title}</h2>
              {tdoc.meta.brief && <p className="muted">{tdoc.meta.brief}</p>}
              <div className="level-rows">
                {levelIds.map((levelId) => {
                  const level = levelById.get(levelId)
                  if (!level) {
                    return (
                      <div key={levelId} className="level-row missing">
                        缺件：{levelId}（可到<a href="#/library">资源库</a>导入）
                      </div>
                    )
                  }
                  const ldoc = level.doc as unknown as LevelDoc
                  const p = progress.find((x) => x.levelId === levelId)
                  return (
                    <a key={levelId} className="level-row" href={`#/level/${levelId}`}>
                      <span className="level-title">
                        {String(ldoc.meta.title)} <span className="muted">{diffStars(ldoc)}</span>
                      </span>
                      <span className="level-side">
                        {p && p.passed === 1 && <span className="badge pass">✅ 通过</span>}
                        {p && p.passed !== 1 && <span className="badge">最佳 {p.bestScore}</span>}
                        <span className="muted">{ldoc.content.table.rows.length} 道题</span>
                      </span>
                    </a>
                  )
                })}
                {levelIds.length === 0 && <div className="level-row missing">该专题没有关卡</div>}
              </div>
            </section>
          )
        })}

        {topics.length === 0 && <p className="muted">这个系列还没有专题。</p>}
      </div>
    </ErrorBoundary>
  )
}
