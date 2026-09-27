/**
 * 数据表字段选择器（docs/26）：「应用行数据」set 命令的值编辑控件。
 * 值是 expr 源文本：裸 q.<列key> 引用 → 下拉直接选中数据表列（列名 + 类型徽标）；
 * 其余表达式 → 高级输入兜底（原文保留，往返无损）。选中列类型不符时内联提示
 * （矩阵与 lint 同源：engine/level 的 DATA_APPLY_ACCEPTED_TYPES）。
 * 纯函数 exprToColumnRef / columnRefToExpr 导出供单测。
 */
import { useState } from 'react'
import { COLUMN_TYPE_LABELS, type ColumnType } from '../../engine/level'
import { ExprInput } from './controls'

export interface TableColumnInfo {
  key: string
  label?: string
  type?: ColumnType
}

/** expr 源文本 → 列 key（仅识别裸 q.<key> 引用且 key 在表内；其余 null） */
export function exprToColumnRef(src: string, keys: readonly string[]): string | null {
  const m = /^q\.([A-Za-z_][A-Za-z0-9_]*)$/.exec(src.trim())
  return m !== null && keys.includes(m[1]) ? m[1] : null
}

/** 列 key → expr 源文本 */
export function columnRefToExpr(key: string): string {
  return `q.${key}`
}

export function TableFieldPicker(props: {
  value: string
  columns: TableColumnInfo[]
  /** 目标槽位接受的列类型（缺省不提示） */
  accepted?: { accept: ColumnType[]; soft?: ColumnType[]; hint: string }
  datalistId?: string
  /** 非列引用值也先显示列下拉（值为「（当前为自定义表达式）」选项）——play notes 等场景 */
  preferSelect?: boolean
  onChange: (expr: string) => void
}): React.ReactElement {
  const keys = props.columns.map((c) => c.key)
  const selected = exprToColumnRef(props.value, keys)
  // 非列引用的非空值 → 默认进高级模式（原文保留）；空值/列引用/强制选择 → 列选择
  const [advanced, setAdvanced] = useState(props.preferSelect !== true && selected === null && props.value.trim() !== '')

  const typeOf = (key: string): ColumnType => props.columns.find((c) => c.key === key)?.type ?? 'text'
  const mismatch =
    selected !== null && props.accepted !== undefined
      ? (() => {
          const t = typeOf(selected)
          return !props.accepted.accept.includes(t) && !(props.accepted.soft ?? []).includes(t)
        })()
      : false

  if (props.columns.length === 0 || advanced) {
    return (
      <div className="tfp">
        <ExprInput
          value={props.value}
          onCommit={props.onChange}
          datalistId={props.datalistId}
          placeholder="表达式（如 q.标题）"
        />
        {props.columns.length > 0 && (
          <button type="button" onClick={() => setAdvanced(false)}>
            选择数据表列
          </button>
        )}
      </div>
    )
  }
  return (
    <div className="tfp">
      <select
        value={selected ?? ''}
        onChange={(e) => {
          if (e.target.value === '__adv__') {
            setAdvanced(true)
            return
          }
          if (e.target.value !== '') props.onChange(columnRefToExpr(e.target.value))
        }}
      >
        {selected === null && props.value.trim() !== '' && <option value="">（当前为自定义表达式）</option>}
        {selected === null && props.value.trim() === '' && <option value="">（选择数据表列…）</option>}
        {props.columns.map((c) => (
          <option key={c.key} value={c.key}>
            {c.label && c.label !== c.key ? `${c.label}（${c.key}）` : c.key} · {COLUMN_TYPE_LABELS[typeOf(c.key)]}
          </option>
        ))}
        <option value="__adv__">高级表达式…</option>
      </select>
      {mismatch && <span className="tfp-warn">⚠ {props.accepted!.hint}</span>}
    </div>
  )
}
