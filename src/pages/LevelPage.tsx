import { useCallback, useMemo } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { db, saveProgress } from '../library/db'
import type { LevelDoc } from '../engine/level'
import type { LevelDocV4 } from '../engine/v4/model'
import { ErrorBoundary } from '../library/ErrorBoundary'
import { loadLevelDoc, loadLevelDocV4 } from '../library/validate'
import { LevelRunner } from '../runtime/LevelRunner'
import { LevelRunnerV4 } from '../runtime/v4/LevelRunnerV4'
import { getAccountSnapshot } from '../account/store'
import { pushProgress } from '../cloud/progress'


export function LevelPage({ id }: { id: string }) {
  const record = useLiveQuery(
    async () => (await db.resources.get(id)) ?? null,
    [id],
    'loading',
  )

  // hooks 必须在任何条件返回之前：结算回调按 id 稳定（避免 session 重建）
  const handleFinished = useCallback(
    (result: { score: unknown; passed: boolean }) => {
      void saveProgress(id, { score: Number(result.score) || 0, passed: result.passed }).then((record) => {
        // 云端上报（批次 B3）：登录态才发，fire-and-forget 失败静默——本地已落库
        const snap = getAccountSnapshot()
        if (snap.phase === 'available' && snap.user) void pushProgress(record)
      })
    },
    [id],
  )

  // v4 分发（docs/52 W3.3）：按 schemaVersion 选装载管线与播放层；useMemo 稳定 doc 引用，
  // 避免 Dexie 每次重查触发 LevelRunnerV4 重建会话（v4 session effect 依赖 doc 引用）。
  // hooks 必须在早退之前；v3 分支原样保留（W9 翻转后删除）。
  const v4Load = useMemo(() => {
    if (record === 'loading' || record === null) return null
    const source = record.doc as { schemaVersion?: unknown }
    return source.schemaVersion === 4 ? loadLevelDocV4(record.doc) : null
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

  // v4 分支：放在 v3 loadLevelDoc 之前，避免 v4 文档被 v3 装载管线拒绝
  if (v4Load) {
    if (!v4Load.ok) {
      return (
        <div className="page">
          <header className="page-head">
            <div>
              <h1>关卡无法加载</h1>
              <p className="page-sub">该 v4 文档未通过装载校验，请回编辑器检查或重新导入。</p>
            </div>
            <div className="page-actions">
              <a className="button-like" href="#/library">
                返回资源库
              </a>
            </div>
          </header>
          <div className="boundary-error">
            <ul className="tone-error">
              {v4Load.errors.map((e, i) => (
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
    const v4doc: LevelDocV4 = v4Load.doc
    return (
      <div className="page level-page">
        <div className="theater">
          <div className="theater-top">
            <a className="theater-back" href="#/">
              ← 返回
            </a>
            <b className="theater-title">{v4doc.meta.title}</b>
            {/* v4 的 #/graph 入口待 W6 图工作台落地后接入；当前 GraphEditor 仅支持 v3 IR */}
          </div>
          {v4Load.lintWarnings.length > 0 && (
            <details className="json-view theater-note">
              <summary className="tone-error">⚠ 逻辑 lint 告警（{v4Load.lintWarnings.length}）</summary>
              <ul className="muted">
                {v4Load.lintWarnings.map((w, i) => (
                  <li key={i}>{w}</li>
                ))}
              </ul>
            </details>
          )}
          <ErrorBoundary>
            <LevelRunnerV4 doc={v4doc} levelId={id} onFinished={handleFinished} />
          </ErrorBoundary>
          <details className="json-view theater-note">
            <summary>查看本关卡的 JSON 定义（内容即关卡）</summary>
            <pre>{JSON.stringify(record.doc, null, 2)}</pre>
          </details>
        </div>
      </div>
    )
  }

  // 装载管线：信封 schema → schemaVersion → 逻辑 lint（警告不阻断）
  const load = loadLevelDoc(record.doc)
  if (!load.ok) {
    return (
      <div className="page">
        <header className="page-head">
          <div>
            <h1>关卡无法加载</h1>
            <p className="page-sub">该文档未通过装载校验，请回编辑器检查或重新导入。</p>
          </div>
          <div className="page-actions">
            <a className="button-like" href="#/library">
              返回资源库
            </a>
          </div>
        </header>
        <div className="boundary-error">
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
    <div className="page level-page">
      <div className="theater">
        <div className="theater-top">
          <a className="theater-back" href="#/">
            ← 返回
          </a>
          <b className="theater-title">{String((doc.meta as { title?: unknown })?.title ?? '关卡')}</b>
          <a className="theater-graph" href={`#/graph/${id}`}>
            🧭 逻辑图谱
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
          <LevelRunner doc={doc} levelId={id} onFinished={handleFinished} />
        </ErrorBoundary>
        <details className="json-view theater-note">
          <summary>查看本关卡的 JSON 定义（内容即关卡）</summary>
          <pre>{JSON.stringify(doc, null, 2)}</pre>
        </details>
      </div>
    </div>
  )
}
