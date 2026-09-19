/**
 * 节点参数结构化控件（3-5 节点友好化）：
 * - OperandPicker：操作数 = 数字/文本/开关/引用/表达式 五选一（表达式只作高级兜底）
 * - ConditionBuilder：条件 = 左操作数 + 比较符 + 右操作数 / 真值判断 / 高级
 * - CallArgsEditor：call 参数 = 命令契约驱动的键值对（argv 对象字面量）
 * - QueryCallEditor：查询调用（assign 右侧 target.method()）
 *
 * 模式模型：控件内部维护「模式意图」，提交后外部位随读回；切到高级模式只改渲染、
 * 不改数据（原文保留），切到结构化模式才提交该模式的默认值。
 * 输入类控件非受控 + 失焦提交（与画布 Inspector 一致，避免每键全图重算）；
 * 切换节点由外层按 node.id 重挂载，草稿不跨节点泄漏。
 */
import { useState } from 'react'
import { checkExprText } from '../EditorPage'
import {
  CMP_OPS,
  argViewToArgs,
  argsToArgView,
  condToExpr,
  exprToCond,
  exprToOperand,
  operandToExpr,
  paramDefaultExpr,
  type BridgeCtx,
  type CmpOp,
  type Operand,
  type ParamDef,
} from './exprBridge'

// ---------------------------------------------------------------------------
// 高级表达式输入（唯一允许手写表达式的口子；实时校验 + 失焦提交）
// ---------------------------------------------------------------------------

export function ExprInput(props: {
  value: string
  onCommit: (expr: string) => void
  placeholder?: string
  datalistId?: string
}): React.ReactElement {
  const [err, setErr] = useState<string | null>(null)
  return (
    <span className="ginsp-expr">
      <input
        defaultValue={props.value}
        placeholder={props.placeholder}
        list={props.datalistId}
        onInput={(e) => setErr(checkExprText(e.currentTarget.value))}
        onBlur={(e) => {
          const text = e.currentTarget.value.trim()
          if (text !== props.value.trim()) props.onCommit(text)
          setErr(checkExprText(text))
        }}
      />
      {err && <span className="tone-error">{err}</span>}
    </span>
  )
}

// ---------------------------------------------------------------------------
// 操作数选择器
// ---------------------------------------------------------------------------

type OperandMode = Operand['mode']

const OPERAND_MODES: { mode: OperandMode; label: string; title: string }[] = [
  { mode: 'number', label: '123', title: '数字' },
  { mode: 'string', label: '文', title: '文本' },
  { mode: 'boolean', label: '开/关', title: '是 / 否' },
  { mode: 'ref', label: 'v', title: '变量或路径' },
  { mode: 'advanced', label: 'ƒx', title: '表达式（高级）' },
]

function defaultOperandFor(mode: OperandMode, ctx: BridgeCtx): Operand {
  return exprToOperand(defaultExprFor(mode, ctx))
}

function defaultExprFor(mode: OperandMode, ctx: BridgeCtx): string {
  switch (mode) {
    case 'number':
      return '0'
    case 'string':
      return '""'
    case 'boolean':
      return 'true'
    case 'ref':
      return ctx.varNames.length > 0 ? `v.${ctx.varNames[0]}` : (ctx.refPaths[0] ?? 'v.score')
    case 'advanced':
      return '0'
  }
}

