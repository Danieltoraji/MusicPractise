/**
 * v4 编辑器「内容」Tab（docs/53 §13.3）：
 * 子页 `tables`（题型选择 + 每型实例表：列编辑 / 行增删重排 / draft·phase·order / 单元格弹窗）
 * 与子页 `manifest`（ManifestTab：自动/显式题单 + run 配置 + 牌堆预览）。
 *
 * 复用的既有组件（W9 保留的通用件）：Modal / StaffEditorModal / StaffPreview / ListEditorModal。
 * 非标量单元格一律走 JsonFallback 或专用弹窗，**禁止 String() 兜底**（docs/27 已知坑）。
 */
import { useState } from 'react'
import type { Json } from '../../engine/expr'
import type { ColumnType } from '../../engine/level'
import { COLUMN_TYPE_LABELS } from '../../engine/level'
import {
  SCHEMA_LIMITS_V4,
  countRows,
  type ColumnDefV4,
  type LevelDocV4,
  type QuestionRow,
} from '../../engine/v4/model'
import { ListEditorModal, listEntriesFromCell } from '../ListEditor'
import { StaffEditorModal, StaffPreview } from '../StaffEditor'
import { COLUMN_TYPES_V4, clipText, needsListConversion, notesFromCell, notesToCell } from './cellValues'
import {
  V4_TAGS,
  addColumn,
  addRow,
  addType,
  moveRow,
  removeColumn,
  removeRow,
  removeType,
  renameColumn,
  updateColumn,
  updateRowMeta,
  updateTableCell,
} from './docStateV4'
import { ManifestTab } from './ManifestTab'
import { JsonEditModal, errText, type V4TabProps } from './shared'

type ContentSubTab = 'tables' | 'manifest'

/** 新题型默认实例表：一列「题面」文本，降低从零建关的第一步成本 */
const NEW_TYPE_COLUMNS: ColumnDefV4[] = [{ key: 'prompt', label: '题面', type: 'text' }]

export function ContentTab({ doc, onChange }: V4TabProps): React.ReactElement {
  const [subTab, setSubTab] = useState<ContentSubTab>('tables')
  return (
    <div className="v4-content-tab" data-testid="v4-content-tab">
      <div className="v4-subtabs">
        <button
          type="button"
          className={subTab === 'tables' ? 'active' : ''}
          data-testid="v4-content-subtab-tables"
          onClick={() => setSubTab('tables')}
        >
          实例表
        </button>
        <button
          type="button"
          className={subTab === 'manifest' ? 'active' : ''}
          data-testid="v4-content-subtab-manifest"
          onClick={() => setSubTab('manifest')}
        >
          题单与运行
        </button>
      </div>
      {subTab === 'tables' ? <TablesPane doc={doc} onChange={onChange} /> : <ManifestTab doc={doc} onChange={onChange} />}
    </div>
  )
}

// ---------------------------------------------------------------------------
// 实例表子页
// ---------------------------------------------------------------------------

