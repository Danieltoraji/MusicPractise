/**
 * v4 图工作台「变量」面板（docs/52 W6.2 变量面板）：
 * - flow：`flow.vars`（run 作用域 v.*）的声明/类型/初值编辑；
 * - behavior：`behavior.locals`（调用局部 local.*）编辑 + 只读展示题型的 state/typeState/args
 *   （这三类归「题型」Tab 的「状态参数」子页维护，这里只给作者引用提示）。
 *
 * 写路径：onChangeProgram(纯函数变换) → GraphWorkbench 单基线 apply → docState tag 'flow'/'behavior'。
 */
import { useEffect, useState } from 'react'
import type { BehaviorProgram, FlowProgram, LevelDocV4, StateFieldDef, StateType } from '../../../engine/v4/model'
import { getType } from '../../../engine/v4/model'
import {
  addDeclaration,
  programDeclarations,
  removeDeclaration,
  updateDeclaration,
  type GraphLayer,
} from './ops'
import { parseInitJson } from './layerConfig'

export interface VariablesPanelProps {
  layer: GraphLayer
  doc: LevelDocV4
  typeId?: string
  program: FlowProgram | BehaviorProgram
  onChangeProgram: (fn: (program: FlowProgram | BehaviorProgram) => FlowProgram | BehaviorProgram) => void
}

const TYPE_LABELS: { value: StateType; label: string }[] = [
  { value: 'number', label: '数字 number' },
  { value: 'boolean', label: '布尔 boolean' },
  { value: 'string', label: '文本 string' },
  { value: 'json', label: 'JSON' },
]

const BOUND: StateType[] = ['number', 'boolean', 'string', 'json']
const boundType = (value: string): StateType => (BOUND.includes(value as StateType) ? (value as StateType) : 'json')

export function VariablesPanel(props: VariablesPanelProps): React.ReactElement {
  const { layer, program } = props
  const fields = programDeclarations(program)
  const prefix = layer === 'flow' ? 'v' : 'local'
  const declaration = layer === 'flow' ? 'run 变量 v.*' : '调用局部 local.*'
  const type = props.typeId !== undefined ? getType(props.doc, props.typeId) : undefined
  return (
    <div className="gvars v4-graph-vars" data-testid="v4-graph-vars">
      <div className="glib-title">{layer === 'flow' ? '变量声明' : '局部变量'}</div>
      <p className="muted v4-graph-vars-hint">
        {layer === 'flow'
          ? 'run 作用域：整局共享，表达式用 v.<名字> 引用；初值在每局开始时写入。'
          : '每次 ask 调用的局部变量：表达式用 local.<名字> 引用；初值在调用开始时写入。'}
      </p>
      {fields.length === 0 && <div className="muted v4-graph-vars-empty">还没有{declaration}——点下方「+ 新增」。</div>}
      {fields.map((field) => (
        <VarRow
          key={field.key}
          prefix={prefix}
          field={field}
          onChange={(patch) => props.onChangeProgram((current) => updateDeclaration(current, field.key, patch))}
          onRemove={() => props.onChangeProgram((current) => removeDeclaration(current, field.key))}
        />
      ))}
      <button
        type="button"
        data-testid="v4-graph-var-add"
        onClick={() =>
          props.onChangeProgram(
            (current) => addDeclaration(current, { type: 'number', value: 0 }).program,
          )
        }
      >
        + 新增{layer === 'flow' ? '变量' : '局部变量'}
      </button>
      {layer === 'behavior' && (
        <div className="v4-graph-vars-readonly" data-testid="v4-graph-vars-behavior-scope">
          <div className="glib-title">题型状态（在「题型 → 状态参数」维护）</div>
          <ScopeList label="q.state.*（每 (题型,行) 一份）" items={(type?.state ?? []).map((field) => field.key)} />
          <ScopeList label="t.*（每题型一份）" items={(type?.typeState ?? []).map((field) => field.key)} />
          <ScopeList label="args.*（ask 调用参数）" items={(type?.args ?? []).map((field) => field.key)} />
        </div>
      )}
    </div>
  )
}

function ScopeList(props: { label: string; items: string[] }): React.ReactElement {
  return (
    <div className="v4-graph-scope-row">
      <span className="muted">{props.label}</span>
      {props.items.length === 0 ? <span className="muted">（空）</span> : props.items.map((key) => <code key={key}>{key}</code>)}
    </div>
  )
}

function VarRow(props: {
  prefix: string
  field: StateFieldDef
  onChange: (patch: { type?: StateType; init?: StateFieldDef['init'] }) => void
  onRemove: () => void
}): React.ReactElement {
  const { field } = props
  const [initText, setInitText] = useState(() => JSON.stringify(field.init) ?? 'null')
  const [initError, setInitError] = useState('')
  useEffect(() => {
    setInitText(JSON.stringify(field.init) ?? 'null')
    setInitError('')
  }, [field.init])
  const commitInit = (): void => {
    const parsed = parseInitJson(initText)
    if (!parsed.ok) {
      setInitError(parsed.error)
      return
    }
    setInitError('')
    if (JSON.stringify(parsed.value) !== JSON.stringify(field.init)) props.onChange({ init: parsed.value })
  }
  return (
    <div className="v4-graph-var-row" data-testid={`v4-graph-var-${field.key}`}>
      <code className="v4-graph-var-name">
        {props.prefix}.{field.key}
      </code>
      <select
        value={field.type}
        data-testid={`v4-graph-var-type-${field.key}`}
        onChange={(event) => props.onChange({ type: boundType(event.target.value) })}
      >
        {TYPE_LABELS.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
      <input
        type="text"
        value={initText}
        spellCheck={false}
        title="初值（JSON 字面量）"
        data-testid={`v4-graph-var-init-${field.key}`}
        onChange={(event) => setInitText(event.target.value)}
        onBlur={commitInit}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault()
            commitInit()
            event.currentTarget.blur()
          }
        }}
      />
      <button
        type="button"
        className="ginsp-argdel"
        title="删除该声明"
        data-testid={`v4-graph-var-remove-${field.key}`}
        onClick={props.onRemove}
      >
        ×
      </button>
      {initError !== '' && (
        <span className="tone-error v4-graph-field-error" data-testid="v4-graph-var-error">
          初值{initError}
        </span>
      )}
    </div>
  )
}