/** 单个操作数按当前形态渲染对应控件（不含模式切换条；assign 值编辑器复用） */
export function OperandBody(props: {
  operand: Operand
  ctx: BridgeCtx
  onChange: (expr: string) => void
  datalistId?: string
}): React.ReactElement {
  const { operand, ctx, onChange, datalistId } = props
  switch (operand.mode) {
    case 'number':
      return (
        <input
          type="number"
          defaultValue={operand.value}
          onBlur={(e) => {
            const text = e.currentTarget.value
            if (text === '') return
            const n = Number(text)
            if (Number.isFinite(n) && String(n) !== operandToExpr(operand)) onChange(String(n))
          }}
        />
      )
    case 'string':
      return (
        <input
          defaultValue={operand.value}
          onBlur={(e) => {
            if (e.currentTarget.value !== operand.value) onChange(JSON.stringify(e.currentTarget.value))
          }}
        />
      )
    case 'boolean':
      return (
        <label className="opv-bool">
          <input
            type="checkbox"
            checked={operand.value}
            onChange={(e) => onChange(e.target.checked ? 'true' : 'false')}
          />{' '}
          {operand.value ? '是（true）' : '否（false）'}
        </label>
      )
    case 'ref': {
      if (ctx.varNames.length === 0 && ctx.refPaths.length === 0) {
        return <span className="muted">没有可引用的变量——先在左下「变量」面板添加，或改用表达式</span>
      }
      const known = new Set([...ctx.varNames.map((v) => `v.${v}`), ...ctx.refPaths])
      return (
        <select value={operand.path} onChange={(e) => e.target.value && onChange(e.target.value)}>
          <option value="">（选择…）</option>
          {ctx.varNames.length > 0 && (
            <optgroup label="变量">
              {ctx.varNames.map((v) => (
                <option key={`v-${v}`} value={`v.${v}`}>{`v.${v}`}</option>
              ))}
            </optgroup>
          )}
          {ctx.refPaths.length > 0 && (
            <optgroup label="路径">
              {ctx.refPaths.map((p) => (
                <option key={`p-${p}`} value={p}>{p}</option>
              ))}
            </optgroup>
          )}
          {!known.has(operand.path) && <option value={operand.path}>{`${operand.path}（当前）`}</option>}
        </select>
      )
    }
    case 'advanced':
      return <ExprInput value={operand.source} onCommit={onChange} datalistId={datalistId} placeholder="表达式" />
  }
}

/** 操作数选择器：模式切换条 + 形态控件 */
export function OperandPicker(props: {
  value: string
  ctx: BridgeCtx
  onChange: (expr: string) => void
  datalistId?: string
  compact?: boolean
}): React.ReactElement {
  const operand = exprToOperand(props.value)
  const [mode, setMode] = useState<OperandMode>(operand.mode)
  const effective: Operand =
    operand.mode === mode
      ? operand
      : mode === 'advanced'
        ? { mode: 'advanced', source: operandToExpr(operand) }
        : defaultOperandFor(mode, props.ctx)

  const switchMode = (next: OperandMode): void => {
    if (next === mode) return
    setMode(next)
    // 切高级：保留原文，不提交；切结构化：提交该模式默认值
    if (next !== 'advanced') props.onChange(defaultExprFor(next, props.ctx))
  }

  return (
    <div className={`opv${props.compact ? ' opv-compact' : ''}`}>
      <div className="ginsp-modes opv-modes">
        {OPERAND_MODES.map((m) => {
          const noRef = m.mode === 'ref' && props.ctx.varNames.length === 0 && props.ctx.refPaths.length === 0
          return (
            <button
              key={m.mode}
              type="button"
              className={effective.mode === m.mode ? 'active' : ''}
              title={noRef ? '没有可引用的变量' : m.title}
              disabled={noRef}
              onClick={() => switchMode(m.mode)}
            >
              {m.label}
            </button>
          )
        })}
      </div>
      <OperandBody operand={effective} ctx={props.ctx} onChange={props.onChange} datalistId={props.datalistId} />
    </div>
  )
}

// ---------------------------------------------------------------------------
// 条件构造器（branch / loop-while）
// ---------------------------------------------------------------------------

type CondMode = 'compare' | 'truthy' | 'advanced'

function defaultCondFor(mode: Exclude<CondMode, 'advanced'>, ctx: BridgeCtx): string {
  const ref = ctx.varNames.length > 0 ? `v.${ctx.varNames[0]}` : '0'
  if (mode === 'compare') return `${ref} >= 0`
  return ref === '0' ? 'true' : ref
}

