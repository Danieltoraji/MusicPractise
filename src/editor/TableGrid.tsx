/**
 * 题目数据表（3-7 网格化重做）：真表格网格 + 零 JSON 输入。
 * - 列头：列名 / 显示名 / 类型下拉（文本|数字|布尔|音符串|字符串列表|JSON高级）/ 删除；右缘拖拽调列宽
 * - 行头：题号（= v.__row 行号）/ 删除；下缘拖拽调行高
 * - 单元格按列类型渲染专用编辑器：notes → NoteChipsEditor；list → 条目 chips；
 *   json → 高级弹层兜底（仅历史复合列需要，常见类型已结构化）
 * - 列宽/行高为编辑器内存态（不进文档 JSON，会话内保持）
 * 约束延续：单元格受控写回（删行/插行后不残留旧文本，评审 P1-2）。
 */
import { useRef, useState } from 'react'
import type { ColumnType, LevelDoc } from '../engine/level'
import type { Json } from '../engine/expr'
import {
  addTableColumn,
  addTableRow,
  parseJsonText,
  removeTableColumn,
  removeTableRow,
  renameTableColumn,
  setTableColumnType,
  updateTableCell,
  updateTableColumnLabel,
} from './docState'
import { NoteChipsEditor, notesFromCell, notesToCell } from './graph/NoteChipsEditor'

const COLUMN_TYPES: { value: ColumnType; label: string }[] = [
  { value: 'text', label: '文本' },
  { value: 'number', label: '数字' },
  { value: 'boolean', label: '布尔' },
  { value: 'notes', label: '音符串' },
  { value: 'list', label: '字符串列表' },
  { value: 'json', label: 'JSON 高级' },
]

const DEFAULT_COL_W: Record<ColumnType, number> = { text: 180, number: 96, boolean: 72, notes: 260, list: 170, json: 200 }
const DEFAULT_ROW_H = 36
const MIN_COL_W = 64
const MIN_ROW_H = 28

const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err))
const clip = (s: string, n = 60): string => (s.length > n ? `${s.slice(0, n)}…` : s)

/** 单元格 Json 值 → 字符串列表；结构不符返回 null */
function listFromCell(v: unknown): string[] | null {
  if (v === null || v === undefined) return []
  if (!Array.isArray(v)) return null
  const out: string[] = []
  for (const item of v) {
    if (typeof item !== 'string') return null
    out.push(item)
  }
  return out
}

