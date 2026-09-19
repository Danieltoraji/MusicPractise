/**
 * 节点 Inspector（3-5 结构化重做）：选中节点的参数表单（按 kind 渲染）。
 * 设计目标：用户不写代码——事件/实例/方法/变量全部下拉选择，字面量走类型化控件，
 * 条件用比较构造器，call 参数按命令契约出键值对；表达式输入仅作高级兜底（原文保留）。
 * 编辑即提交（控件内部自管草稿、失焦/离散动作提交），切节点由 key 重挂载重置草稿。
 */
import { useState } from 'react'
import { exprFunctionNames } from '../../engine/expr'
import type { LevelDoc } from '../../engine/level'
import { LEVEL_METHODS, type GNode, type LintIssue } from '../../engine/graphProgram'
import { BASE_COMMANDS, type ContractDoc } from '../../runtime/componentDef'
import { getDef } from '../../runtime/store'
import { parseCommandParams, exprToOperand, type BridgeCtx, type Operand } from './exprBridge'
import { CallArgsEditor, ConditionBuilder, OperandBody, OperandPicker, QueryCallEditor } from './controls'

interface Props {
  node: GNode | undefined
  doc: LevelDoc
  issues: LintIssue[]
  onPatch: (patch: Partial<GNode>) => void
  onRemove: () => void
}

const exprDatalistId = 'ginsp-expr-options'

const BASE_COMMAND_DOCS: Record<string, string> = {
  setVisible: '{ visible: boolean }',
  setEnabled: '{ enabled: boolean }',
}

export function NodeInspector({ node, doc, issues, onPatch, onRemove }: Props) {
  if (!node) {
    return (
      <div className="ginsp">
        <div className="glib-title">属性</div>
        <p className="muted">选中一个节点后在这里编辑参数。双击连线可断开。</p>
      </div>
    )
  }
  // key = 节点 id：切换节点即重挂载，控件内部草稿不跨节点泄漏
  return <InspectorBody key={node.id} node={node} doc={doc} issues={issues} onPatch={onPatch} onRemove={onRemove} />
}

