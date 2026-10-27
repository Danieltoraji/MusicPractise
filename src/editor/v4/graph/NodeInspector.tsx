/**
 * v4 节点检查器（docs/53 §13.4）：按层作用域渲染节点字段表单。
 *
 * - 表达式输入实时校验（`checkV4Expr`：语法/根/函数白名单；flow 独有 stateOf/contentOf）；
 *   assign 目标额外用 `validateWriteTarget` 校验层级写权限（v./local. vs q.state./t./local.）；
 * - 事件/视图/组件/命令/查询全部下拉（低代码），只对无法枚举的表达式留自由输入；
 * - 提交即文档变更（失焦/Enter/离散动作），由 GraphWorkbench 统一走 `onPatch` → 单基线 apply；
 *   tag='flow'/'behavior' 由宿主承担撤销合并。
 */
import { useEffect, useState } from 'react'
import type { BehaviorProgram, FlowProgram, LevelDocV4 } from '../../../engine/v4/model'
import { getType } from '../../../engine/v4/model'
import { checkV4Expr, validateWriteTarget } from '../../../engine/v4/expr'
import type { V4Issue } from '../../../engine/v4/validate'
import { BASE_COMMANDS } from '../../../runtime/componentDef'
import {
  componentCommands,
  componentQueries,
  exprCheckOptions,
  layerRootHint,
  onEventCandidates,
  shellComponents,
  shellEventCandidates,
  surfaceComponents,
  surfaceViews,
} from './layerConfig'
import type { AnyGraphNode, GraphLayer } from './ops'
import { nodeKindLabel } from './summary'

const EXPR_DATALIST_ID = 'v4-graph-expr-options'

export interface NodeInspectorProps {
  layer: GraphLayer
  doc: LevelDocV4
  typeId?: string
  program: FlowProgram | BehaviorProgram
  node: AnyGraphNode | undefined
  /** 该节点的 lint 问题（红字列出） */
  issues: V4Issue[]
  onPatch: (patch: Record<string, unknown>) => void
  onRemove: () => void
}

export function NodeInspector(props: NodeInspectorProps): React.ReactElement {
  const { node } = props
  if (!node) {
    return (
      <div className="ginsp v4-graph-inspector" data-testid="v4-graph-inspector">
        <div className="glib-title">属性</div>
        <p className="muted">选中一个节点后在这里编辑参数。删除键可删除选中节点/连线。</p>
      </div>
    )
  }
  // key = 节点 id：切换节点即重挂载，输入草稿不跨节点泄漏
  return <InspectorBody key={node.id} {...props} node={node} />
}

// ---------------------------------------------------------------------------
// 通用控件：表达式输入（本地草稿 + 实时校验 + 失焦/Enter 提交）
// ---------------------------------------------------------------------------