export function TableEditor({ doc, onChange }: { doc: LevelDoc; onChange: (doc: LevelDoc) => void }) {
  const table = doc.content.table
  const [colW, setColW] = useState<Record<string, number>>({})
  const [rowH, setRowH] = useState<Record<number, number>>({})
  const [newCol, setNewCol] = useState('')
  const [colErr, setColErr] = useState('')
  const [jsonCell, setJsonCell] = useState<{ row: number; key: string } | null>(null)
  const colDrag = useRef<{ key: string; startX: number; startW: number } | null>(null)
  const rowDrag = useRef<{ index: number; startY: number; startH: number } | null>(null)

  const widthOf = (key: string, type: ColumnType): number => colW[key] ?? DEFAULT_COL_W[type]
  const heightOf = (index: number): number => rowH[index] ?? DEFAULT_ROW_H

  const addColumn = (): void => {
    const key = newCol.trim()
    try {
      onChange(addTableColumn(doc, key))
      setNewCol('')
      setColErr('')
    } catch (err) {
      setColErr(errText(err))
    }
  }

  const onColResizeDown = (e: React.PointerEvent, key: string, type: ColumnType): void => {
    e.preventDefault()
    e.stopPropagation()
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
    colDrag.current = { key, startX: e.clientX, startW: widthOf(key, type) }
  }
  const onColResizeMove = (e: React.PointerEvent): void => {
    const d = colDrag.current
    if (!d) return
    setColW((cur) => ({ ...cur, [d.key]: Math.max(MIN_COL_W, d.startW + e.clientX - d.startX) }))
  }
  const onColResizeUp = (): void => {
    colDrag.current = null
  }

  const onRowResizeDown = (e: React.PointerEvent, index: number): void => {
    e.preventDefault()
    e.stopPropagation()
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
    rowDrag.current = { index, startY: e.clientY, startH: heightOf(index) }
  }
  const onRowResizeMove = (e: React.PointerEvent): void => {
    const d = rowDrag.current
    if (!d) return
    setRowH((cur) => ({ ...cur, [d.index]: Math.max(MIN_ROW_H, d.startH + e.clientY - d.startY) }))
  }
  const onRowResizeUp = (): void => {
    rowDrag.current = null
  }

  const commitCell = (row: number, key: string, value: Json): void => {
    onChange(updateTableCell(doc, row, { [key]: value }))
  }

  return (
    <div className="questions-editor table-editor">
      <div className="rules-toolbar">
        <b>题目数据表</b>
        <span className="muted">
          每行一道题（行号即 v.__row，q.&lt;列名&gt; 指向当前行）。单元格按列类型结构化编辑，无需手写 JSON；拖列头右缘/行头下缘调宽高。
        </span>
        <button type="button" onClick={() => onChange(addTableRow(doc))}>
          + 添加行
        </button>
      </div>
      {colErr && <div className="tone-error">{colErr}</div>}

      <div className="tgrid-wrap">
        <table className="tgrid">
          <colgroup>
            <col style={{ width: 56 }} />
            {table.columns.map((c) => (
              <col key={c.key} style={{ width: widthOf(c.key, c.type ?? 'text') }} />
            ))}
            <col style={{ width: 150 }} />
          </colgroup>
          <thead>
            <tr>
              <th className="tgrid-corner">#</th>
              {table.columns.map((c) => {
                const type = c.type ?? 'text'
                return (
                  <th key={c.key} className="tgrid-colhead">
                    <div className="tgrid-colhead-row">
                      <input
                        className="tgrid-key"
                        defaultValue={c.key}
                        title={`列名（表达式 q.${c.key}）；改名后表达式旧引用由 lint 提示`}
                        onBlur={(e) => {
                          const key = e.currentTarget.value.trim()
                          if (key === c.key) return
                          try {
                            onChange(renameTableColumn(doc, c.key, key))
                          } catch (err) {
                            e.currentTarget.value = c.key
                            setColErr(errText(err))
                          }
                        }}
                      />
                      <input
                        className="tgrid-label"
                        defaultValue={c.label ?? ''}
                        placeholder="显示名"
                        onBlur={(e) => {
                          if (e.currentTarget.value !== (c.label ?? '')) onChange(updateTableColumnLabel(doc, c.key, e.currentTarget.value))
                        }}
                      />
                      <select
                        className="tgrid-type"
                        value={type}
                        title="列类型：决定单元格的编辑方式（切换不改写已存数据）"
                        onChange={(e) => onChange(setTableColumnType(doc, c.key, e.target.value as ColumnType))}
                      >
                        {COLUMN_TYPES.map((t) => (
                          <option key={t.value} value={t.value}>{t.label}</option>
                        ))}
                      </select>
                      <button type="button" className="ginsp-argdel" title={`删除列 ${c.key}`} onClick={() => onChange(removeTableColumn(doc, c.key))}>
                        ×
                      </button>
                    </div>
                    <span
                      className="tgrid-colresize"
                      title="拖拽调整列宽"
                      onPointerDown={(e) => onColResizeDown(e, c.key, type)}
                      onPointerMove={onColResizeMove}
                      onPointerUp={onColResizeUp}
                      onPointerCancel={onColResizeUp}
                    />
                  </th>
                )
              })}
              <th className="tgrid-addcol">
                <input
                  value={newCol}
                  placeholder="新列名…"
                  onChange={(e) => setNewCol(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') addColumn()
                  }}
                />
                <button type="button" onClick={addColumn}>
                  + 列
                </button>
              </th>
            </tr>
          </thead>
          <tbody>
            {table.rows.map((row, i) => (
              <tr key={i} style={{ height: heightOf(i) }}>
                <td className="tgrid-rowhead">
                  <span className="tgrid-rownum" title={`第 ${i + 1} 题（v.__row = ${i}）`}>
                    {i + 1}
                  </span>
                  <button type="button" className="ginsp-argdel" title={`删除第 ${i + 1} 行`} onClick={() => onChange(removeTableRow(doc, i))}>
                    ×
                  </button>
                  <span
                    className="tgrid-rowresize"
                    title="拖拽调整行高"
                    onPointerDown={(e) => onRowResizeDown(e, i)}
                    onPointerMove={onRowResizeMove}
                    onPointerUp={onRowResizeUp}
                    onPointerCancel={onRowResizeUp}
                  />
                </td>
                {table.columns.map((c) => (
                  <td key={c.key} className={`tgrid-cell tcell-${c.type ?? 'text'}`}>
                    <CellEditor
                      type={c.type ?? 'text'}
                      value={row[c.key] ?? null}
                      onCommit={(v) => commitCell(i, c.key, v)}
                      onOpenJson={() => setJsonCell({ row: i, key: c.key })}
                    />
                  </td>
                ))}
                <td className="tgrid-cell tgrid-cell-add" />
              </tr>
            ))}
            {table.rows.length === 0 && (
              <tr>
                <td colSpan={table.columns.length + 2} className="tgrid-empty">
                  还没有数据行——点「+ 添加行」创建第一题的数据。
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {jsonCell && (
        <JsonCellEditor
          doc={doc}
          row={jsonCell.row}
          colKey={jsonCell.key}
          onChange={onChange}
          onClose={() => setJsonCell(null)}
        />
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// 单元格编辑器（按列类型分派）
// ---------------------------------------------------------------------------

function CellEditor(props: {
  type: ColumnType
  value: Json
  onCommit: (v: Json) => void
  onOpenJson: () => void
}): React.ReactElement {
  const { type, value, onCommit } = props

  if (type === 'boolean') {
    return (
      <input
        type="checkbox"
        checked={value === true}
        title="布尔值"
        onChange={(e) => onCommit(e.target.checked)}
      />
    )
  }

  if (type === 'number') {
    const text = typeof value === 'number' ? String(value) : value === null || value === undefined ? '' : String(value)
    return (
      <input
        type="number"
        className="tgrid-input"
        value={text}
        onChange={(e) => {
          const t = e.target.value
          if (t === '') return onCommit(null)
          const n = Number(t)
          if (Number.isFinite(n)) onCommit(n)
        }}
      />
    )
  }

  if (type === 'notes') {
    const notes = notesFromCell(value)
    if (notes === null) return <JsonFallbackCell value={value} expect="音符串（{midi, dur} 数组）" onOpenJson={props.onOpenJson} />
    return <NoteChipsEditor notes={notes} onChange={(ns) => onCommit(notesToCell(ns))} />
  }

  if (type === 'list') {
    const items = listFromCell(value)
    if (items === null) return <JsonFallbackCell value={value} expect="字符串数组" onOpenJson={props.onOpenJson} />
    return (
      <span className="tlist">
        {items.map((it, i) => (
          <span key={i} className="tlist-item">
            <input
              value={it}
              placeholder="条目…"
              onChange={(e) => onCommit(items.map((x, j) => (j === i ? e.target.value : x)))}
            />
            <button type="button" className="ginsp-argdel" title="删除条目" onClick={() => onCommit(items.filter((_, j) => j !== i))}>
              ×
            </button>
          </span>
        ))}
        <button type="button" className="tlist-add" title="添加条目" onClick={() => onCommit([...items, ''])}>
          + 条目
        </button>
      </span>
    )
  }

  if (type === 'json') {
    return (
      <span className="tjson">
        <span className="tjson-text" title="JSON 高级列">
          {value === null || value === undefined ? '（空）' : clip(JSON.stringify(value))}
        </span>
        <button type="button" onClick={props.onOpenJson}>
          编辑 JSON
        </button>
      </span>
    )
  }

  // text（缺省）：字符串直存；清空 → null（与「无数据」语义一致）
  const text = value === null || value === undefined ? '' : String(value)
  return (
    <input
      className="tgrid-input"
      value={text}
      onChange={(e) => onCommit(e.target.value === '' ? null : e.target.value)}
    />
  )
}

/** notes/list 列遇到不合规数据：不静默破坏，引导走 JSON 高级弹层修 */
function JsonFallbackCell(props: { value: Json; expect: string; onOpenJson: () => void }): React.ReactElement {
  return (
    <span className="tjson tone-error" title={`该单元格不是${props.expect}，请用 JSON 高级编辑修正`}>
      <span className="tjson-text">{clip(JSON.stringify(props.value))}</span>
      <button type="button" onClick={props.onOpenJson}>
        编辑 JSON
      </button>
    </span>
  )
}

/** JSON 高级弹层（json 列与 notes/list 不合规数据的兜底编辑器） */
function JsonCellEditor(props: {
  doc: LevelDoc
  row: number
  colKey: string
  onChange: (doc: LevelDoc) => void
  onClose: () => void
}): React.ReactElement {
  const cell = props.doc.content.table.rows[props.row]?.[props.colKey]
  const [text, setText] = useState(() => (cell === undefined ? 'null' : JSON.stringify(cell, null, 2)))
  const [err, setErr] = useState('')

  const apply = (): void => {
    const t = text.trim()
    if (t === '') {
      props.onChange(updateTableCell(props.doc, props.row, { [props.colKey]: null }))
      props.onClose()
      return
    }
    const v = parseJsonText(t)
    if (v === null) {
      setErr('不是合法 JSON')
      return
    }
    props.onChange(updateTableCell(props.doc, props.row, { [props.colKey]: v }))
    props.onClose()
  }

  return (
    <div
      className="tjson-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) props.onClose()
      }}
    >
      <div className="tjson-modal">
        <div className="tjson-modal-head">
          <b>
            编辑 JSON · 第 {props.row + 1} 行 / {props.colKey}
          </b>
          <button type="button" onClick={props.onClose}>
            取消
          </button>
          <button type="button" className="primary" onClick={apply}>
            应用
          </button>
        </div>
        {err && <div className="tone-error">{err}</div>}
        <textarea value={text} rows={12} onChange={(e) => setText(e.target.value)} spellCheck={false} />
      </div>
    </div>
  )
}
