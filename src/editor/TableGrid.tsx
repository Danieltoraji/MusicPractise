/**
 * 题目数据表（3-7 网格化重做 + docs/27 全可视化）：真表格网格 + 零 JSON 输入。
 * - 列头：列名 / 显示名 / 类型下拉（文本|数字|布尔|音符串|字符串列表|JSON高级）/ 删除；右缘拖拽调列宽
 * - 行头：题号（= v.__row 行号）/ 删除；下缘拖拽调行高
 * - 单元格按列类型渲染专用编辑器：notes → 五线谱迷你预览 + 弹窗谱面编辑（StaffEditor，
 *   非标准旧数据同样进弹窗修复/从文本导入）；list → 摘要 + 弹窗条目编辑（ListEditor）；
 *   json → 高级弹层兜底（仅历史复合列需要）
 * - 列宽/行高为编辑器内存态（不进文档 JSON，会话内保持）
 * 约束延续：单元格受控写回（删行/插行后不残留旧文本，评审 P1-2）。
 */
import { useEffect, useRef, useState } from 'react'
import type { ColumnType, LevelDoc } from '../engine/level'
import { FlowEditor } from './FlowEditor'
import { ListEditorModal, listEntriesFromCell } from './ListEditor'
import { registerModalOpen } from './keyGuard'
import { DRAFT_SLOTS, loadDraft, saveDraft } from './draftStore'
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
import { notesFromCell, notesToCell } from './graph/NoteChipsEditor'
import { StaffEditorModal, StaffPreview } from './StaffEditor'

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