function ExprInput(props: {
  label: string
  value: string | undefined
  layer: GraphLayer
  hint?: string
  placeholder?: string
  optional?: boolean
  rows?: number
  testId?: string
  onCommit: (value: string | undefined) => void
}): React.ReactElement {
  const { label, value, layer, optional, hint, placeholder } = props
  const [text, setText] = useState(value ?? '')
  useEffect(() => {
    setText(value ?? '')
  }, [value])
  const trimmed = text.trim()
  const empty = trimmed === ''
  const validation = empty ? null : checkV4Expr(trimmed, exprCheckOptions(layer))
  const error = validation !== null && !validation.ok ? validation.message : empty && optional !== true ? `${label}不能为空` : ''
  const commit = (): void => {
    // 实时校验不通过不提交：避免把语法/作用域错误写进文档（lint 只作为兜底）
    if (error !== '') return
    const next = trimmed === '' ? undefined : trimmed
    if (next !== (value ?? undefined)) props.onCommit(next)
  }
  const common = {
    value: text,
    spellCheck: false,
    'data-testid': props.testId,
    placeholder,
    list: EXPR_DATALIST_ID,
    onChange: (event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setText(event.target.value),
    onBlur: commit,
    onKeyDown: (event: React.KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      if (event.key === 'Enter' && (event.target as HTMLElement).tagName !== 'TEXTAREA') {
        event.preventDefault()
        commit()
        ;(event.target as HTMLElement).blur()
      }
    },
  }
  return (
    <label className="ginsp-row v4-graph-field">
      <span className="v4-graph-field-label">
        {label}
        {optional === true && <span className="muted">（可选）</span>}
      </span>
      {props.rows !== undefined ? (
        <textarea rows={props.rows} {...common} />
      ) : (
        <input type="text" {...common} />
      )}
      {hint !== undefined && <span className="muted v4-graph-field-hint">{hint}</span>}
      {error !== '' && (
        <span className="tone-error v4-graph-field-error" data-testid="v4-graph-field-error">
          {error}
        </span>
      )}
    </label>
  )
}

/** 受限文本字段（本地 id / 事件名）：实时给形态错误，失焦提交 */
function IdInput(props: {
  label: string
  value: string | undefined
  pattern?: RegExp
  patternHint?: string
  optional?: boolean
  testId?: string
  onCommit: (value: string | undefined) => void
}): React.ReactElement {
  const { label, value, pattern, optional } = props
  const [text, setText] = useState(value ?? '')
  useEffect(() => {
    setText(value ?? '')
  }, [value])
  const trimmed = text.trim()
  const empty = trimmed === ''
  const error = empty
    ? optional === true
      ? ''
      : `${label}不能为空`
    : pattern !== undefined && !pattern.test(trimmed)
      ? `${label}形态非法：${props.patternHint ?? '需字母/下划线开头，仅含字母数字下划线短横'}`
      : ''
  const commit = (): void => {
    if (error !== '') return
    const next = trimmed === '' ? undefined : trimmed
    if (next !== (value ?? undefined)) props.onCommit(next)
  }
  return (
    <label className="ginsp-row v4-graph-field">
      <span className="v4-graph-field-label">
        {label}
        {optional === true && <span className="muted">（可选，留空删除）</span>}
      </span>
      <input
        type="text"
        value={text}
        spellCheck={false}
        data-testid={props.testId}
        onChange={(event) => setText(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault()
            commit()
            ;(event.currentTarget as HTMLElement).blur()
          }
        }}
      />
      {error !== '' && (
        <span className="tone-error v4-graph-field-error" data-testid="v4-graph-field-error">
          {error}
        </span>
      )}
    </label>
  )
}

function CommitInput(props: {
  label: string
  value: string
  rows?: number
  testId?: string
  onCommit: (value: string) => void
}): React.ReactElement {
  const [text, setText] = useState(props.value)
  useEffect(() => {
    setText(props.value)
  }, [props.value])
  const commit = (): void => {
    if (text !== props.value) props.onCommit(text)
  }
  return (
    <label className="ginsp-row v4-graph-field">
      <span className="v4-graph-field-label">{props.label}</span>
      {props.rows !== undefined ? (
        <textarea
          rows={props.rows}
          value={text}
          spellCheck={false}
          data-testid={props.testId}
          onChange={(event) => setText(event.target.value)}
          onBlur={commit}
        />
      ) : (
        <input
          type="text"
          value={text}
          spellCheck={false}
          data-testid={props.testId}
          onChange={(event) => setText(event.target.value)}
          onBlur={commit}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault()
              commit()
              ;(event.currentTarget as HTMLElement).blur()
            }
          }}
        />
      )}
    </label>
  )
}

