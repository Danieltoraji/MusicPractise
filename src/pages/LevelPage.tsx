import { LevelRunner } from '../runtime/LevelRunner'
import type { LevelDoc } from '../engine/level'

export function LevelPage({ doc }: { doc: LevelDoc }) {
  return (
    <div className="page">
      <div className="breadcrumb">
        <a href="#/">← 返回首页</a>
      </div>
      <LevelRunner doc={doc} />
      <details className="json-view">
        <summary>查看本关卡的 JSON 定义（内容即关卡）</summary>
        <pre>{JSON.stringify(doc, null, 2)}</pre>
      </details>
    </div>
  )
}
