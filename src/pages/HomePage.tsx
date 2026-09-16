import type { LevelDoc } from '../engine/level'

export function HomePage({ levels }: { levels: Record<string, LevelDoc> }) {
  return (
    <div className="page">
      <section className="hero">
        <h1>音乐练习 · UGC 平台原型</h1>
        <p>
          关卡 = 组件 + 逻辑规则 + 题目数据，全部由 JSON 定义。下面的关卡没有一行硬编码 UI 逻辑——
          判定、计分、反馈都写在关卡文档的 <code>logic.rules</code> 里（事件→条件→动作）。
        </p>
      </section>

      <h2>示例关卡</h2>
      <div className="cards">
        {Object.entries(levels).map(([id, doc]) => {
          const diff = Math.min(5, Math.max(1, Number(doc.meta.difficulty) || 1))
          return (
            <a key={id} className="card" href={`#/level/${id}`}>
              <div className="card-kind">关卡 · {'★'.repeat(diff)}</div>
              <h3>{String(doc.meta.title)}</h3>
              <p>{String(doc.meta.description ?? '')}</p>
              <div className="tags">
                {(Array.isArray(doc.meta.tags) ? (doc.meta.tags as string[]) : []).map((t) => (
                  <span key={t} className="tag">
                    {t}
                  </span>
                ))}
              </div>
              <div className="card-meta">
                {doc.content.components.length} 个组件 · {doc.content.logic.rules.length} 条规则 ·{' '}
                {doc.content.questions.length} 道题
              </div>
            </a>
          )
        })}
      </div>

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