export function TableEditor({ doc, onChange }: { doc: LevelDoc; onChange: (doc: LevelDoc, tag?: string) => void }) {
  const table = doc.content.table
  // 列宽/行高布局态跨 Tab 存活（docs/40 C1/D3 部分）：经 draftStore 按列 key / 行号保留——
  // 此前组件内 state 切走即丢。键仍为列 key / 行号（稳定 rowId 改造见 docs/41 R8 D3）
  const [colW, setColW] = useState<Record<string, number>>(
    () => loadDraft<{ colW: Record<string, number>; rowH: Record<number, number> }>(doc.id, DRAFT_SLOTS.tableLayout)?.colW ?? {},
  )
  const [rowH, setRowH] = useState<Record<number, number>>(
    () => loadDraft<{ colW: Record<string, number>; rowH: Record<number, number> }>(doc.id, DRAFT_SLOTS.tableLayout)?.rowH ?? {},
  )
  useEffect(() => {
    saveDraft(doc.id, DRAFT_SLOTS.tableLayout, { colW, rowH })
  }, [doc.id, colW, rowH])
  const [newCol, setNewCol] = useState('')
  const [colErr, setColErr] = useState('')
  const [jsonCell, setJsonCell] = useState<{ row: number; key: string } | null>(null)
  const [staffCell, setStaffCell] = useState<{ row: number; key: string } | null>(null)
  const [listCell, setListCell] = useState<{ row: number; key: string } | null>(null)
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

  // 逐键编辑的 text/number 单元格带连续性 tag（docs/40 B1）：同单元格的连续输入
  // 在撤销栈中合并为一条；notes/list/json 走弹窗一次性 commit，无需 tag
  const commitCell = (row: number, key: string, value: Json, tag?: string): void => {
    onChange(updateTableCell(doc, row, { [key]: value }), tag)
  }

  // staffCell 打开期间解析一次：合规 → 直接编辑谱面；不合规 → importRaw 走修复/导入通道
  const staffRaw = staffCell ? (doc.content.table.rows[staffCell.row]?.[staffCell.key] ?? null) : null
  const staffNotes = staffCell ? notesFromCell(staffRaw) : null

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
      <FlowEditor doc={doc} onChange={onChange} />
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
                      width={widthOf(c.key, c.type ?? 'text')}
                      height={heightOf(i)}
                      onCommit={(v, tag) => commitCell(i, c.key, v, tag)}
                      onOpenJson={() => setJsonCell({ row: i, key: c.key })}
                      onOpenStaff={() => setStaffCell({ row: i, key: c.key })}
                      onOpenList={() => setListCell({ row: i, key: c.key })}
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
      {staffCell && (
        <StaffEditorModal
          title={`编辑音符串 · 第 ${staffCell.row + 1} 行 / ${staffCell.key}`}
          value={staffNotes ?? []}
          importRaw={staffNotes === null ? staffRaw : undefined}
          onCommit={(notes) => {
            onChange(updateTableCell(doc, staffCell.row, { [staffCell.key]: notesToCell(notes) as Json }))
            setStaffCell(null)
          }}
          onClose={() => setStaffCell(null)}
        />
      )}
      {listCell && (
        <ListEditorModal
          title={`编辑字符串列表 · 第 ${listCell.row + 1} 行 / ${listCell.key}`}
          value={listEntriesFromCell(doc.content.table.rows[listCell.row]?.[listCell.key] ?? null)}
          onCommit={(items) => {
            // 全部清空 → null（与 text 列「清空 = 无数据」语义一致）
            onChange(updateTableCell(doc, listCell.row, { [listCell.key]: (items.length > 0 ? items : null) as Json }))
            setListCell(null)
          }}
          onClose={() => setListCell(null)}
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
  /** 所在列宽/行高（notes 迷你谱预览适配用） */
  width?: number
  height?: number
  /** 逐键编辑（text/number）时携带连续性 tag，撤销栈据此合并一次输入会话（docs/40 B1） */
  onCommit: (v: Json, tag?: string) => void
  onOpenJson: () => void
  onOpenStaff: () => void
  onOpenList: () => void
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
    // 非标量值（历史脏数据/类型误标）不再 String() 出 [object Object]：回落 JSON 弹层修正
    if (value !== null && value !== undefined && typeof value === 'object') {
      return <JsonFallbackCell value={value} expect="数值" onOpenJson={props.onOpenJson} />
    }
    const text = typeof value === 'number' ? String(value) : value === null || value === undefined ? '' : String(value)
    return (
      <input
        type="number"
        className="tgrid-input"
        value={text}
        onChange={(e) => {
          const t = e.target.value
          if (t === '') return onCommit(null, 'cell')
          const n = Number(t)
          if (Number.isFinite(n)) onCommit(n, 'cell')
        }}
      />
    )
  }

  if (type === 'notes') {
    const notes = notesFromCell(value)
    if (notes === null) {
      // 非标准旧数据（如类型切换前的文本/字符串形态）：不再落 JSON 死胡同，进弹窗修复/导入
      return (
        <button
          type="button"
          className="tstaff tstaff-fix"
          title="该单元格不是标准音符数组——点击打开编辑器修复（可从文本导入，应用后替换）"
          onClick={props.onOpenStaff}
        >
          <span className="tstaff-fix-text">⚠ 非标准音符数据 · 点击修复</span>
        </button>
      )
    }
    // 五线谱可视化（docs/27）：迷你谱预览（只显示一行，后面隐藏），点击打开谱面弹窗编辑
    return (
      <button type="button" className="tstaff" title="点击编辑五线谱" onClick={props.onOpenStaff}>
        <StaffPreview notes={notes} width={props.width} height={Math.max(56, (props.height ?? 64) - 6)} />
      </button>
    )
  }

  if (type === 'list') {
    // 任意旧值尽力转可编辑条目（listEntriesFromCell 永不失败）：不再有「编辑 JSON」死角
    const items = listEntriesFromCell(value)
    const summary = items.length === 0 ? '（空）' : items.join('、')
    return (
      <button type="button" className="tlist-open" title="点击编辑字符串列表" onClick={props.onOpenList}>
        <span className="tlist-summary">{clip(summary, 90)}</span>
        <span className="tlist-count">{items.length} 项</span>
      </button>
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

  // text（缺省）：字符串直存；清空 → null（与「无数据」语义一致）。
  // 非标量值（对象/数组）不再 String() 出 [object Object]：回落 JSON 弹层修正（docs/27）
  if (value !== null && value !== undefined && typeof value === 'object') {
    return <JsonFallbackCell value={value} expect="文本" onOpenJson={props.onOpenJson} />
  }
  const text = value === null || value === undefined ? '' : String(value)
  return (
    <input
      className="tgrid-input"
      value={text}
      onChange={(e) => onCommit(e.target.value === '' ? null : e.target.value, 'cell')}
    />
  )
}

/** text/number 列遇到非标量旧数据：不静默破坏，引导走 JSON 高级弹层修 */
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
  // 模态打开期间短路编辑器全局快捷键（Ctrl+Z/Delete，docs/40 B5）
  useEffect(registerModalOpen, [])

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
