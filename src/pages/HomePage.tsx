import { useLiveQuery } from 'dexie-react-hooks'
import { db, type ProgressRecord } from '../library/db'
import { partitionLevels } from '../library/browse'
import type { LevelDoc } from '../engine/level'
import { ErrorBoundary } from '../library/ErrorBoundary'

function diffStars(doc: LevelDoc): string {
  const diff = Math.min(5, Math.max(1, Number(doc.meta.difficulty) || 1))
  return '★'.repeat(diff)
}

function ProgressBadge({ levelId, progress }: { levelId: string; progress: ProgressRecord[] }) {
  const p = progress.find((x) => x.levelId === levelId)
  if (!p) return null
  return p.passed === 1 ? (
    <span className="badge pass">✅ 通过</span>
  ) : (
    <span className="badge">最佳 {p.bestScore}</span>
  )
}

export function HomePage() {
  const series = useLiveQuery(() => db.resources.where('kind').equals('series').toArray(), [], undefined)
  const topics = useLiveQuery(() => db.resources.where('kind').equals('topic').toArray(), [], undefined)
  const levels = useLiveQuery(() => db.resources.where('kind').equals('level').toArray(), [], undefined)
  const progress = useLiveQuery(() => db.progress.toArray(), [], undefined)

  // undefined = 查询未完成（loading），与"查询完成但为空"区分，避免闪现空态文案
  if (series === undefined || topics === undefined || levels === undefined || progress === undefined) {
    return (
      <div className="page">
        <p className="muted">加载中…</p>
      </div>
    )
  }

  const { independent } = partitionLevels(levels, topics)

  return (
    <div className="page">
      <section className="hero">
        <h1>音乐练习 · UGC 平台原型</h1>
        <p>
          关卡 = 组件 + 逻辑规则 + 题目数据，全部由 JSON 定义。判定、计分、反馈都写在关卡文档的{' '}
          <code>logic</code> 图程序里（事件→节点→动作，可编辑节点图与伪代码）。内容存放在浏览器本地资源库，可在
          <a href="#/library"> 资源库 </a>中导入导出。
        </p>
      </section>

      <h2>系列</h2>
      {series.length === 0 ? (
        <p className="muted">还没有系列。可在<a href="#/library">资源库</a>导入系列包（zip）。</p>
      ) : (
        <div className="cards">
          {series.map((rec) => {
            const doc = rec.doc as { meta?: { title?: unknown; description?: unknown } }
            const topicCount = ((doc as { content?: { topicIds?: unknown[] } }).content?.topicIds ?? []).length
            return (
              <a key={rec.id} className="card" href={`#/series/${rec.id}`}>
                <div className="card-kind">📚 系列 · {topicCount} 个专题</div>
                <h3>{String(doc.meta?.title ?? rec.title)}</h3>
                <p>{String(doc.meta?.description ?? '')}</p>
              </a>
            )
          })}
        </div>
      )}

      <h2>独立关卡</h2>
      <ErrorBoundary>
        {independent.length === 0 ? (
          <p className="muted">没有独立关卡——所有关卡都已归入系列。</p>
        ) : (
          <div className="cards">
            {independent.map((rec) => {
              const doc = rec.doc as unknown as LevelDoc
              return (
                <a key={rec.id} className="card" href={`#/level/${rec.id}`}>
                  <div className="card-kind">
                    关卡 · {diffStars(doc)} {rec.builtIn ? '' : '· 导入'}
                  </div>
                  <h3>
                    {String(doc.meta.title)} <ProgressBadge levelId={rec.id} progress={progress} />
                  </h3>
                  <p>{String(doc.meta.description ?? '')}</p>
                  <div className="card-meta">
                    {doc.content.components.length} 个组件 · {doc.content.questions.length} 道题
                  </div>
                </a>
              )
            })}
          </div>
        )}
      </ErrorBoundary>

      <h2>风险验证 Demo</h2>
      <div className="cards">
        <a className="card" href="#/tuner">
          <div className="card-kind">技术验证</div>
          <h3>校音器（频率计）</h3>
          <p>麦克风输入 → McLeod 音高检测 → 音名与音分偏差实时显示（pitchy）。</p>
        </a>
        <a className="card" href="#/rhythm">
          <div className="card-kind">技术验证</div>
          <h3>节奏判定</h3>
          <p>WebAudio 时钟调度节拍器 + tap 采集 + 容差判定（rhythmMatch 纯函数）。</p>
        </a>
      </div>
    </div>
  )
}
