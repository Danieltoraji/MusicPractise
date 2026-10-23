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
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ColumnType, LevelDoc } from '../engine/level'
import { FlowEditor } from './FlowEditor'
import { ListEditorModal, listEntriesFromCell } from './ListEditor'
import { registerModalOpen } from './keyGuard'
import { DRAFT_SLOTS, loadDraft, saveDraft } from './draftStore'
import { SCHEMA_LIMITS } from '../library/schemaLimits'
import { Modal } from './Modal'
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
import { buildRowMetrics, visibleRowRange } from './virtualRows'

export const COLUMN_TYPES: { value: ColumnType; label: string }[] = [
  { value: 'text', label: '文本' },
  { value: 'number', label: '数字' },
  { value: 'boolean', label: '布尔' },
  { value: 'notes', label: '音符串' },
  { value: 'list', label: '字符串列表' },
  { value: 'json', label: 'JSON 高级' },
]

export const DEFAULT_COL_W: Record<ColumnType, number> = { text: 180, number: 96, boolean: 72, notes: 260, list: 170, json: 200 }
const DEFAULT_ROW_H = 36
const MIN_COL_W = 64
const MIN_ROW_H = 28

const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err))
const clip = (s: string, n = 60): string => (s.length > n ? `${s.slice(0, n)}…` : s)

/**
 * D2（docs/40）：list 列原始单元格值是否需要「将转换为文本列表」提示。
 * 非数组（字符串/对象/标量）与「非全字符串数组」（数字/对象数组，应用即逐项 JSON 文本化）
 * 都会改变数据形态，必须提示；此前只判 `!Array.isArray` 漏掉 [1,2] 这类 docs/40 点名场景。
 */