function InspectorBody({ node, doc, issues, onPatch, onRemove }: Props & { node: GNode }) {
  const comps = doc.content.components
  const program = doc.content.logic

  const contractOf = (type: string): ContractDoc | null => {
    try {
      return getDef(type).contract
    } catch {
      return null
    }
  }

  // 变量候选：关卡 variables + 题目 logicPatch.variables（与 lint 声明集合一致）
  const varNames = [
    ...new Set([
      ...Object.keys(program.variables ?? {}),
      ...doc.content.questions.flatMap((q) => Object.keys(q.logicPatch?.variables ?? {})),
    ]),
  ]

  // 路径候选：程序里 on 事件的负载字段（如 staff1.noteClicked → event.midi）
  const refPaths: string[] = []
  for (const n of program.nodes) {
    if (n.kind !== 'on') continue
    const dot = n.event.indexOf('.')
    if (dot <= 0) continue
    const ct = contractOf(comps.find((c) => c.id === n.event.slice(0, dot))?.type ?? '')
    const tail = n.event.slice(dot + 1)
    const fields = parseCommandParams(ct?.events[tail])
    for (const f of fields ?? []) {
      const path = `event.${f.name}`
      if (!refPaths.includes(path)) refPaths.push(path)
    }
  }
  const ctx: BridgeCtx = { varNames, refPaths }

  // on 事件候选：生命周期 / 组件事件 / 已出现的内部事件
  const internalEvents = [
    ...new Set(
      program.nodes.flatMap((n) =>
        n.kind === 'on' && n.event.includes(':')
          ? [n.event]
          : n.kind === 'emit' && n.event.includes(':')
            ? [n.event]
            : [],
      ),
    ),
  ]
  const eventGroups: { group: string; items: { value: string; label: string }[] }[] = [
    {
      group: '关卡',
      items: [
        { value: 'level.started', label: '关卡开始' },
        { value: 'level.questionLoaded', label: '题目载入' },
        { value: 'level.finished', label: '关卡结算' },
      ],
    },
    {
      group: '组件事件',
      items: comps.flatMap((c) => {
        const ct = contractOf(c.type)
        return Object.keys(ct?.events ?? {}).map((tail) => ({
          value: `${c.id}.${tail}`,
          label: `${c.name || c.id} · ${tail}`,
        }))
      }),
    },
    ...(internalEvents.length > 0 ? [{ group: '内部事件', items: internalEvents.map((e) => ({ value: e, label: e })) }] : []),
  ]

  // call 方法候选（契约命令 + 基座命令；level 用 facade 方法）
  const methodOptions = (target: string): { name: string; doc?: string }[] => {
    if (target === 'level') return LEVEL_METHODS.map((m) => ({ name: m, doc: '无参数' }))
    const ct = contractOf(comps.find((c) => c.id === target)?.type ?? '')
    const own = Object.entries(ct?.commands ?? {})
      .filter(([m]) => !m.startsWith('__'))
      .map(([name, doc]) => ({ name, doc }))
    // 基座命令补差集：契约已声明的（如 button.setEnabled）不重复出选项
    const declared = new Set(own.map((o) => o.name))
    const base = [...BASE_COMMANDS].filter((n) => !declared.has(n)).map((n) => ({ name: n, doc: BASE_COMMAND_DOCS[n] }))
    return [...own, ...base]
  }
  const queriesOf = (target: string): string[] =>
    Object.keys(contractOf(comps.find((c) => c.id === target)?.type ?? '')?.queries ?? {})

  return (
    <div className="ginsp">
      <div className="glib-title">
        属性 · {node.kind}
        {issues.length > 0 && <span className="gnode-badge">⚠ {issues.length}</span>}
      </div>
      {issues.length > 0 && (
        <ul className="ginsp-issues">
          {issues.map((i, idx) => (
            <li key={idx} className="tone-error">
              {i.field ? `${i.field}: ` : ''}
              {i.message}
            </li>
          ))}
        </ul>
      )}

      <datalist id={exprDatalistId}>
        {varNames.map((v) => (
          <option key={`v-${v}`} value={`v.${v}`} />
        ))}
        {refPaths.map((p) => (
          <option key={`p-${p}`} value={p} />
        ))}
        <option value="q.data" />
        {exprFunctionNames.map((fn) => (
          <option key={fn} value={`${fn}(`} label={fn} />
        ))}
      </datalist>

      {node.kind === 'on' && <OnEventEditor node={node} groups={eventGroups} onPatch={onPatch} />}

      {node.kind === 'call' && (
        <CallNodeEditor node={node} comps={comps} methodOptions={methodOptions} queriesOf={queriesOf} ctx={ctx} onPatch={onPatch} />
      )}

      {node.kind === 'assign' && (
        <AssignNodeEditor node={node} comps={comps} varNames={varNames} queriesOf={queriesOf} ctx={ctx} onPatch={onPatch} />
      )}

      {node.kind === 'branch' && (
        <label className="ginsp-row">
          条件
          <ConditionBuilder cond={node.cond} ctx={ctx} onChange={(expr) => onPatch({ cond: expr })} datalistId={exprDatalistId} />
        </label>
      )}

      {node.kind === 'loop' && <LoopNodeEditor node={node} ctx={ctx} onPatch={onPatch} />}

      {node.kind === 'wait' && (
        <label className="ginsp-row">
          等待时长（毫秒）
          <OperandPicker value={node.ms} ctx={ctx} onChange={(expr) => onPatch({ ms: expr })} datalistId={exprDatalistId} />
        </label>
      )}

      {node.kind === 'emit' && <EmitNodeEditor node={node} internalEvents={internalEvents} ctx={ctx} onPatch={onPatch} />}

      {node.kind === 'comment' && (
        <label className="ginsp-row">
          文本
          <textarea
            defaultValue={node.text}
            rows={2}
            onBlur={(e) => {
              if (e.currentTarget.value !== node.text) onPatch({ text: e.currentTarget.value })
            }}
          />
        </label>
      )}

      <div className="ginsp-meta muted">节点 id：{node.id}（位置随拖动自动保存）</div>
      <button type="button" className="danger" onClick={onRemove}>
        删除该节点
      </button>
    </div>
  )
}

// ---------------------------------------------------------------------------
// on：事件选择器（分组下拉，不手打事件名）
// ---------------------------------------------------------------------------

