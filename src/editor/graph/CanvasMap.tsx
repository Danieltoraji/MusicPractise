/**
 * 画布对照小图（3-5）：节点图编辑页角落的关卡画布缩略图。
 * 组件框按画布布局等比缩放、标注名称；点击组件 → 高亮节点图中引用它的节点
 * （on 该组件事件 / call 它 / assign 查询它），接线时不用来回翻页对 id。
 * 纯展示组件：布局计算在渲染期 memo，不持有可变状态。
 */
import { useMemo } from 'react'
import type { ComponentInstance } from '../../engine/level'
import { getDef } from '../../runtime/store'

const CAT_COLOR: Record<string, string> = {
  music: '#8b5cf6',
  ui: '#0ea5e9',
  hidden: '#94a3b8',
}

const BODY_W = 216
const BODY_H = 150
const PAD = 10

function catColor(type: string): string {
  try {
    return CAT_COLOR[getDef(type).contract.category] ?? '#94a3b8'
  } catch {
    return '#94a3b8'
  }
}

export function CanvasMap(props: {
  comps: ComponentInstance[]
  focusId: string | null
  onToggleFocus: (id: string) => void
  onClose: () => void
}): React.ReactElement {
  const layout = useMemo(() => {
    const items = props.comps.map((c) => ({ c, l: c.layout ?? { x: 0, y: 0, w: 120, h: 40 } }))
    if (items.length === 0) return null
    let minX = Infinity
    let minY = Infinity
    let maxX = -Infinity
    let maxY = -Infinity
    for (const { l } of items) {
      minX = Math.min(minX, l.x)
      minY = Math.min(minY, l.y)
      maxX = Math.max(maxX, l.x + l.w)
      maxY = Math.max(maxY, l.y + l.h)
    }
    const bw = Math.max(1, maxX - minX)
    const bh = Math.max(1, maxY - minY)
    const scale = Math.min((BODY_W - PAD * 2) / bw, (BODY_H - PAD * 2) / bh, 1)
    return items.map(({ c, l }) => ({
      comp: c,
      box: {
        left: (l.x - minX) * scale + PAD,
        top: (l.y - minY) * scale + PAD,
        width: Math.max(10, l.w * scale),
        height: Math.max(8, l.h * scale),
      },
    }))
  }, [props.comps])

  return (
    <div className="canvas-map">
      <div className="canvas-map-head">
        <b>画布对照</b>
        <button type="button" title="收起" onClick={props.onClose}>
          ×
        </button>
      </div>
      {layout ? (
        <div className="canvas-map-body" style={{ width: BODY_W, height: BODY_H }}>
          {layout.map(({ comp, box }) => (
            <button
              key={comp.id}
              type="button"
              className={`canvas-map-box${props.focusId === comp.id ? ' is-focus' : ''}${comp.visible === false ? ' is-ghost' : ''}`}
              style={{ ...box, borderColor: catColor(comp.type) }}
              title={`${comp.type} · ${comp.id}\n点击高亮节点图中引用它的节点`}
              onClick={() => props.onToggleFocus(comp.id)}
            >
              <span>{comp.name || comp.id}</span>
            </button>
          ))}
        </div>
      ) : (
        <div className="muted canvas-map-empty">画布还没有组件——到「画布」页添加后这里会显示对照图</div>
      )}
      <div className="canvas-map-tip muted">点击组件：高亮图中引用它的节点</div>
    </div>
  )
}