export function needsListConversion(v: unknown): boolean {
  return !Array.isArray(v) || v.some((x) => typeof x !== 'string')
}

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

  // D1 行虚拟化（docs/43 §7 → R14）：只挂载可视区 + overscan 的行。
  // 此前 512 行满配会挂载全部单元格（含每行 notes 的 VexFlow 迷你谱与输入框监听）。
  const wrapRef = useRef<HTMLDivElement>(null)
  const [viewport, setViewport] = useState<{ top: number; height: number }>({ top: 0, height: 0 })
  useEffect(() => {
    const el = wrapRef.current
    if (!el) return
    const measure = (): void => {
      // 同值不更新：scroll/resize 高频触发时避免无意义重渲染
      setViewport((prev) =>
        prev.top === el.scrollTop && prev.height === el.clientHeight ? prev : { top: el.scrollTop, height: el.clientHeight },
      )
    }
    measure()
    el.addEventListener('scroll', measure, { passive: true })
    let ro: ResizeObserver | null = null
    if (typeof ResizeObserver !== 'undefined') {
      ro = new ResizeObserver(measure)
      ro.observe(el)
    }
    return () => {
      el.removeEventListener('scroll', measure)
      ro?.disconnect()
    }
  }, [])

  const rowMetrics = useMemo(
    () => buildRowMetrics(table.rows.length, (i) => rowH[i] ?? DEFAULT_ROW_H),
    [table.rows.length, rowH],
  )
  // jsdom 无布局（clientHeight 恒 0）：给 600px 兜底，保证单测仍渲染合理窗口而非全表
  const viewportHeight = viewport.height > 0 ? viewport.height : 600
  const virtual = useMemo(
    () => visibleRowRange(rowMetrics, viewport.top, viewportHeight, 4),
    [rowMetrics, viewport.top, viewportHeight],
  )

  const addColumn = (): void => {
    // A5（docs/40）：列数上限门禁——「+ 列」按钮虽 disabled，但列名输入框 Enter 是
    // 独立快捷路径（不经按钮），必须在入口处拦下，否则越过 schema maxItems 到保存才被拒。
    if (table.columns.length >= SCHEMA_LIMITS.tableColumns) {
      setColErr(`列数已达上限 ${SCHEMA_LIMITS.tableColumns} 列（schema 约束）——请先删除现有列`)
      return
    }
    const key = newCol.trim()
    try {
      onChange(addTableColumn(doc, key))
      setNewCol('')
      setColErr('')
    } catch (err) {
      setColErr(errText(err))
    }
  }

  // D1：弹窗打开回调稳定化（CellEditor memo 的 props 前提）
  const openJson = useCallback((row: number, colKey: string): void => setJsonCell({ row, key: colKey }), [])
  const openStaff = useCallback((row: number, colKey: string): void => setStaffCell({ row, key: colKey }), [])
  const openList = useCallback((row: number, colKey: string): void => setListCell({ row, key: colKey }), [])

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
  // 在撤销栈中合并为一条；notes/list/json 走弹窗一次性 commit，无需 tag。
  // docRef 让 commitCell 引用稳定（D1 memo 前提）——闭包 doc 会在每次编辑后失效
  const docRef = useRef(doc)
  docRef.current = doc
  const commitCell = useCallback(
    (row: number, key: string, value: Json, tag?: string): void => {
      onChange(updateTableCell(docRef.current, row, { [key]: value }), tag)
    },
    [onChange],
  )

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
        <button
          type="button"
          disabled={table.rows.length >= SCHEMA_LIMITS.tableRows}
          title={table.rows.length >= SCHEMA_LIMITS.tableRows ? `已达上限 ${SCHEMA_LIMITS.tableRows} 行（schema 约束）` : undefined}
          onClick={() => onChange(addTableRow(doc))}
        >
          + 添加行{table.rows.length >= SCHEMA_LIMITS.tableRows ? '（已满）' : ''}
        </button>
      </div>
      <FlowEditor doc={doc} onChange={onChange} />
      {colErr && <div className="tone-error">{colErr}</div>}

      <div className="tgrid-wrap" ref={wrapRef}>
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
                        maxLength={SCHEMA_LIMITS.columnKeyMaxLength}
                        title={`列名（表达式 q.${c.key}，≤${SCHEMA_LIMITS.columnKeyMaxLength} 字符）；改名后表达式旧引用由 lint 提示`}
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
                        maxLength={SCHEMA_LIMITS.columnLabelMaxLength}
                        title={`列显示名（≤${SCHEMA_LIMITS.columnLabelMaxLength} 字符，schema 约束）`}
                        onBlur={(e) => {
                          if (e.currentTarget.value !== (c.label ?? '')) onChange(updateTableColumnLabel(doc, c.key, e.currentTarget.value))
                        }}
                      />
                      <select
                        className="tgrid-type"
                        value={type}
                        title="列类型：决定单元格的编辑方式（切换不改写已存数据）"
                        onChange={(e) => {
                          const next = e.target.value as ColumnType
                          if (next === type) return
                          // D2（docs/40）：类型切换确认——非文本类型切换会改变单元格渲染与编辑方式
                          const count = table.rows.filter((r) => r[c.key] !== null && r[c.key] !== undefined).length
                          if (
                            count > 0 &&
                            !window.confirm(
                              `把列「${c.key}」切换为「${COLUMN_TYPES.find((t) => t.value === next)?.label}」？
该列已有 ${count} 行数据——切换只改变编辑方式，不改写数据；非文本旧数据会以修复入口呈现。`,
                            )
                          )
                            return
                          onChange(setTableColumnType(doc, c.key, next))
                        }}
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
                <button
                  type="button"
                  onClick={addColumn}
                  disabled={table.columns.length >= SCHEMA_LIMITS.tableColumns}
                  title={table.columns.length >= SCHEMA_LIMITS.tableColumns ? `已达上限 ${SCHEMA_LIMITS.tableColumns} 列（schema 约束）` : undefined}
                >
                  + 列
                </button>
              </th>
            </tr>
          </thead>
          <tbody>
            {virtual.start > 0 && (
              <tr className="tgrid-spacer" data-spacer="top" aria-hidden="true" style={{ height: rowMetrics.offsets[virtual.start] }}>
                <td colSpan={table.columns.length + 2} />
              </tr>
            )}
            {table.rows.slice(virtual.start, virtual.end).map((row, offset) => {
              const i = virtual.start + offset
              return (
                <tr key={i} style={{ height: heightOf(i) }}>
                  <td className="tgrid-rowhead">
                    <span className="tgrid-rownum" title={`第 ${i + 1} 题（v.__row = ${i}）`}>
                      {i + 1}
                    </span>
                    <button
                      type="button"
                      className="ginsp-argdel"
                      title={`删除第 ${i + 1} 行`}
                      onClick={() => {
                        onChange(removeTableRow(doc, i))
                        // D3（docs/40）：行高按行号键存——删行后整体前移一位，否则错位
                        setRowH((cur) => {
                          const next: Record<number, number> = {}
                          for (const [k, v] of Object.entries(cur)) {
                            const idx = Number(k)
                            if (idx < i) next[idx] = v
                            else if (idx > i) next[idx - 1] = v
                          }
                          return next
                        })
                      }}
                    >
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
                        row={i}
                        colKey={c.key}
                        value={row[c.key] ?? null}
                        width={widthOf(c.key, c.type ?? 'text')}
                        height={heightOf(i)}
                        onCommit={commitCell}
                        onOpenJson={openJson}
                        onOpenStaff={openStaff}
                        onOpenList={openList}
                      />
                    </td>
                  ))}
                  <td className="tgrid-cell tgrid-cell-add" />
                </tr>
              )
            })}
            {virtual.end < table.rows.length && (
              <tr
                className="tgrid-spacer"
                data-spacer="bottom"
                aria-hidden="true"
                style={{ height: rowMetrics.totalHeight - rowMetrics.offsets[virtual.end] }}
              >
                <td colSpan={table.columns.length + 2} />
              </tr>
            )}
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
          converting={needsListConversion(doc.content.table.rows[listCell.row]?.[listCell.key])}
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