function OnEventEditor(props: {
  node: Extract<GNode, { kind: 'on' }>
  groups: { group: string; items: { value: string; label: string }[] }[]
  onPatch: (patch: Partial<GNode>) => void
}): React.ReactElement {
  const { node, groups } = props
  const known = new Set(groups.flatMap((g) => g.items.map((i) => i.value)))
  return (
    <label className="ginsp-row">
      事件
      <select value={node.event} onChange={(e) => props.onPatch({ event: e.target.value } as unknown as Partial<GNode>)}>
        {!known.has(node.event) && <option value={node.event}>{`${node.event}（当前）`}</option>}
        {groups.map((g) => (
          <optgroup key={g.group} label={g.group}>
            {g.items.map((i) => (
              <option key={i.value} value={i.value}>
                {i.label}
              </option>
            ))}
          </optgroup>
        ))}
      </select>
    </label>
  )
}

// ---------------------------------------------------------------------------
// call：实例 + 方法 + 按契约键值传参
// ---------------------------------------------------------------------------

function CallNodeEditor(props: {
  node: Extract<GNode, { kind: 'call' }>
  comps: LevelDoc['content']['components']
  methodOptions: (target: string) => { name: string; doc?: string }[]
  queriesOf: (target: string) => string[]
  ctx: BridgeCtx
  onPatch: (patch: Partial<GNode>) => void
}): React.ReactElement {
  const { node, comps } = props
  const compLabel = (id: string): string => comps.find((c) => c.id === id)?.name || id
  const methods = props.methodOptions(node.target)
  const methodKnown = methods.some((m) => m.name === node.method)
  const currentDoc = methods.find((m) => m.name === node.method)?.doc

  return (
    <>
      <label className="ginsp-row">
        实例
        <select
          value={node.target}
          onChange={(e) => {
            const target = e.target.value
            const list = props.methodOptions(target)
            const method = list.some((m) => m.name === node.method) ? node.method : (list[0]?.name ?? '')
            // 切实例连动方法与参数（新方法未知参数 → 重置为无参/空对象由方法分支处理）
            const doc = list.find((m) => m.name === method)?.doc
            const params = parseCommandParams(doc)
            const args = params === null ? node.args : params.length === 0 ? [] : ['{}']
            props.onPatch({ target, method, args } as unknown as Partial<GNode>)
          }}
        >
          {!comps.some((c) => c.id === node.target) && node.target !== 'level' && (
            <option value={node.target}>{`${node.target}（当前，实例不存在）`}</option>
          )}
          <option value="level">关卡（level）</option>
          {comps.map((c) => (
            <option key={c.id} value={c.id}>{`${compLabel(c.id)}（${c.id}）`}</option>
          ))}
        </select>
      </label>
      <label className="ginsp-row">
        动作
        <select
          value={node.method}
          onChange={(e) => {
            const method = e.target.value
            const doc = methods.find((m) => m.name === method)?.doc
            const params = parseCommandParams(doc)
            const args = params === null ? node.args : params.length === 0 ? [] : ['{}']
            props.onPatch({ method, args } as unknown as Partial<GNode>)
          }}
        >
          {!methodKnown && <option value={node.method}>{`${node.method}（当前）`}</option>}
          {methods.map((m) => (
            <option key={m.name} value={m.name}>
              {m.name}
            </option>
          ))}
        </select>
      </label>
      <div className="ginsp-row">
        参数
        {currentDoc && currentDoc !== '无参数' && <div className="muted call-args-doc">{currentDoc}</div>}
        <CallArgsEditor
          args={node.args}
          params={parseCommandParams(currentDoc)}
          ctx={props.ctx}
          onChange={(args) => props.onPatch({ args } as unknown as Partial<GNode>)}
          datalistId={exprDatalistId}
        />
      </div>
    </>
  )
}

// ---------------------------------------------------------------------------
// assign：变量 + 值（数字/文本/开关/引用/查询/高级）
// ---------------------------------------------------------------------------

type RvMode = 'number' | 'string' | 'boolean' | 'ref' | 'query' | 'advanced'

