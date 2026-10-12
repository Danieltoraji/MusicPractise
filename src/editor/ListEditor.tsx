/**
 * 字符串列表弹窗编辑器（数据表 list 列）：单元格点击弹出，条目增删/上下排序，摆脱
 * 窄格内联输入与 JSON 直编。listEntriesFromCell 对任意旧值尽力转为可编辑条目
 * （数字/布尔/对象逐项 JSON 文本化）——类型切换后不再落「编辑 JSON」死胡同。
 */
import { useState } from 'react'

/** 单元格任意 Json 值 → 可编辑字符串条目（尽力转换，永不失败；null/undefined → 空列表） */
export function listEntriesFromCell(v: unknown): string[] {
  if (v === null || v === undefined) return []
  if (typeof v === 'string') return [v]
  if (Array.isArray(v)) return v.map((item) => (typeof item === 'string' ? item : JSON.stringify(item) ?? String(item)))
  if (typeof v === 'object') return [JSON.stringify(v) ?? String(v)]
  return [String(v)]
}

export function ListEditorModal(props: {
  title: string
  value: string[]
  onCommit: (items: string[]) => void
  onClose: () => void
}): React.ReactElement {
  const [items, setItems] = useState<string[]>(props.value)

  const update = (i: number, text: string): void => setItems(items.map((x, j) => (j === i ? text : x)))
  const remove = (i: number): void => setItems(items.filter((_, j) => j !== i))
  const move = (i: number, dir: 1 | -1): void => {
    const j = i + dir
    if (j < 0 || j >= items.length) return
    const next = [...items]
    ;[next[i], next[j]] = [next[j], next[i]]
    setItems(next)
  }
  const add = (): void => {
    setItems([...items, ''])
    // 新条目输入框自动聚焦：新增后最后一个 input 挂载，等一帧再找
    requestAnimationFrame(() => {
      const inputs = document.querySelectorAll<HTMLInputElement>('.tlist-modal .tlist-row input')
      inputs[inputs.length - 1]?.focus()
    })
  }

  return (
    <div
      className="tjson-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) props.onClose()
      }}
    >
      <div className="tjson-modal tlist-modal">
        <div className="tjson-modal-head">
          <b>{props.title}</b>
          <button type="button" onClick={props.onClose}>
            取消
          </button>
          <button type="button" className="primary" onClick={() => props.onCommit(items)}>
            应用
          </button>
        </div>
        <div className="tlist-rows">
          {items.map((it, i) => (
            <div key={i} className="tlist-row">
              <span className="tlist-idx" title={`第 ${i + 1} 项`}>
                {i + 1}
              </span>
              <input
                value={it}
                placeholder="条目内容…"
                onChange={(e) => update(i, e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault()
                    add()
                  }
                  if (e.key === 'Escape') props.onClose()
                }}
              />
              <button type="button" title="上移" disabled={i === 0} onClick={() => move(i, -1)}>
                ↑
              </button>
              <button type="button" title="下移" disabled={i === items.length - 1} onClick={() => move(i, 1)}>
                ↓
              </button>
              <button type="button" className="ginsp-argdel" title="删除条目" onClick={() => remove(i)}>
                ×
              </button>
            </div>
          ))}
          {items.length === 0 && <p className="muted">还没有条目——点「+ 添加条目」创建第一项。</p>}
        </div>
        <div className="tlist-foot">
          <button type="button" onClick={add}>
            + 添加条目
          </button>
          <span className="muted">回车 = 快速添加下一项 · 顺序即选择题选项顺序（choice.setOptions）</span>
        </div>
      </div>
    </div>
  )
}
