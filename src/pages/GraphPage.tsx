/**
 * 关卡逻辑图谱页：库内关卡的 LogicProgram 只读节点图 + 变量/规则摘要。
 */
import { useLiveQuery } from 'dexie-react-hooks'
import { db, type LibraryRecord } from '../library/db'
import type { LevelDoc } from '../engine/level'
import { ErrorBoundary } from '../library/ErrorBoundary'
import LogicGraph from '../graph/LogicGraph'

export function GraphPage({ id }: { id: string }) {
  const record = useLiveQuery(async () => (await db.resources.get(id)) ?? null, [id], 'loading')

  if (record === 'loading') return <p className="muted page">从资源库加载…</p>
  if (record === null || (record as LibraryRecord).kind !== 'level') {
    return (
      <div className="page">
        <div className="breadcrumb"><a href="#/">← 返回首页</a></div>
        <p className="muted">资源库中没有这个关卡（id: {id}）。</p>
      </div>
    )
  }

  const doc = (record as LibraryRecord).doc as unknown as LevelDoc
  const varEntries = Object.entries(doc.content.logic.variables ?? {})

  return (
    <div className="page">
      <div className="breadcrumb"><a href="#/">← 返回首页</a> · <a href={`#/level/${id}`}>试玩此关</a> · <a href={`#/edit/${id}`}>编辑此关</a></div>
      <h1>🧭 逻辑图谱 · {String(doc.meta.title ?? '')}</h1>
      <p className="muted">
        只读视图：⚡ 事件 → 规则（含条件）→ 动作；绿色实线为变量写入，虚线为触发/读取。拖动平移、滚轮缩放。
      </p>
      <ErrorBoundary>
        <LogicGraph program={doc.content.logic} height={560} />
      </ErrorBoundary>

      <h2>变量（{varEntries.length}）</h2>
      {varEntries.length === 0 ? (
        <p className="muted">本关没有声明变量。</p>
      ) : (
        <table className="library-table">
          <thead>
            <tr><th>变量</th><th>初始值</th></tr>
          </thead>
          <tbody>
            {varEntries.map(([name, value]) => (
              <tr key={name}>
                <td>v.{name}</td>
                <td>{JSON.stringify(value)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <h2>规则（{doc.content.logic.rules.length} 条）</h2>
      <ul>
        {doc.content.logic.rules.map((r) => (
          <li key={r.id}>
            <b>{r.id}</b> · on {r.on} · {r.when?.length ?? 0} 条件 · {r.do.length} 动作
            {r.else && r.else.length > 0 ? ` · else ${r.else.length} 动作` : ''}
          </li>
        ))}
      </ul>
    </div>
  )
}