export function ConditionBuilder(props: {
  cond: string
  ctx: BridgeCtx
  onChange: (expr: string) => void
  datalistId?: string
}): React.ReactElement {
  const parsed = exprToCond(props.cond)
  const [mode, setMode] = useState<CondMode>(parsed.mode)
  const effective: import('./exprBridge').Cond =
    parsed.mode === mode
      ? parsed
      : mode === 'advanced'
        ? { mode: 'advanced', source: condToExpr(parsed) }
        : exprToCond(defaultCondFor(mode, props.ctx))

  const switchMode = (next: CondMode): void => {
    if (next === mode) return
    setMode(next)
    if (next !== 'advanced') props.onChange(defaultCondFor(next, props.ctx))
  }

  const writeCompare = (patch: { left?: string; op?: CmpOp; right?: string }): void => {
    if (effective.mode !== 'compare') return
    const left = patch.left ?? operandToExpr(effective.left)
    const op = patch.op ?? effective.op
    const right = patch.right ?? operandToExpr(effective.right)
    props.onChange(`${left} ${op} ${right}`)
  }

  return (
    <div className="cond-b">
      <div className="ginsp-modes opv-modes">
        <button type="button" className={effective.mode === 'compare' ? 'active' : ''} title="左 · 比较 · 右" onClick={() => switchMode('compare')}>
          比较
        </button>
        <button type="button" className={effective.mode === 'truthy' ? 'active' : ''} title="值非 0 / 为真即成立" onClick={() => switchMode('truthy')}>
          真值
        </button>
        <button type="button" className={effective.mode === 'advanced' ? 'active' : ''} title="手写表达式（高级）" onClick={() => switchMode('advanced')}>
          高级
        </button>
      </div>
      {effective.mode === 'compare' ? (
        <>
          <OperandPicker compact value={operandToExpr(effective.left)} ctx={props.ctx} onChange={(expr) => writeCompare({ left: expr })} datalistId={props.datalistId} />
          <select className="cond-b-op" value={effective.op} onChange={(e) => writeCompare({ op: e.target.value as CmpOp })}>
            {(CMP_OPS as readonly CmpOp[]).map((op) => (
              <option key={op} value={op}>{op}</option>
            ))}
          </select>
          <OperandPicker compact value={operandToExpr(effective.right)} ctx={props.ctx} onChange={(expr) => writeCompare({ right: expr })} datalistId={props.datalistId} />
        </>
      ) : effective.mode === 'truthy' ? (
        <>
          <OperandPicker compact value={operandToExpr(effective.operand)} ctx={props.ctx} onChange={props.onChange} datalistId={props.datalistId} />
          <span className="muted cond-b-hint">值非 0 / 为真 → 走「真」出口</span>
        </>
      ) : (
        <ExprInput value={effective.source} onCommit={props.onChange} datalistId={props.datalistId} placeholder="条件表达式" />
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// call 参数（命令 argv 的键值对）
// ---------------------------------------------------------------------------

type ArgMode = 'none' | 'object' | 'advanced'

export function CallArgsEditor(props: {
  args: string[]
  /** 命令契约参数（null = 签名未知，不提供键建议） */
  params: ParamDef[] | null
  ctx: BridgeCtx
  onChange: (args: string[]) => void
  datalistId?: string
}): React.ReactElement {
  const view = argsToArgView(props.args)
  const [mode, setMode] = useState<ArgMode>(view.mode)
  const effective: import('./exprBridge').ArgView =
    view.mode === mode ? view : mode === 'advanced' ? { mode: 'advanced', sources: argViewToArgs(view) } : { mode: 'object', entries: [] }

  const switchMode = (next: ArgMode): void => {
    if (next === mode) return
    setMode(next)
    if (next === 'none') props.onChange([])
    else if (next === 'object') props.onChange(['{}'])
    // advanced：保留现有参数原文，不提交
  }

  const writeEntries = (entries: { key: string; source: string }[]): void => {
    props.onChange(argViewToArgs({ mode: 'object', entries }))
  }
  const setEntry = (i: number, patch: Partial<{ key: string; source: string }>): void => {
    if (effective.mode !== 'object') return
    writeEntries(effective.entries.map((e, j) => (j === i ? { ...e, ...patch } : e)))
  }

  const entries = effective.mode === 'object' ? effective.entries : []
  const usedKeys = new Set(entries.map((e) => e.key))
  const missingParams = (props.params ?? []).filter((p) => !usedKeys.has(p.name))

  return (
    <div className="call-args">
      <div className="ginsp-modes opv-modes">
        <button type="button" className={effective.mode === 'none' ? 'active' : ''} onClick={() => switchMode('none')}>
          无参数
        </button>
        <button type="button" className={effective.mode === 'object' ? 'active' : ''} onClick={() => switchMode('object')}>
          按名传参
        </button>
        <button type="button" className={effective.mode === 'advanced' ? 'active' : ''} title="原始表达式（高级）" onClick={() => switchMode('advanced')}>
          高级
        </button>
      </div>
      {effective.mode === 'object' && (
        <>
          {entries.map((entry, i) => (
            <div key={`${entry.key}-${i}`} className="ginsp-argline">
              <input
                className="ginsp-payload-key"
                defaultValue={entry.key}
                placeholder="参数名"
                list={props.datalistId ? `${props.datalistId}-params` : undefined}
                onBlur={(e) => {
                  const key = e.currentTarget.value.trim()
                  if (key !== '' && key !== entry.key && !usedKeys.has(key)) setEntry(i, { key })
                  else e.currentTarget.value = entry.key
                }}
              />
              <OperandPicker compact value={entry.source} ctx={props.ctx} onChange={(expr) => setEntry(i, { source: expr })} datalistId={props.datalistId} />
              <button type="button" className="ginsp-argdel" title="删除该参数" onClick={() => writeEntries(entries.filter((_, j) => j !== i))}>
                ×
              </button>
            </div>
          ))}
          {props.datalistId && (
            <datalist id={`${props.datalistId}-params`}>
              {(props.params ?? []).map((p) => (
                <option key={p.name} value={p.name} label={p.typeDoc} />
              ))}
            </datalist>
          )}
          <div className="call-args-actions">
            <button
              type="button"
              onClick={() => {
                let i = 1
                while (usedKeys.has(`key${i}`)) i++
                writeEntries([...entries, { key: `key${i}`, source: '""' }])
              }}
            >
              + 参数
            </button>
            {missingParams.length > 0 && (
              <button
                type="button"
                title={`按契约补齐：${missingParams.map((p) => p.name).join('、')}`}
                onClick={() => writeEntries([...entries, ...missingParams.map((p) => ({ key: p.name, source: paramDefaultExpr(p) }))])}
              >
                按契约补全（{missingParams.map((p) => p.name).join('、')}）
              </button>
            )}
          </div>
        </>
      )}
      {effective.mode === 'advanced' && (
        <div className="opv-adv">
          <ExprInput
            value={effective.sources[0] ?? ''}
            onCommit={(expr) => props.onChange([expr, ...effective.sources.slice(1)])}
            datalistId={props.datalistId}
            placeholder="参数表达式"
          />
          {effective.sources.length > 1 && <span className="muted">其余 {effective.sources.length - 1} 个参数保持原样</span>}
        </div>
      )}
      {effective.mode === 'none' && <span className="muted cond-b-hint">该调用不传参数</span>}
    </div>
  )
}

// ---------------------------------------------------------------------------
// 查询调用（assign 右侧 target.method()）
// ---------------------------------------------------------------------------

export function QueryCallEditor(props: {
  call: { target: string; method: string; args: string[] }
  comps: { id: string; name?: string }[]
  contractQueries: (compId: string) => string[]
  onChange: (call: { target: string; method: string; args: string[] }) => void
}): React.ReactElement {
  const compLabel = (id: string): string => props.comps.find((c) => c.id === id)?.name || id
  const targetKnown = props.comps.some((c) => c.id === props.call.target)
  return (
    <div className="query-call">
      <select
        value={props.call.target}
        onChange={(e) => {
          const target = e.target.value
          const methods = props.contractQueries(target)
          const method = methods.includes(props.call.method) ? props.call.method : (methods[0] ?? '')
          props.onChange({ target, method, args: [] })
        }}
      >
        {!targetKnown && props.call.target && (
          <option value={props.call.target}>{`${props.call.target}（当前，实例不存在）`}</option>
        )}
        {props.comps.map((c) => (
          <option key={c.id} value={c.id}>{`${compLabel(c.id)}（${c.id}）`}</option>
        ))}
      </select>
      <select value={props.call.method} onChange={(e) => props.onChange({ ...props.call, method: e.target.value })}>
        <option value="">（选择查询方法）</option>
        {props.contractQueries(props.call.target).map((m) => (
          <option key={m} value={m}>{m}</option>
        ))}
      </select>
      {props.call.method && <span className="muted cond-b-hint">{`${compLabel(props.call.target)}.${props.call.method}()`}</span>}
    </div>
  )
}