function CellEditorImpl(props: {
  type: ColumnType
  row: number
  colKey: string
  value: Json
  /** 所在列宽/行高（notes 迷你谱预览适配用） */
  width?: number
  height?: number
  /** 逐键编辑（text/number）时携带连续性 tag，撤销栈据此合并一次输入会话（docs/40 B1） */
  onCommit: (row: number, colKey: string, v: Json, tag?: string) => void
  onOpenJson: (row: number, colKey: string) => void
  onOpenStaff: (row: number, colKey: string) => void
  onOpenList: (row: number, colKey: string) => void
}): React.ReactElement {
  const { type, value, row, colKey } = props
  // D1（docs/40）：受控 memo——value 不变时打字/拖宽不重渲其它单元格
  const onCommit = (v: Json, tag?: string): void => props.onCommit(row, colKey, v, tag)
  const openJson = (): void => props.onOpenJson(row, colKey)
  const openStaff = (): void => props.onOpenStaff(row, colKey)
  const openList = (): void => props.onOpenList(row, colKey)

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
    // D2（docs/40）：非 number 数据（object/boolean/字符串数字）一律回落修复入口——
    // 此前 boolean/字符串被 String() 塞进 type=number，浏览器净化为空（显示空但数据还在）
    const scalarBad = value !== null && value !== undefined && typeof value !== 'number'
    if (scalarBad) {
      return <JsonFallbackCell value={value} expect="数值" onOpenJson={openJson} />
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
          onClick={openStaff}
        >
          <span className="tstaff-fix-text">⚠ 非标准音符数据 · 点击修复</span>
        </button>
      )
    }
    // 五线谱可视化（docs/27）：迷你谱预览（只显示一行，后面隐藏），点击打开谱面弹窗编辑
    return (
      <button type="button" className="tstaff" title="点击编辑五线谱" onClick={openStaff}>
        <StaffPreview notes={notes} width={props.width} height={Math.max(56, (props.height ?? 64) - 6)} />
      </button>
    )
  }

  if (type === 'list') {
    // 任意旧值尽力转可编辑条目（listEntriesFromCell 永不失败）：不再有「编辑 JSON」死角
    const items = listEntriesFromCell(value)
    const summary = items.length === 0 ? '（空）' : items.join('、')
    return (
      <button type="button" className="tlist-open" title="点击编辑字符串列表" onClick={openList}>
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
        <button type="button" onClick={openJson}>
          编辑 JSON
        </button>
      </span>
    )
  }

  // text（缺省）：字符串直存；清空 → null（与「无数据」语义一致）。
  // 非标量值（对象/数组）不再 String() 出 [object Object]：回落 JSON 弹层修正（docs/27）
  if (value !== null && value !== undefined && typeof value === 'object') {
    return <JsonFallbackCell value={value} expect="文本" onOpenJson={openJson} />
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

/** D1：memo 化的单元格编辑器（比较只看数据性 props；回调经 useCallback 稳定） */
export const CellEditor = memo(CellEditorImpl, (a, b) =>
  a.type === b.type &&
  a.row === b.row &&
  a.colKey === b.colKey &&
  a.value === b.value &&
  a.width === b.width &&
  a.height === b.height &&
  a.onCommit === b.onCommit &&
  a.onOpenJson === b.onOpenJson &&
  a.onOpenStaff === b.onOpenStaff &&
  a.onOpenList === b.onOpenList,
)

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
  void registerModalOpen // Modal 内部已注册（保留导入防误删）

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
    <Modal
      title={
        <>
          编辑 JSON · 第 {props.row + 1} 行 / {props.colKey}
        </>
      }
      onClose={props.onClose}
      actions={
        <>
          <button type="button" onClick={props.onClose}>
            取消
          </button>
          <button type="button" className="primary" onClick={apply}>
            应用
          </button>
        </>
      }
    >
      {err && <div className="tone-error">{err}</div>}
      <textarea value={text} rows={12} onChange={(e) => setText(e.target.value)} spellCheck={false} autoFocus />
    </Modal>
  )
}