const RV_MODES: { mode: RvMode; label: string; title: string }[] = [
  { mode: 'number', label: '123', title: '数字' },
  { mode: 'string', label: '文', title: '文本' },
  { mode: 'boolean', label: '开/关', title: '是 / 否' },
  { mode: 'ref', label: 'v', title: '变量或路径' },
  { mode: 'query', label: '查询', title: '读取组件状态（如 slider1.getValue()）' },
  { mode: 'advanced', label: 'ƒx', title: '表达式（高级）' },
]

function AssignNodeEditor(props: {
  node: Extract<GNode, { kind: 'assign' }>
  comps: LevelDoc['content']['components']
  varNames: string[]
  queriesOf: (target: string) => string[]
  ctx: BridgeCtx
  onPatch: (patch: Partial<GNode>) => void
}): React.ReactElement {
  const { node } = props
  const missingVar = !props.varNames.includes(node.target)
  return (
    <>
      <label className="ginsp-row">
        变量
        <select value={node.target} onChange={(e) => props.onPatch({ target: e.target.value } as unknown as Partial<GNode>)}>
          {missingVar && <option value={node.target}>{`v.${node.target}（当前，未声明）`}</option>}
          {props.varNames.map((v) => (
            <option key={v} value={v}>{`v.${v}`}</option>
          ))}
        </select>
      </label>
      <div className="ginsp-row">
        值
        <RValueEditor node={node} comps={props.comps} queriesOf={props.queriesOf} ctx={props.ctx} onPatch={props.onPatch} />
      </div>
    </>
  )
}

function RValueEditor(props: {
  node: Extract<GNode, { kind: 'assign' }>
  comps: LevelDoc['content']['components']
  queriesOf: (target: string) => string[]
  ctx: BridgeCtx
  onPatch: (patch: Partial<GNode>) => void
}): React.ReactElement {
  const { node } = props
  const value = node.value
  const isCall = 'call' in value
  const operand: Operand = isCall ? { mode: 'advanced', source: '0' } : exprToOperand(value.expr)
  const [mode, setMode] = useState<RvMode>(isCall ? 'query' : operand.mode)

  const writeExpr = (expr: string): void => props.onPatch({ value: { expr } } as unknown as Partial<GNode>)

  const switchMode = (next: RvMode): void => {
    if (next === mode) return
    setMode(next)
    if (next === 'query') {
      const first = props.comps[0]?.id ?? ''
      const method = props.queriesOf(first)[0] ?? ''
      props.onPatch({ value: { call: { target: first, method, args: [] } } } as unknown as Partial<GNode>)
      return
    }
    if (next === 'advanced') {
      // 从表达式切高级：保留原文；从查询切高级：查询不是表达式，落到默认值
      writeExpr(isCall ? '0' : value.expr)
      return
    }
    writeExpr(defaultExprFor(next, props.ctx))
  }

  const effective: Operand =
    mode === 'query'
      ? { mode: 'advanced', source: '0' } // 查询由 QueryCallEditor 渲染，此值不使用
      : !isCall && operand.mode === mode
        ? operand
        : mode === 'advanced'
          ? { mode: 'advanced', source: isCall ? '0' : value.expr }
          : exprToOperand(defaultExprFor(mode, props.ctx))

  return (
    <div className="opv">
      <div className="ginsp-modes opv-modes">
        {RV_MODES.map((m) => (
          <button key={m.mode} type="button" className={m.mode === mode ? 'active' : ''} title={m.title} onClick={() => switchMode(m.mode)}>
            {m.label}
          </button>
        ))}
      </div>
      {mode === 'query' ? (
        <QueryCallEditor
          call={isCall ? value.call : { target: props.comps[0]?.id ?? '', method: '', args: [] }}
          comps={props.comps}
          contractQueries={props.queriesOf}
          onChange={(call) => props.onPatch({ value: { call } } as unknown as Partial<GNode>)}
        />
      ) : (
        <OperandBody operand={effective} ctx={props.ctx} onChange={writeExpr} datalistId={exprDatalistId} />
      )}
    </div>
  )
}

function defaultExprFor(mode: 'number' | 'string' | 'boolean' | 'ref', ctx: BridgeCtx): string {
  switch (mode) {
    case 'number':
      return '0'
    case 'string':
      return '""'
    case 'boolean':
      return 'true'
    case 'ref':
      return ctx.varNames.length > 0 ? `v.${ctx.varNames[0]}` : (ctx.refPaths[0] ?? 'v.score')
  }
}

