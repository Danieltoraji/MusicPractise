/**
 * 关卡逻辑图谱页：库内关卡的 GraphProgram v2 伪代码只读视图 + 变量表。
 * 逻辑一律先透明迁移为 v2（旧 v1 ECA 文档也能查看），LevelScript 文本即图 IR 的投影（docs/12 §6）。
 */
import { useLiveQuery } from 'dexie-react-hooks'
import { db, type LibraryRecord } from '../library/db'
import { lintGraphProgram } from '../engine/graphProgram'
import { migrateDocToV3 } from '../engine/migrateDoc'
import { generateScript } from '../engine/script'
import { ErrorBoundary } from '../library/ErrorBoundary'

export function GraphPage({ id }: { id: string }) {
  const record = useLiveQuery(async () => (await db.resources.get(id)) ?? null, [id], 'loading')

  if (record === 'loading') return <p className="muted page">从资源库加载…</p>
  if (record === null) {
    return (
      <div className="page">
        <div className="breadcrumb"><a href="#/">← 返回首页</a></div>
        <p className="muted">资源库中没有这个关卡（id: {id}）。</p>
      </div>
    )
  }
  if ((record as LibraryRecord).kind !== 'level') {
    return (
      <div className="page">
        <div className="breadcrumb"><a href="#/">← 返回首页</a></div>
        <p className="muted">该资源不是关卡，无法生成逻辑图谱。</p>
      </div>
    )
  }

  const doc = migrateDocToV3((record as LibraryRecord).doc) // 只读视图也走迁移规范化（旧名 question 改写 + 列类型补全）
  const program = doc.content.logic
  const script = generateScript(program)
  const warnings = lintGraphProgram(program)
  const varEntries = Object.entries(program.variables ?? {})

  return (
    <div className="page">
      <div className="breadcrumb"><a href="#/">← 返回首页</a> · <a href={`#/level/${id}`}>试玩此关</a> · <a href={`#/edit/${id}`}>编辑此关</a></div>
      <h1>🧭 关卡脚本 · {String(doc.meta.title ?? '')}</h1>
      <p className="muted">
        只读伪代码视图（LevelScript）：on 事件处理器内的语句即图 IR 的顺序投影；完整节点图编辑器见编辑器「节点图」页。
      </p>
      {warnings.length > 0 && (
        <div className="editor-lint">⚠ lint：{warnings.join('；')}</div>
      )}
      <ErrorBoundary>
        <pre className="script-view">{script}</pre>
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
    </div>
  )
}
