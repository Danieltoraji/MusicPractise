import { useLiveQuery } from 'dexie-react-hooks'
import { db, type ProgressRecord } from '../library/db'
import { partitionLevels, readLevelDoc } from '../library/browse'
import type { LevelDoc } from '../engine/level'
import { ErrorBoundary } from '../library/ErrorBoundary'

function diffStars(doc: LevelDoc | null): string {
  const diff = Math.min(5, Math.max(1, Number(doc?.meta.difficulty) || 1))
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

function CountChip({ n }: { n: number }) {
  return n > 0 ? <span className="count-chip">{n}</span> : null
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
      {/* 品牌横幅（docs/36 §2.4）：玩家视角一句话 + 快捷入口 */}
      <section className="hero">
        <h1>音乐练习</h1>
        <p>
          听音记谱、节奏训练、校音与乐理关卡——由社区创作，打开即玩。全部内容存放在你的浏览器本地资源库，
          也可在<a href="#/library">资源库</a>导入分享的关卡包。
        </p>
        <div className="hero-actions">
          <a className="hero-btn" href="#/library">
            📚 浏览资源库
          </a>
          <a className="hero-btn hero-btn-ghost" href="#/docs">
            📖 新手指南
          </a>
        </div>
      </section>

      <h2>
        系列 <CountChip n={series.length} />
      </h2>
      {series.length === 0 ? (
        <p className="muted">还没有系列。可在<a href="#/library">资源库</a>导入系列包（zip）。</p>
      ) : (
        <div className="cards">
          {series.map((rec) => {
            const doc = rec.doc as { meta?: { title?: unknown; description?: unknown } }
            const topicCount = ((doc as { content?: { topicIds?: unknown[] } }).content?.topicIds ?? []).length
            return (
              <a key={rec.id} className="card series-card" href={`#/series/${rec.id}`}>
                <span className="series-glyph" aria-hidden>
                  📚
                </span>
                <div className="card-kind">系列 · {topicCount} 个专题</div>
                <h3>{String(doc.meta?.title ?? rec.title)}</h3>
                <p>{String(doc.meta?.description ?? '')}</p>
                <div className="card-meta">
                  <span>进入系列</span>
                  <span className="card-more" aria-hidden>
                    →
                  </span>
                </div>
              </a>
            )
          })}
        </div>
      )}

      <h2>
        独立关卡 <CountChip n={independent.length} />
      </h2>
      <ErrorBoundary>
        {independent.length === 0 ? (
          <p className="muted">没有独立关卡——所有关卡都已归入系列。</p>
        ) : (
          <div className="cards">
            {independent.map((rec) => {
              // 库记录可能是 v1/v2 旧格式：经迁移读取；毒数据降级为最小卡（绝不白屏）
              const doc = readLevelDoc(rec)
              const meta = doc?.meta as { title?: unknown; description?: unknown } | undefined
              return (
                <a key={rec.id} className="card level-card" href={`#/level/${rec.id}`}>
                  <div className="card-kind">
                    <span className="level-stars" title={`难度 ${diffStars(doc)}`}>
                      {diffStars(doc)}
                    </span>
                    {rec.builtIn ? <span className="badge">内置</span> : <span className="badge">导入</span>}
                  </div>
                  <h3>{String(meta?.title ?? rec.title)}</h3>
                  <p>{String(meta?.description ?? '')}</p>
                  <div className="card-meta">
                    <span>
                      {doc
                        ? `${doc.content.components.length} 个组件 · ${doc.content.table.rows.length} 道题`
                        : '文档格式无法解析——可在资源库导出排查'}
                    </span>
                    <ProgressBadge levelId={rec.id} progress={progress} />
                  </div>
                </a>
              )
            })}
          </div>
        )}
      </ErrorBoundary>

      <h2>工具</h2>
      <div className="cards">
        <a className="card" href="#/tuner">
          <div className="card-kind">技术验证</div>
          <h3>🎯 校音器</h3>
          <p>麦克风输入 → 音名与音分偏差实时显示。</p>
        </a>
        <a className="card" href="#/rhythm">
          <div className="card-kind">技术验证</div>
          <h3>🥁 节奏判定</h3>
          <p>跟随节拍敲击，按相对起拍的偏差打分。</p>
        </a>
        <a className="card" href="#/settings">
          <div className="card-kind">设置</div>
          <h3>⚙️ AI 接入</h3>
          <p>为编辑器的 AI 辅助功能配置任意供应商的 API Key（仅存本机）。</p>
        </a>
      </div>
    </div>
  )
}