// ---------------------------------------------------------------------------
// loop：模式 + 次数/条件
// ---------------------------------------------------------------------------

function LoopNodeEditor(props: {
  node: Extract<GNode, { kind: 'loop' }>
  ctx: BridgeCtx
  onPatch: (patch: Partial<GNode>) => void
}): React.ReactElement {
  const { node } = props
  const firstVar = props.ctx.varNames[0]
  return (
    <>
      <label className="ginsp-row">
        模式
        <select
          value={node.mode ?? 'repeat'}
          onChange={(e) => {
            const mode = e.target.value as 'while' | 'repeat'
            const patch =
              mode === 'while'
                ? { mode, cond: node.cond ?? firstVar ?? 'true', times: undefined }
                : { mode, times: node.times ?? '3', cond: undefined }
            props.onPatch(patch as unknown as Partial<GNode>)
          }}
        >
          <option value="repeat">重复固定次数</option>
          <option value="while">满足条件时循环</option>
        </select>
      </label>
      {(node.mode ?? 'repeat') === 'while' ? (
        <label className="ginsp-row">
          条件
          <ConditionBuilder cond={node.cond ?? ''} ctx={props.ctx} onChange={(expr) => props.onPatch({ cond: expr })} datalistId={exprDatalistId} />
        </label>
      ) : (
        <label className="ginsp-row">
          次数
          <OperandPicker value={node.times ?? ''} ctx={props.ctx} onChange={(expr) => props.onPatch({ times: expr })} datalistId={exprDatalistId} />
        </label>
      )}
    </>
  )
}

// ---------------------------------------------------------------------------
// emit：内部事件 + 负载键值对
// ---------------------------------------------------------------------------

function EmitNodeEditor(props: {
  node: Extract<GNode, { kind: 'emit' }>
  internalEvents: string[]
  ctx: BridgeCtx
  onPatch: (patch: Partial<GNode>) => void
}): React.ReactElement {
  const { node } = props
  const payload: Record<string, string> = node.payload ?? {}
  const entries: [string, string][] = Object.entries(payload)

  const write = (next: Record<string, string>): void => {
    const clean: Record<string, string> = {}
    for (const [k, v] of Object.entries(next)) {
      if (k.trim() !== '') clean[k.trim()] = v
    }
    const patch = Object.keys(clean).length > 0 ? { payload: clean } : { payload: undefined }
    props.onPatch(patch as unknown as Partial<GNode>)
  }

  return (
    <>
      <label className="ginsp-row">
        内部事件（名字:名字）
        <input
          defaultValue={node.event}
          list="ginsp-internal-events"
          onBlur={(e) => {
            if (e.currentTarget.value.trim() !== node.event) props.onPatch({ event: e.currentTarget.value.trim() } as unknown as Partial<GNode>)
          }}
        />
        <datalist id="ginsp-internal-events">
          {props.internalEvents.map((e) => (
            <option key={e} value={e} />
          ))}
        </datalist>
      </label>
      <div className="ginsp-row">
        负载（可选）
        {entries.map(([k, v], i) => (
          <div key={`${k}-${i}`} className="ginsp-argline">
            <input
              className="ginsp-payload-key"
              defaultValue={k}
              placeholder="键"
              onBlur={(e) => {
                const key = e.currentTarget.value.trim()
                if (key === k || key === '') {
                  e.currentTarget.value = k
                  return
                }
                const next: Record<string, string> = { ...payload }
                delete next[k]
                next[key] = v
                write(next)
              }}
            />
            <OperandPicker
              compact
              value={v}
              ctx={props.ctx}
              onChange={(expr) => {
                if (expr === v) return
                write({ ...payload, [k]: expr })
              }}
              datalistId={exprDatalistId}
            />
            <button
              type="button"
              className="ginsp-argdel"
              title="删除该负载项"
              onClick={() => {
                const next = { ...payload }
                delete next[k]
                write(next)
              }}
            >
              ×
            </button>
          </div>
        ))}
        <button
          type="button"
          onClick={() => {
            const base = { ...payload }
            let i = 1
            while (`key${i}` in base) i++
            write({ ...base, [`key${i}`]: '""' })
          }}
        >
          + 负载项
        </button>
      </div>
    </>
  )
}