function TablesPane({ doc, onChange }: V4TabProps): React.ReactElement {
  const types = doc.content.types
  const [selectedId, setSelectedId] = useState<string | null>(types[0]?.id ?? null)
  const [newColumn, setNewColumn] = useState('')
  const [error, setError] = useState('')
  const [jsonCell, setJsonCell] = useState<CellRef | null>(null)
  const [staffCell, setStaffCell] = useState<CellRef | null>(null)
  const [listCell, setListCell] = useState<CellRef | null>(null)

  const activeType = types.find((t) => t.id === selectedId) ?? types[0]
  const table = activeType ? doc.content.tables[activeType.id] : undefined

  const guarded = (fn: () => void): void => {
    try {
      fn()
      setError('')
    } catch (err) {
      setError(errText(err))
    }
  }

  const handleAddType = (): void => {
    guarded(() => {
      const result = addType(doc, { name: '新题型', table: { columns: NEW_TYPE_COLUMNS.map((c) => ({ ...c })) } })
      setSelectedId(result.id)
      onChange(result.doc)
    })
  }

  const handleRemoveType = (): void => {
    if (!activeType) return
    onChange(removeType(doc, activeType.id))
    setSelectedId(null)
  }

  const handleAddRow = (): void => {
    if (!activeType) return
    guarded(() => {
      const result = addRow(doc, activeType.id)
      onChange(result.doc)
    })
  }

  const handleAddColumn = (): void => {
    if (!activeType) return
    const key = newColumn.trim()
    if (key === '') return
    guarded(() => {
      onChange(addColumn(doc, activeType.id, { key, type: 'text' }))
      setNewColumn('')
    })
  }

  const commitCell = (rowId: string, key: string, value: Json, tag?: string): void => {
    if (!activeType) return
    onChange(updateTableCell(doc, activeType.id, rowId, key, value), tag)
  }

  const totalRows = countRows(doc)
  const rowsFull = table !== undefined && table.rows.length >= SCHEMA_LIMITS_V4.rowsPerType
  const totalFull = totalRows >= SCHEMA_LIMITS_V4.rowsTotal

  return (
    <div className="v4-split">
      <aside className="v4-side" data-testid="v4-type-sidebar">
        <div className="v4-side-head">
          <b>题型（{types.length}/{SCHEMA_LIMITS_V4.types}）</b>
          <button
            type="button"
            data-testid="v4-content-add-type"
            disabled={types.length >= SCHEMA_LIMITS_V4.types}
            onClick={handleAddType}
          >
            + 题型
          </button>
        </div>
        <div className="v4-list" data-testid="v4-type-list">
          {types.map((type) => (
            <div key={type.id} className={`v4-list-item${type.id === activeType?.id ? ' active' : ''}`}>
              <button
                type="button"
                className="v4-list-select"
                data-testid={`v4-type-select-${type.id}`}
                onClick={() => setSelectedId(type.id)}
                title={`题型 id：${type.id}`}
              >
                <b>{type.name}</b>
                <span className="muted">
                  {doc.content.tables[type.id]?.rows.length ?? 0} 行
                </span>
              </button>
            </div>
          ))}
          {types.length === 0 && <p className="muted v4-side-empty">还没有题型——点「+ 题型」创建第一个。</p>}
        </div>
      </aside>

      <div className="v4-main">
        {!activeType || !table ? (
          <div className="v4-empty" data-testid="v4-tables-empty">
            <p>v4 关卡由「题型 + 每型实例表」组成：先建一个题型，再在表里录题。</p>
            <button type="button" onClick={handleAddType} disabled={types.length >= SCHEMA_LIMITS_V4.types}>
              + 建第一个题型
            </button>
          </div>
        ) : (
          <>
            <div className="rules-toolbar v4-table-toolbar">
              <b>{activeType.name}</b>
              <span className="muted">
                id <code>{activeType.id}</code> · {table.rows.length}/{SCHEMA_LIMITS_V4.rowsPerType} 行 · 全关{' '}
                {totalRows}/{SCHEMA_LIMITS_V4.rowsTotal} 行
              </span>
              <button
                type="button"
                data-testid="v4-tgrid-add-row"
                disabled={rowsFull || totalFull}
                title={rowsFull || totalFull ? '已达 schema 行数上限' : '在表尾添加一行'}
                onClick={handleAddRow}
              >
                + 添加行
              </button>
              <button type="button" className="tone-error" data-testid="v4-type-remove" onClick={handleRemoveType}>
                删除题型
              </button>
            </div>
            {error && (
              <div className="tone-error" data-testid="v4-tables-error">
                {error}
              </div>
            )}
            <div className="tgrid-wrap">
              <table className="tgrid v4-tgrid" data-testid={`v4-tgrid-${activeType.id}`}>
                <colgroup>
                  <col style={{ width: 120 }} />
                  <col style={{ width: 64 }} />
                  <col style={{ width: 72 }} />
                  <col style={{ width: 72 }} />
                  {table.columns.map((c) => (
                    <col key={c.key} style={{ width: c.type === 'notes' ? 240 : 180 }} />
                  ))}
                  <col style={{ width: 190 }} />
                </colgroup>
                <thead>
                  <tr>
                    <th className="tgrid-corner"># / 行</th>
                    <th className="tgrid-colhead" title="草稿行不进入自动题单">
                      草稿
                    </th>
                    <th className="tgrid-colhead" title="阶段（默认 1，整数 ≥1；题单按阶段排序）">
                      阶段
                    </th>
                    <th className="tgrid-colhead" title="阶段内顺序（缺省 = 行下标）">
                      顺序
                    </th>
                    {table.columns.map((column) => (
                      <th key={column.key} className="tgrid-colhead" data-testid={`v4-colhead-${column.key}`}>
                        <div className="tgrid-colhead-row">
                          <input
                            key={`key:${column.key}`}
                            className="tgrid-key"
                            defaultValue={column.key}
                            maxLength={32}
                            title={`列名（表达式 q.${column.key}，≤32 字符）`}
                            data-testid={`v4-col-key-${column.key}`}
                            onBlur={(e) => {
                              const nextKey = e.currentTarget.value.trim()
                              if (nextKey === column.key) return
                              if (
                                !guardedVoid(() => onChange(renameColumn(doc, activeType.id, column.key, nextKey)), setError)
                              ) {
                                e.currentTarget.value = column.key
                              }
                            }}
                          />
                          <input
                            key={`label:${column.key}:${column.label ?? ''}`}
                            className="tgrid-label"
                            defaultValue={column.label ?? ''}
                            placeholder="显示名"
                            maxLength={120}
                            data-testid={`v4-col-label-${column.key}`}
                            onBlur={(e) => {
                              if (e.currentTarget.value !== (column.label ?? '')) {
                                onChange(updateColumn(doc, activeType.id, column.key, { label: e.currentTarget.value }), V4_TAGS.column)
                              }
                            }}
                          />
                          <select
                            className="tgrid-type"
                            value={column.type ?? 'text'}
                            data-testid={`v4-col-type-${column.key}`}
                            onChange={(e) => {
                              const type = e.target.value as ColumnType
                              if (type !== (column.type ?? 'text')) {
                                onChange(updateColumn(doc, activeType.id, column.key, { type }), V4_TAGS.column)
                              }
                            }}
                          >
                            {COLUMN_TYPES_V4.map((option) => (
                              <option key={option.value} value={option.value}>
                                {COLUMN_TYPE_LABELS[option.value]}
                              </option>
                            ))}
                          </select>
                          <button
                            type="button"
                            className="ginsp-argdel"
                            title={`删除列 ${column.key}`}
                            data-testid={`v4-col-remove-${column.key}`}
                            onClick={() => onChange(removeColumn(doc, activeType.id, column.key))}
                          >
                            ×
                          </button>
                        </div>
                      </th>
                    ))}
                    <th className="tgrid-addcol">
                      <input
                        value={newColumn}
                        placeholder="新列名…"
                        maxLength={32}
                        data-testid="v4-col-new"
                        onChange={(e) => setNewColumn(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') handleAddColumn()
                        }}
                      />
                      <button
                        type="button"
                        data-testid="v4-col-add"
                        disabled={table.columns.length >= SCHEMA_LIMITS_V4.columnsPerType}
                        onClick={handleAddColumn}
                      >
                        + 列
                      </button>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {table.rows.map((row, index) => (
                    <tr key={row.id} data-testid={`v4-tgrid-row-${row.id}`}>
                      <td className="tgrid-rowhead">
                        <span className="tgrid-rownum" title={`第 ${index + 1} 行（q.id = ${row.id}）`}>
                          {index + 1}
                        </span>
                        <button
                          type="button"
                          className="ginsp-argdel"
                          title="上移"
                          data-testid={`v4-row-up-${row.id}`}
                          disabled={index === 0}
                          onClick={() => onChange(moveRow(doc, activeType.id, row.id, index - 1))}
                        >
                          ↑
                        </button>
                        <button
                          type="button"
                          className="ginsp-argdel"
                          title="下移"
                          data-testid={`v4-row-down-${row.id}`}
                          disabled={index === table.rows.length - 1}
                          onClick={() => onChange(moveRow(doc, activeType.id, row.id, index + 1))}
                        >
                          ↓
                        </button>
                        <button
                          type="button"
                          className="ginsp-argdel"
                          title={`删除第 ${index + 1} 行`}
                          data-testid={`v4-row-remove-${row.id}`}
                          onClick={() => onChange(removeRow(doc, activeType.id, row.id))}
                        >
                          ×
                        </button>
                      </td>
                      <td className="tgrid-cell" title="草稿/备用：不进入自动题单">
                        <input
                          type="checkbox"
                          checked={row.draft === true}
                          data-testid={`v4-row-draft-${row.id}`}
                          onChange={(e) =>
                            onChange(updateRowMeta(doc, activeType.id, row.id, { draft: e.target.checked }), V4_TAGS.rowMeta)
                          }
                        />
                      </td>
                      <td className="tgrid-cell">
                        <RowMetaNumber
                          value={row.phase}
                          placeholder="1"
                          testId={`v4-row-phase-${row.id}`}
                          onCommit={(value) => onChange(updateRowMeta(doc, activeType.id, row.id, { phase: value }), V4_TAGS.rowMeta)}
                        />
                      </td>
                      <td className="tgrid-cell">
                        <RowMetaNumber
                          value={row.order}
                          placeholder={String(index)}
                          testId={`v4-row-order-${row.id}`}
                          onCommit={(value) => onChange(updateRowMeta(doc, activeType.id, row.id, { order: value }), V4_TAGS.rowMeta)}
                        />
                      </td>
                      {table.columns.map((column) => (
                        <td key={column.key} className={`tgrid-cell tcell-${column.type ?? 'text'}`}>
                          <CellEditorV4
                            type={column.type ?? 'text'}
                            rowId={row.id}
                            column={column}
                            value={row[column.key] ?? null}
                            onCommit={(value, tag) => commitCell(row.id, column.key, value, tag)}
                            onOpenJson={() => setJsonCell({ rowId: row.id, key: column.key })}
                            onOpenNotes={() => setStaffCell({ rowId: row.id, key: column.key })}
                            onOpenList={() => setListCell({ rowId: row.id, key: column.key })}
                          />
                        </td>
                      ))}
                      <td className="tgrid-cell tgrid-cell-add" />
                    </tr>
                  ))}
                  {table.rows.length === 0 && (
                    <tr>
                      <td colSpan={table.columns.length + 5} className="tgrid-empty">
                        还没有数据行——点「+ 添加行」录入第一题（行 id 程序化生成，重排不影响引用）。
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>

      {jsonCell && (
        <JsonEditModal
          title={`编辑 JSON 单元格 · ${jsonCell.key}`}
          value={findCell(doc, activeType?.id ?? null, jsonCell)}
          testId="v4-json-cell"
          onApply={(value) => {
            commitCell(jsonCell.rowId, jsonCell.key, value, V4_TAGS.cell)
            setJsonCell(null)
          }}
          onClose={() => setJsonCell(null)}
        />
      )}
      {staffCell && (() => {
        const raw = findCell(doc, activeType?.id ?? null, staffCell)
        const notes = notesFromCell(raw)
        return (
          <StaffEditorModal
            title={`编辑音符串 · ${staffCell.key}`}
            value={notes ?? []}
            importRaw={notes === null ? raw : undefined}
            onCommit={(next) => {
              commitCell(staffCell.rowId, staffCell.key, notesToCell(next))
              setStaffCell(null)
            }}
            onClose={() => setStaffCell(null)}
          />
        )
      })()}
      {listCell && (
        <ListEditorModal
          title={`编辑字符串列表 · ${listCell.key}`}
          converting={needsListConversion(findCell(doc, activeType?.id ?? null, listCell))}
          value={listEntriesFromCell(findCell(doc, activeType?.id ?? null, listCell) ?? null)}
          onCommit={(items) => {
            commitCell(listCell.rowId, listCell.key, items.length > 0 ? items : null)
            setListCell(null)
          }}
          onClose={() => setListCell(null)}
        />
      )}
    </div>
  )
}

interface CellRef {
  rowId: string
  key: string
}

function findCell(doc: LevelDocV4, typeId: string | null, ref: CellRef): Json {
  if (!typeId) return null
  const row: QuestionRow | undefined = doc.content.tables[typeId]?.rows.find((r) => r.id === ref.rowId)
  return row ? (row[ref.key] ?? null) : null
}

/** guarded 的布尔版本：成功 true / 失败 false（调用方据此回滚输入框） */
function guardedVoid(fn: () => void, setError: (message: string) => void): boolean {
  try {
    fn()
    setError('')
    return true
  } catch (err) {
    setError(errText(err))
    return false
  }
}

/** 行元数据数字输入（空 = 删除该键回缺省；非法输入不提交） */
function RowMetaNumber(props: {
  value: number | undefined
  placeholder: string
  testId: string
  onCommit: (value: number | null) => void
}): React.ReactElement {
  return (
    <input
      className="tgrid-input v4-rowmeta-input"
      type="number"
      min={0}
      value={props.value === undefined ? '' : String(props.value)}
      placeholder={props.placeholder}
      data-testid={props.testId}
      onChange={(e) => {
        const text = e.target.value
        if (text === '') {
          props.onCommit(null)
          return
        }
        const numeric = Number(text)
        if (Number.isFinite(numeric)) props.onCommit(Math.trunc(numeric))
      }}
    />
  )
}

// ---------------------------------------------------------------------------
// 单元格编辑器（按列类型分派；非标量走专用弹窗 / JsonFallback）
// ---------------------------------------------------------------------------

function CellEditorV4(props: {
  type: ColumnType
  rowId: string
  column: ColumnDefV4
  value: Json
  onCommit: (value: Json, tag?: string) => void
  onOpenJson: () => void
  onOpenNotes: () => void
  onOpenList: () => void
}): React.ReactElement {
  const { type, value, rowId, column } = props
  const testId = `v4-tgrid-cell-${rowId}-${column.key}`

  if (type === 'boolean') {
    return (
      <input
        type="checkbox"
        checked={value === true}
        title="布尔值"
        data-testid={testId}
        onChange={(e) => props.onCommit(e.target.checked)}
      />
    )
  }

  if (type === 'number') {
    const invalid = value !== null && value !== undefined && typeof value !== 'number'
    if (invalid) return <JsonFallbackCell value={value} expect="数值" testId={testId} onOpenJson={props.onOpenJson} />
    return (
      <input
        type="number"
        className="tgrid-input"
        data-testid={testId}
        value={typeof value === 'number' ? String(value) : ''}
        onChange={(e) => {
          const text = e.target.value
          if (text === '') {
            props.onCommit(null, V4_TAGS.cell)
            return
          }
          const numeric = Number(text)
          if (Number.isFinite(numeric)) props.onCommit(numeric, V4_TAGS.cell)
        }}
      />
    )
  }

  if (type === 'notes') {
    const notes = notesFromCell(value)
    if (notes === null) {
      return <JsonFallbackCell value={value} expect="音符数组" testId={testId} onOpenJson={props.onOpenJson} />
    }
    return (
      <button type="button" className="tstaff" title="点击编辑五线谱" data-testid={testId} onClick={props.onOpenNotes}>
        <StaffPreview notes={notes} width={240} height={60} />
      </button>
    )
  }

  if (type === 'list') {
    const items = listEntriesFromCell(value)
    const summary = items.length === 0 ? '（空）' : items.join('、')
    return (
      <button type="button" className="tlist-open" title="点击编辑字符串列表" data-testid={testId} onClick={props.onOpenList}>
        <span className="tlist-summary">{clipText(summary, 90)}</span>
        <span className="tlist-count">{items.length} 项</span>
      </button>
    )
  }

  if (type === 'json') {
    return (
      <button type="button" className="tjson" data-testid={testId} onClick={props.onOpenJson}>
        <span className="tjson-text">{value === null || value === undefined ? '（空）' : clipText(JSON.stringify(value))}</span>
        <span>编辑 JSON</span>
      </button>
    )
  }

  // text（缺省）：对象/数组不静态文本化，回落 JSON 弹层修正
  if (value !== null && value !== undefined && typeof value === 'object') {
    return <JsonFallbackCell value={value} expect="文本" testId={testId} onOpenJson={props.onOpenJson} />
  }
  return (
    <input
      className="tgrid-input"
      data-testid={testId}
      value={value === null || value === undefined ? '' : String(value)}
      onChange={(e) => props.onCommit(e.target.value === '' ? null : e.target.value, V4_TAGS.cell)}
    />
  )
}

/** 非标量旧数据：不静默破坏，引导走 JSON 高级编辑 */
function JsonFallbackCell(props: {
  value: Json
  expect: string
  testId: string
  onOpenJson: () => void
}): React.ReactElement {
  return (
    <span className="tjson tone-error" title={`该单元格不是${props.expect}，请用 JSON 高级编辑修正`}>
      <span className="tjson-text">{clipText(JSON.stringify(props.value))}</span>
      <button type="button" data-testid={`${props.testId}-fix`} onClick={props.onOpenJson}>
        编辑 JSON
      </button>
    </span>
  )
}