function SelectField(props: {
  label: string
  value: string
  testId?: string
  options: { value: string; label: string }[]
  onChange: (value: string) => void
}): React.ReactElement {
  const known = props.options.some((option) => option.value === props.value)
  return (
    <label className="ginsp-row v4-graph-field">
      <span className="v4-graph-field-label">{props.label}</span>
      <select value={props.value} data-testid={props.testId} onChange={(event) => props.onChange(event.target.value)}>
        {!known && <option value={props.value}>{`${props.value}（当前值）`}</option>}
        {props.options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </label>
  )
}

// ---------------------------------------------------------------------------
// 检查器主体
// ---------------------------------------------------------------------------

function InspectorBody(props: NodeInspectorProps & { node: AnyGraphNode }): React.ReactElement {
  const { node, layer, doc, typeId, program, issues, onPatch, onRemove } = props
  const flow = layer === 'flow'
  const shell = shellComponents(doc)
  const surface = surfaceComponents(doc, typeId)
  const components = flow ? shell : surface
  const declared = declaredScopes(props)

  const componentOptions = components.map((component) => ({
    value: component.id,
    label: `${component.name?.trim() || component.id}（${component.id} · ${component.type}）`,
  }))

  return (
    <div className="ginsp v4-graph-inspector" data-testid="v4-graph-inspector">
      <div className="glib-title">
        属性 · {nodeKindLabel(node)}（{node.kind}）
        {issues.length > 0 && <span className="gnode-badge">⚠ {issues.length}</span>}
      </div>
      {issues.length > 0 && (
        <ul className="ginsp-issues" data-testid="v4-graph-inspector-issues">
          {issues.map((issue, index) => (
            <li key={index} className="tone-error">
              {issue.message}
            </li>
          ))}
        </ul>
      )}
      <ExprDatalist layer={layer} doc={doc} typeId={typeId} declared={declared} />

      {node.kind === 'start' && <p className="muted">流程唯一入口：从这里沿连线执行；start 不能有入边。</p>}
      {node.kind === 'restart' && <p className="muted">restart 是结束点：终止当前 run 并重新开始，不能有出边。</p>}
      {node.kind === 'comment' && (
        <CommitInput
          label="注释文本"
          value={node.text}
          rows={3}
          testId="v4-graph-field-comment"
          onCommit={(text) => onPatch({ text })}
        />
      )}

      {node.kind === 'assign' && (
        <>
          <SelectField
            label="赋值目标"
            value={node.target}
            testId="v4-graph-field-target"
            options={targetOptions(layer, node.target, declared)}
            onChange={(target) => onPatch({ target })}
          />
          <div className="muted v4-graph-field-hint">{layerRootHint(layer)}</div>
          <SelectField
            label="取值方式"
            value={'query' in node.value ? 'query' : 'expr'}
            testId="v4-graph-field-rvalue-mode"
            options={[
              { value: 'expr', label: '表达式' },
              { value: 'query', label: '组件查询（target.method()）' },
            ]}
            onChange={(mode) => {
              if (mode === 'query') {
                const first = components[0]
                onPatch({
                  value: first !== undefined ? { query: { target: first.id, method: componentQueries(first.type)[0] ?? 'getValue' } } : { query: { target: '', method: '' } },
                })
              } else {
                onPatch({ value: { expr: '0' } })
              }
            }}
          />
          {'query' in node.value ? (
            (() => {
              const queryValue = node.value.query
              return (
                <>
                  <SelectField
                    label="查询组件"
                    value={queryValue.target}
                    testId="v4-graph-field-query-target"
                    options={componentOptions}
                    onChange={(target) => onPatch({ value: { query: { ...queryValue, target } } })}
                  />
                  <SelectField
                    label="查询方法"
                    value={queryValue.method}
                    testId="v4-graph-field-query-method"
                    options={queryOptions(queryValue.target, components)}
                    onChange={(method) => onPatch({ value: { query: { ...queryValue, method } } })}
                  />
                  <ExprInput
                    label="查询参数"
                    value={queryValue.arg}
                    layer={layer}
                    optional
                    hint="表达式 → 单参数（缺省无参）"
                    testId="v4-graph-field-query-arg"
                    onCommit={(arg) => onPatch({ value: { query: { ...queryValue, arg } } })}
                  />
                </>
              )
            })()
          ) : (
            <ExprInput
              label="赋值表达式"
              value={node.value.expr}
              layer={layer}
              testId="v4-graph-field-expr"
              onCommit={(expr) => onPatch({ value: { expr: expr ?? '0' } })}
            />
          )}
          <WriteTargetCheck target={node.target} layer={layer} declared={declared} />
        </>
      )}

      {node.kind === 'call' && (
        <>
          <SelectField
            label={flow ? 'shell 组件' : 'surface 组件'}
            value={node.target}
            testId="v4-graph-field-call-target"
            options={componentOptions}
            onChange={(target) => onPatch({ target })}
          />
          <SelectField
            label="命令"
            value={node.method}
            testId="v4-graph-field-call-method"
            options={commandOptions(node.target, components).map((item) => ({
              value: item.name,
              label: item.doc !== undefined && item.doc !== '' ? `${item.name} · ${item.doc}` : item.name,
            }))}
            onChange={(method) => onPatch({ method })}
          />
          <ExprInput
            label="参数"
            value={node.arg}
            layer={layer}
            optional
            hint="表达式 → 单参对象（如 { text: '得分' }）；缺省 {}"
            testId="v4-graph-field-call-arg"
            onCommit={(arg) => onPatch({ arg })}
          />
        </>
      )}

      {node.kind === 'setView' && (
        <SelectField
          label={flow ? '目标视图（shell）' : '目标视图（题内）'}
          value={node.view}
          testId="v4-graph-field-view"
          options={(flow ? doc.content.shell.views : surfaceViews(doc, typeId)).map((view) => ({
            value: view.id,
            label: view.name ?? view.id,
          }))}
          onChange={(view) => onPatch({ view })}
        />
      )}
      {node.kind === 'setView' && !flow && surfaceViews(doc, typeId).length === 0 && (
        <span className="muted v4-graph-field-hint">
          该题型还没有题内视图：先到「题型 → 表现 → 题内视图」添加视图，再回来切视图。
        </span>
      )}

      {node.kind === 'ask' && (
        <>
          <ExprInput
            label="题型/牌堆表达式"
            value={node.target}
            layer={layer}
            hint="如 local.slot / run.questions[0] / { type: 'choice', row: 'row_1' }"
            testId="v4-graph-field-ask-target"
            onCommit={(target) => onPatch({ target: target ?? 'run.questions[0]' })}
          />
          <ExprInput
            label="调用参数"
            value={node.args}
            layer={layer}
            optional
            hint="表达式 → 对象（覆盖题单里的 args）"
            testId="v4-graph-field-ask-args"
            onCommit={(args) => onPatch({ args })}
          />
          <IdInput
            label="结果变量"
            value={node.resultVar}
            pattern={/^[A-Za-z_][A-Za-z0-9_-]*$/}
            testId="v4-graph-field-result-var"
            onCommit={(resultVar) => onPatch({ resultVar: resultVar ?? 'result' })}
          />
          <span className="muted v4-graph-field-hint">返回的 QuestionResult 写入 local.{node.resultVar}</span>
        </>
      )}

      {node.kind === 'foreach' && (
        <>
          <ExprInput
            label="遍历表达式"
            value={node.items}
            layer={layer}
            hint="如 run.questions（数组）"
            testId="v4-graph-field-items"
            onCommit={(items) => onPatch({ items: items ?? 'run.questions' })}
          />
          <IdInput
            label="元素变量"
            value={node.itemVar}
            pattern={/^[A-Za-z_][A-Za-z0-9_-]*$/}
            testId="v4-graph-field-item-var"
            onCommit={(itemVar) => onPatch({ itemVar: itemVar ?? 'item' })}
          />
          <IdInput
            label="下标变量"
            value={node.indexVar}
            pattern={/^[A-Za-z_][A-Za-z0-9_-]*$/}
            optional
            testId="v4-graph-field-index-var"
            onCommit={(indexVar) => onPatch({ indexVar })}
          />
        </>
      )}

      {node.kind === 'branch' && (
        <ExprInput
          label="条件表达式"
          value={node.cond}
          layer={layer}
          hint="真 → 绿色「真」出口；假 → 红色「假」出口"
          testId="v4-graph-field-cond"
          onCommit={(cond) => onPatch({ cond: cond ?? 'true' })}
        />
      )}

      {node.kind === 'loop' && (
        <>
          <SelectField
            label="循环模式"
            value={node.mode}
            testId="v4-graph-field-loop-mode"
            options={[
              { value: 'repeat', label: 'repeat（固定次数）' },
              { value: 'while', label: 'while（条件成立时）' },
            ]}
            onChange={(mode) =>
              mode === 'while'
                ? onPatch({ mode, cond: node.cond ?? node.times ?? 'true', times: undefined })
                : onPatch({ mode, times: node.times ?? node.cond ?? '2', cond: undefined })
            }
          />
          {node.mode === 'while' ? (
            <ExprInput
              label="循环条件"
              value={node.cond}
              layer={layer}
              testId="v4-graph-field-loop-cond"
              onCommit={(cond) => onPatch({ cond: cond ?? 'false' })}
            />
          ) : (
            <ExprInput
              label="重复次数"
              value={node.times}
              layer={layer}
              testId="v4-graph-field-loop-times"
              onCommit={(times) => onPatch({ times: times ?? '2' })}
            />
          )}
        </>
      )}

      {node.kind === 'wait' && (
        <ExprInput
          label="等待毫秒"
          value={node.ms}
          layer={layer}
          hint="0–600000；运行时可被取消"
          testId="v4-graph-field-ms"
          onCommit={(ms) => onPatch({ ms: ms ?? '500' })}
        />
      )}

      {node.kind === 'waitShell' && (
        <>
          <SelectField
            label="等待事件"
            value={node.event}
            testId="v4-graph-field-waitshell-event"
            options={shellEventCandidates(doc).map((candidate) => ({ value: candidate.value, label: candidate.label }))}
            onChange={(event) => onPatch({ event })}
          />
          <span className="muted v4-graph-field-hint">只匹配该 shell 组件事件；其它 shell 事件忽略</span>
        </>
      )}

      {node.kind === 'finish' && (
        <ExprInput
          label="通过条件"
          value={node.passed}
          layer={layer}
          optional
          hint="缺省视为 true；写表达式如 v.score >= 60"
          testId="v4-graph-field-passed"
          onCommit={(passed) => onPatch({ passed })}
        />
      )}

      {node.kind === 'on' && (
        <OnEventField node={node} doc={doc} typeId={typeId} program={program as BehaviorProgram} onPatch={onPatch} />
      )}

      {node.kind === 'return' && (
        <ExprInput
          label="返回值（QuestionResult）"
          value={node.result}
          layer={layer}
          rows={3}
          hint="{ status, correct, scoreDelta, payload, message }；首个 return 生效"
          testId="v4-graph-field-return"
          onCommit={(result) => onPatch({ result: result ?? "{ status: 'answered' }" })}
        />
      )}

      {node.kind === 'emit' && <EmitFields node={node} layer={layer} onPatch={onPatch} />}

      <div className="ginsp-meta muted">
        节点 id：{node.id}（位置随拖动自动保存）
      </div>
      <button type="button" className="danger" data-testid="v4-graph-delete-node" onClick={onRemove}>
        删除该节点
      </button>
    </div>
  )
}

// ---------------------------------------------------------------------------
// on 事件 / emit 负载
// ---------------------------------------------------------------------------

function OnEventField(props: {
  node: Extract<AnyGraphNode, { kind: 'on' }>
  doc: LevelDocV4
  typeId?: string
  program: BehaviorProgram
  onPatch: (patch: Record<string, unknown>) => void
}): React.ReactElement {
  const candidates = onEventCandidates(props.doc, props.typeId, props.program)
  const known = candidates.some((candidate) => candidate.value === props.node.event)
  const invalid = !/^(start|internal\.[A-Za-z_][A-Za-z0-9_-]*|[A-Za-z_][A-Za-z0-9_-]*\.[A-Za-z_][A-Za-z0-9_-]*)$/.test(props.node.event)
  return (
    <>
      <label className="ginsp-row v4-graph-field">
        <span className="v4-graph-field-label">事件</span>
        <select
          value={props.node.event}
          data-testid="v4-graph-field-on-event"
          onChange={(event) => props.onPatch({ event: event.target.value })}
        >
          {!known && <option value={props.node.event}>{`${props.node.event}（当前）`}</option>}
          {candidates.map((candidate) => (
            <option key={candidate.value} value={candidate.value}>
              {candidate.label}
            </option>
          ))}
        </select>
        {invalid && (
          <span className="tone-error v4-graph-field-error" data-testid="v4-graph-field-error">
            事件形态非法：需 start / internal.&lt;名字&gt; / &lt;组件id&gt;.&lt;事件名&gt;
          </span>
        )}
      </label>
      <span className="muted v4-graph-field-hint">
        候选来自本题 surface 组件事件 + start + internal.*（internal 事件由 emit 节点声明）
      </span>
      <IdInput
        label="自定义事件名（高级）"
        value={props.node.event}
        pattern={/^(start|internal\.[A-Za-z_][A-Za-z0-9_-]*|[A-Za-z_][A-Za-z0-9_-]*\.[A-Za-z_][A-Za-z0-9_-]*)$/}
        patternHint="需 start / internal.<名字> / <组件id>.<事件名>"
        testId="v4-graph-field-on-event-custom"
        onCommit={(event) => {
          if (event !== undefined) props.onPatch({ event })
        }}
      />
    </>
  )
}

function EmitFields(props: {
  node: Extract<AnyGraphNode, { kind: 'emit' }>
  layer: GraphLayer
  onPatch: (patch: Record<string, unknown>) => void
}): React.ReactElement {
  const payload = props.node.payload ?? {}
  const entries = Object.entries(payload)
  const write = (next: Record<string, string>): void => {
    const clean: Record<string, string> = {}
    for (const [key, value] of Object.entries(next)) {
      const trimmed = key.trim()
      if (trimmed !== '') clean[trimmed] = value
    }
    props.onPatch({ payload: Object.keys(clean).length > 0 ? clean : undefined })
  }
  return (
    <>
      <IdInput
        label="内部事件名"
        value={props.node.event}
        pattern={/^internal\.[A-Za-z_][A-Za-z0-9_-]*$/}
        patternHint="必须是 internal.<名字>"
        testId="v4-graph-field-emit-event"
        onCommit={(event) => props.onPatch({ event: event ?? 'internal.event' })}
      />
      <div className="ginsp-row v4-graph-field">
        <span className="v4-graph-field-label">负载（可选）</span>
        {entries.map(([key, value], index) => (
          <div key={`${key}-${index}`} className="ginsp-argline">
            <input
              className="ginsp-payload-key"
              defaultValue={key}
              placeholder="键"
              data-testid={`v4-graph-field-payload-key-${index}`}
              onBlur={(event) => {
                const nextKey = event.currentTarget.value.trim()
                if (nextKey === key || nextKey === '' || nextKey in payload) {
                  event.currentTarget.value = key
                  return
                }
                const next: Record<string, string> = { ...payload }
                delete next[key]
                next[nextKey] = value
                write(next)
              }}
            />
            <ExprInput
              label=""
              value={value}
              layer={props.layer}
              testId={`v4-graph-field-payload-value-${index}`}
              onCommit={(expr) => write({ ...payload, [key]: expr ?? 'null' })}
            />
            <button
              type="button"
              className="ginsp-argdel"
              title="删除该负载项"
              onClick={() => {
                const next: Record<string, string> = { ...payload }
                delete next[key]
                write(next)
              }}
            >
              ×
            </button>
          </div>
        ))}
        <button
          type="button"
          data-testid="v4-graph-field-payload-add"
          onClick={() => {
            let index = 1
            while (`key${index}` in payload) index += 1
            write({ ...payload, [`key${index}`]: '""' })
          }}
        >
          + 负载项
        </button>
      </div>
    </>
  )
}

// ---------------------------------------------------------------------------
// 作用域 / 候选
// ---------------------------------------------------------------------------

interface DeclaredScopes {
  vars: string[]
  locals: string[]
  qState: string[]
  typeState: string[]
  args: string[]
}

function declaredScopes(props: NodeInspectorProps): DeclaredScopes {
  const { layer, doc, typeId, program } = props
  if (layer === 'flow') {
    const flow = program as { vars?: { key: string }[]; nodes: AnyGraphNode[] }
    const locals = new Set<string>()
    for (const node of flow.nodes) {
      if (node.kind === 'ask') locals.add(node.resultVar)
      else if (node.kind === 'foreach') {
        locals.add(node.itemVar)
        if (node.indexVar !== undefined) locals.add(node.indexVar)
      } else if (node.kind === 'assign' && node.target.startsWith('local.')) {
        locals.add(node.target.slice('local.'.length).split('.')[0])
      }
    }
    return { vars: (flow.vars ?? []).map((field) => field.key), locals: [...locals], qState: [], typeState: [], args: [] }
  }
  const type = typeId !== undefined ? getType(doc, typeId) : undefined
  const behavior = program as BehaviorProgram
  return {
    vars: [],
    locals: (behavior.locals ?? []).map((field) => field.key),
    qState: (type?.state ?? []).map((field) => field.key),
    typeState: (type?.typeState ?? []).map((field) => field.key),
    args: (type?.args ?? []).map((field) => field.key),
  }
}

function targetOptions(
  layer: GraphLayer,
  current: string,
  declared: DeclaredScopes,
): { value: string; label: string }[] {
  const options: { value: string; label: string }[] = []
  if (layer === 'flow') {
    for (const key of declared.vars) options.push({ value: `v.${key}`, label: `v.${key}（run 变量）` })
    for (const key of declared.locals) options.push({ value: `local.${key}`, label: `local.${key}（调用局部）` })
    if (options.length === 0) {
      options.push({ value: 'v.score', label: 'v.score（先在变量面板声明 run 变量）' })
    }
  } else {
    for (const key of declared.qState) options.push({ value: `q.state.${key}`, label: `q.state.${key}（实例态）` })
    for (const key of declared.typeState) options.push({ value: `t.${key}`, label: `t.${key}（题型态）` })
    for (const key of declared.locals) options.push({ value: `local.${key}`, label: `local.${key}（调用局部）` })
    if (options.length === 0) {
      options.push({ value: 'q.state.answered', label: 'q.state.answered（先在题型 Tab 声明状态字段）' })
    }
  }
  // 当前值不在候选（JSON 手写）时补一项，避免 select 显示与文档脱节
  if (!options.some((option) => option.value === current)) options.unshift({ value: current, label: `${current}（当前）` })
  return options
}

function commandOptions(target: string, components: { id: string; type: string }[]): { name: string; doc?: string }[] {
  const component = components.find((candidate) => candidate.id === target)
  return component !== undefined ? componentCommands(component.type) : [...BASE_COMMANDS].map((name) => ({ name }))
}

function queryOptions(target: string, components: { id: string; type: string }[]): { value: string; label: string }[] {
  const component = components.find((candidate) => candidate.id === target)
  const methods = component !== undefined ? componentQueries(component.type) : []
  return methods.map((method) => ({ value: method, label: method }))
}

function WriteTargetCheck(props: { target: string; layer: GraphLayer; declared: DeclaredScopes }): React.ReactElement | null {
  const message = validateWriteTarget(props.target, props.layer, {
    vars: props.declared.vars,
    locals: props.declared.locals,
    qState: props.declared.qState,
    typeState: props.declared.typeState,
  })
  if (message === null) return null
  return (
    <span className="tone-error v4-graph-field-error" data-testid="v4-graph-field-error">
      {message}
    </span>
  )
}

/** 表达式候选 datalist（变量/路径提示；输入仍自由，供高级表达式使用） */
function ExprDatalist(props: {
  layer: GraphLayer
  doc: LevelDocV4
  typeId?: string
  declared: DeclaredScopes
}): React.ReactElement {
  const suggestions: string[] = []
  if (props.layer === 'flow') {
    suggestions.push('run.questions', 'run.total', 'run.index', 'run.seed')
    for (const key of props.declared.vars) suggestions.push(`v.${key}`)
    for (const key of props.declared.locals) suggestions.push(`local.${key}`)
  } else {
    suggestions.push('event.name', 'event.payload', 'run.questions', 'q.id')
    for (const key of props.declared.vars) suggestions.push(`v.${key}`)
    for (const key of props.declared.qState) suggestions.push(`q.state.${key}`)
    for (const key of props.declared.typeState) suggestions.push(`t.${key}`)
    for (const key of props.declared.args) suggestions.push(`args.${key}`)
    for (const key of props.declared.locals) suggestions.push(`local.${key}`)
    const table = props.typeId !== undefined ? props.doc.content.tables[props.typeId] : undefined
    for (const column of table?.columns ?? []) suggestions.push(`q.${column.key}`)
  }
  return (
    <datalist id={EXPR_DATALIST_ID}>
      {suggestions.map((value) => (
        <option key={value} value={value} />
      ))}
    </datalist>
  )
}
