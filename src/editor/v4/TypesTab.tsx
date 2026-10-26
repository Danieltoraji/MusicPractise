/**
 * v4 编辑器「题型」Tab（docs/53 §13.3 题型）：
 * 题型列表 + 子页 元信息 / 表现（surface 组件列表：布局/初始 props/绑定）/ 状态参数（state/typeState/args）/
 * 行为（Behavior 图工作台插槽；W6 接入，缺省占位）。
 *
 * 写路径全部走 docStateV4（结构共享 + 程序化 id）；本文件不直接构造 LevelDocV4。
 */
import { useMemo, useState } from 'react'
import type { Json } from '../../engine/expr'
import { DATA_APPLY_COMMANDS } from '../../engine/level'
import { allContracts } from '../../runtime/store'
import {
  SCHEMA_LIMITS_V4,
  newUniqueLocalId,
  type ComponentInstanceV4,
  type LevelDocV4,
  type ParamFieldDef,
  type QuestionTypeDef,
  type StateFieldDef,
  type StateType,
} from '../../engine/v4/model'
import {
  V4_TAGS,
  addComponent,
  addType,
  removeComponent,
  removeType,
  setTypeArgs,
  setTypeState,
  updateComponent,
  updateType,
} from './docStateV4'
import { JsonEditModal, errText, type V4EditorBehaviorSlotProps, type V4TabProps } from './shared'

/** 行为图工作台插槽（W6 提供：GraphWorkbench behavior 模式） */
export type BehaviorSlotProps = V4EditorBehaviorSlotProps

export interface TypesTabProps extends V4TabProps {
  /** 行为子页插槽；缺省显示占位（W6 接入前） */
  renderBehavior?: (props: BehaviorSlotProps) => React.ReactNode
  /** 文档修订号（宿主透传给行为插槽；缺省 0） */
  revision?: number
}

type TypeSubTab = 'meta' | 'surface' | 'state' | 'behavior'

const STATE_TYPES: StateType[] = ['number', 'boolean', 'string', 'json']

function defaultValueForType(type: StateType): Json {
  switch (type) {
    case 'number':
      return 0
    case 'boolean':
      return false
    case 'string':
      return ''
    default:
      return null
  }
}

export function TypesTab({ doc, onChange, renderBehavior, revision = 0 }: TypesTabProps): React.ReactElement {
  const types = doc.content.types
  const [selectedId, setSelectedId] = useState<string | null>(types[0]?.id ?? null)
  const [subTab, setSubTab] = useState<TypeSubTab>('meta')
  const [error, setError] = useState('')
  const [propsEdit, setPropsEdit] = useState<{ componentId: string; value: Json } | null>(null)
  const activeType = types.find((t) => t.id === selectedId) ?? types[0]

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
      const result = addType(doc, { name: '新题型', table: { columns: [{ key: 'prompt', label: '题面', type: 'text' }] } })
      setSelectedId(result.id)
      onChange(result.doc)
    })
  }

  return (
    <div className="v4-split" data-testid="v4-types-tab">
      <aside className="v4-side" data-testid="v4-types-sidebar">
        <div className="v4-side-head">
          <b>题型（{types.length}/{SCHEMA_LIMITS_V4.types}）</b>
          <button
            type="button"
            data-testid="v4-types-add"
            disabled={types.length >= SCHEMA_LIMITS_V4.types}
            onClick={handleAddType}
          >
            + 题型
          </button>
        </div>
        <div className="v4-list">
          {types.map((type) => (
            <div key={type.id} className={`v4-list-item${type.id === activeType?.id ? ' active' : ''}`}>
              <button
                type="button"
                className="v4-list-select"
                data-testid={`v4-types-item-${type.id}`}
                onClick={() => setSelectedId(type.id)}
              >
                <b>{type.name}</b>
                <span className="muted">{type.id}</span>
              </button>
            </div>
          ))}
          {types.length === 0 && <p className="muted v4-side-empty">还没有题型——点「+ 题型」创建。</p>}
        </div>
      </aside>

      <div className="v4-main">
        {!activeType ? (
          <div className="v4-empty" data-testid="v4-types-empty">
            <p>题型定义 surface 组件、行为图与状态 schema；先建一个题型。</p>
            <button type="button" onClick={handleAddType}>
              + 建第一个题型
            </button>
          </div>
        ) : (
          <>
            <div className="rules-toolbar v4-table-toolbar">
              <b>{activeType.name}</b>
              <span className="muted">
                id <code>{activeType.id}</code> · surface {activeType.surface.components.length}/
                {SCHEMA_LIMITS_V4.surfaceComponentsPerType} 组件 · 行为 {activeType.behavior.nodes.length}/
                {SCHEMA_LIMITS_V4.nodesPerProgram} 节点
              </span>
              <button
                type="button"
                className="tone-error"
                data-testid="v4-types-remove"
                onClick={() => {
                  onChange(removeType(doc, activeType.id))
                  setSelectedId(null)
                }}
              >
                删除题型
              </button>
            </div>
            {error && (
              <div className="tone-error" data-testid="v4-types-error">
                {error}
              </div>
            )}
            <div className="v4-subtabs">
              {(
                [
                  ['meta', '元信息'],
                  ['surface', '表现（surface）'],
                  ['state', '状态参数'],
                  ['behavior', '行为'],
                ] as [TypeSubTab, string][]
              ).map(([key, label]) => (
                <button
                  key={key}
                  type="button"
                  className={subTab === key ? 'active' : ''}
                  data-testid={`v4-type-subtab-${key}`}
                  onClick={() => setSubTab(key)}
                >
                  {label}
                </button>
              ))}
            </div>

            {subTab === 'meta' && (
              <MetaPane
                doc={doc}
                type={activeType}
                onPatch={(patch) => onChange(updateType(doc, activeType.id, patch), V4_TAGS.type)}
              />
            )}
            {subTab === 'surface' && (
              <SurfacePane
                doc={doc}
                onChange={onChange}
                type={activeType}
                onError={setError}
                onEditProps={(componentId, value) => setPropsEdit({ componentId, value })}
              />
            )}
            {subTab === 'state' && <StatePane doc={doc} onChange={onChange} type={activeType} />}
            {subTab === 'behavior' &&
              (renderBehavior ? (
                renderBehavior({ doc, onChange, typeId: activeType.id, revision })
              ) : (
                <div className="v4-placeholder" data-testid="v4-type-behavior-placeholder">
                  行为图工作台（W6 · GraphWorkbench behavior 模式）将在此接入；当前题型行为可在 JSON Tab 编辑
                  behavior:&lt;{activeType.id}&gt; 层。
                </div>
              ))}
          </>
        )}
      </div>

      {propsEdit && activeType && (
        <JsonEditModal
          title={`编辑组件初始 props · ${propsEdit.componentId}`}
          value={propsEdit.value}
          hint="props 为组件挂载时的初始状态；绑定（bindings）会在运行态覆盖对应槽位。"
          testId="v4-comp-props"
          onApply={(value) => {
            onChange(
              updateComponent(doc, { kind: 'surface', typeId: activeType.id }, propsEdit.componentId, { props: value }),
              V4_TAGS.component,
            )
            setPropsEdit(null)
          }}
          onClose={() => setPropsEdit(null)}
        />
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// 元信息
// ---------------------------------------------------------------------------

function MetaPane(props: {
  doc: LevelDocV4
  type: QuestionTypeDef
  onPatch: (patch: Partial<QuestionTypeDef>) => void
}): React.ReactElement {
  const { doc, type } = props
  const table = doc.content.tables[type.id]
  return (
    <section className="v4-card" data-testid="v4-type-meta">
      <div className="v4-card-head">
        <b>题型元信息</b>
        <span className="muted">id 是表达式/题单/行为引用的稳定身份，创建后不可改</span>
      </div>
      <label className="v4-field">
        <span>显示名</span>
        <input
          value={type.name}
          maxLength={SCHEMA_LIMITS_V4.nameLength}
          data-testid="v4-type-name"
          onChange={(e) => props.onPatch({ name: e.target.value })}
        />
      </label>
      <label className="v4-field">
        <span>说明</span>
        <textarea
          value={type.description ?? ''}
          rows={3}
          maxLength={SCHEMA_LIMITS_V4.descriptionLength}
          data-testid="v4-type-description"
          onChange={(e) => props.onPatch({ description: e.target.value === '' ? undefined : e.target.value })}
        />
      </label>
      <div className="v4-meta-grid">
        <div>
          <span className="muted">题型 id</span>
          <code data-testid="v4-type-id">{type.id}</code>
        </div>
        <div>
          <span className="muted">实例表</span>
          <span>
            {table ? `${table.columns.length} 列 × ${table.rows.length} 行` : '（缺实例表）'}
          </span>
        </div>
        <div>
          <span className="muted">行为图</span>
          <span>
            {type.behavior.nodes.length} 节点 / {type.behavior.edges.length} 连线 · locals{' '}
            {(type.behavior.locals ?? []).length}
          </span>
        </div>
      </div>
    </section>
  )
}

// ---------------------------------------------------------------------------
// 表现（surface 组件列表：布局 / 初始 props / 绑定）
// ---------------------------------------------------------------------------

function SurfacePane(props: {
  doc: LevelDocV4
  onChange: (next: LevelDocV4, tag?: string) => void
  type: QuestionTypeDef
  onError: (message: string) => void
  onEditProps: (componentId: string, value: Json) => void
}): React.ReactElement {
  const { doc, type, onChange } = props
  const layer = { kind: 'surface', typeId: type.id } as const
  const contractTypes = useMemo(() => allContracts().map((c) => ({ type: c.type, label: c.displayName })), [])
  const [newType, setNewType] = useState(contractTypes[0]?.type ?? 'label')
  const components = type.surface.components

  const patch = (componentId: string, next: Partial<ComponentInstanceV4>, tag?: string): void => {
    onChange(updateComponent(doc, layer, componentId, next), tag ?? V4_TAGS.component)
  }

  const addComponentOfType = (): void => {
    try {
      const result = addComponent(doc, layer, newType)
      onChange(result.doc)
    } catch (err) {
      props.onError(errText(err))
    }
  }

  return (
    <section className="v4-card" data-testid="v4-type-surface">
      <div className="v4-card-head">
        <b>surface 组件（题目区域）</b>
        <span className="muted">
          {components.length}/{SCHEMA_LIMITS_V4.surfaceComponentsPerType} · 仅在题型调用期间挂载
        </span>
        <span className="v4-card-head-action">
          <select value={newType} data-testid="v4-surface-new-type" onChange={(e) => setNewType(e.target.value)}>
            {contractTypes.map((c) => (
              <option key={c.type} value={c.type}>
                {c.label}（{c.type}）
              </option>
            ))}
          </select>
          <button type="button" data-testid="v4-surface-add" onClick={addComponentOfType}>
            + 组件
          </button>
        </span>
      </div>
      {components.length === 0 && <p className="muted">还没有 surface 组件——加一个 label 显示题面。</p>}
      {components.map((component) => (
        <ComponentCard
          key={component.id}
          doc={doc}
          onChange={onChange}
          layer={layer}
          component={component}
          onPatch={(next, tag) => patch(component.id, next, tag)}
          onEditProps={() => props.onEditProps(component.id, component.props ?? null)}
          onRemove={() => onChange(removeComponent(doc, layer, component.id))}
        />
      ))}
    </section>
  )
}

/** 单个 surface 组件：布局 / 初始 props / 绑定（只读表达式） */
function ComponentCard(props: {
  doc: LevelDocV4
  onChange: (next: LevelDocV4, tag?: string) => void
  layer: { kind: 'surface'; typeId: string }
  component: ComponentInstanceV4
  onPatch: (next: Partial<ComponentInstanceV4>, tag?: string) => void
  onEditProps: () => void
  onRemove: () => void
}): React.ReactElement {
  const { component } = props
  const layout = component.layout ?? { x: 0, y: 0, w: 120, h: 40 }
  const slots = Object.keys(DATA_APPLY_COMMANDS[component.type] ?? {})
  const bindings = component.bindings ?? {}
  // 新增绑定先落到本地待编辑槽位（空表达式 = 尚未绑定，不写入文档），输入后即持久化
  const [pendingSlots, setPendingSlots] = useState<string[]>([])
  const usedSlots = new Set([...Object.keys(bindings), ...pendingSlots])
  const visibleSlots = [...Object.keys(bindings), ...pendingSlots.filter((slot) => !(slot in bindings))]
  const freeSlots = slots.filter((slot) => !usedSlots.has(slot))

  const setLayout = (key: 'x' | 'y' | 'w' | 'h', raw: string): void => {
    if (raw === '') return
    const value = Number(raw)
    if (!Number.isFinite(value)) return
    props.onPatch({ layout: { ...layout, [key]: Math.trunc(value) } })
  }

  const setBinding = (slot: string, expr: string): void => {
    const next = { ...bindings }
    if (expr.trim() === '') delete next[slot]
    else next[slot] = expr
    props.onPatch({ bindings: Object.keys(next).length > 0 ? next : undefined })
  }

  const removeBinding = (slot: string): void => {
    setBinding(slot, '')
    setPendingSlots((current) => current.filter((pending) => pending !== slot))
  }

  return (
    <div className="v4-comp" data-testid={`v4-surface-comp-${component.id}`}>
      <div className="v4-comp-head">
        <b>{component.type}</b>
        <code>{component.id}</code>
        <input
          className="v4-comp-name"
          defaultValue={component.name ?? ''}
          placeholder="显示名"
          maxLength={120}
          data-testid={`v4-comp-name-${component.id}`}
          onBlur={(e) => {
            if (e.currentTarget.value !== (component.name ?? '')) props.onPatch({ name: e.currentTarget.value })
          }}
        />
        <label className="v4-comp-visible">
          <input
            type="checkbox"
            checked={component.visible !== false}
            data-testid={`v4-comp-visible-${component.id}`}
            onChange={(e) => props.onPatch({ visible: e.target.checked })}
          />
          可见
        </label>
        <button
          type="button"
          className="ginsp-argdel"
          title="删除组件"
          data-testid={`v4-comp-remove-${component.id}`}
          onClick={props.onRemove}
        >
          ×
        </button>
      </div>
      <div className="v4-comp-layout">
        {(['x', 'y', 'w', 'h'] as const).map((key) => (
          <label key={key}>
            <span>{key.toUpperCase()}</span>
            <input
              type="number"
              className="v4-num"
              value={String(layout[key])}
              data-testid={`v4-comp-${key}-${component.id}`}
              onChange={(e) => setLayout(key, e.target.value)}
            />
          </label>
        ))}
        <span className="muted">800×470 坐标系</span>
      </div>
      <div className="v4-comp-props">
        <span>初始 props</span>
        <code className="v4-props-preview">{component.props === undefined ? '（未设置）' : JSON.stringify(component.props)}</code>
        <button type="button" data-testid={`v4-comp-props-${component.id}`} onClick={props.onEditProps}>
          编辑 JSON
        </button>
      </div>
      <div className="v4-comp-bindings">
        <span>
          绑定（只读投影 · {slots.length === 0 ? '该组件类型不支持绑定' : `槽位 ${slots.join(' / ')}`}）
        </span>
        {visibleSlots.map((slot) => (
          <div className="v4-binding-row" key={slot}>
            <code className="v4-binding-slot">{slot}</code>
            <input
              value={bindings[slot] ?? ''}
              className="v4-binding-expr"
              placeholder="只读表达式，如 q.prompt"
              data-testid={`v4-binding-expr-${component.id}-${slot}`}
              onChange={(e) => setBinding(slot, e.target.value)}
            />
            <button
              type="button"
              className="ginsp-argdel"
              title="移除绑定"
              data-testid={`v4-binding-remove-${component.id}-${slot}`}
              onClick={() => removeBinding(slot)}
            >
              ×
            </button>
          </div>
        ))}
        {freeSlots.length > 0 && (
          <button
            type="button"
            data-testid={`v4-binding-add-${component.id}`}
            onClick={() => setPendingSlots((current) => [...current, freeSlots[0]])}
            title="新增绑定槽位"
          >
            + 绑定 {freeSlots[0]}
          </button>
        )}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// 状态参数（state / typeState / args）
// ---------------------------------------------------------------------------

function StatePane(props: { doc: LevelDocV4; onChange: (next: LevelDocV4, tag?: string) => void; type: QuestionTypeDef }): React.ReactElement {
  const { doc, onChange, type } = props
  const stateFields = type.state ?? []
  const typeStateFields = type.typeState ?? []
  const args = type.args ?? []

  const commitState = (fields: (StateFieldDef | ParamFieldDef)[], kind: 'state' | 'typeState'): void => {
    // StateSection 在 state/typeState 语义下只产生 StateFieldDef（args 走另一分支）
    onChange(setTypeState(doc, type.id, fields as StateFieldDef[], kind), V4_TAGS.type)
  }
  const commitArgs = (fields: ParamFieldDef[]): void => {
    onChange(setTypeArgs(doc, type.id, fields), V4_TAGS.type)
  }

  return (
    <div className="v4-state-pane" data-testid="v4-type-state">
      <StateSection
        title="实例态 q.state.*"
        hint="每 (题型, 行) 一份，本局持久；行为图读写 q.state.<key>"
        fields={stateFields}
        kind="state"
        prefix="state"
        onCommit={(fields) => commitState(fields, 'state')}
      />
      <StateSection
        title="题型态 t.*"
        hint="每题型一份，本局持久（跨行共享）；行为图读写 t.<key>"
        fields={typeStateFields}
        kind="typeState"
        prefix="typeState"
        onCommit={(fields) => commitState(fields, 'typeState')}
      />
      <StateSection
        title="调用参数 args"
        hint="ask 调用参数 schema（题单 args 覆盖默认值）；行为图读写 args.<key>"
        fields={args}
        kind="args"
        prefix="arg"
        onCommit={(fields) => commitArgs(fields as ParamFieldDef[])}
      />
    </div>
  )
}

function StateSection(props: {
  title: string
  hint: string
  fields: (StateFieldDef | ParamFieldDef)[]
  kind: 'state' | 'typeState' | 'args'
  prefix: string
  onCommit: (fields: (StateFieldDef | ParamFieldDef)[]) => void
}): React.ReactElement {
  const isArgs = props.kind === 'args'
  const addField = (): void => {
    const key = newUniqueLocalId(props.prefix, props.fields.map((f) => f.key))
    const field: StateFieldDef | ParamFieldDef = isArgs
      ? { key, type: 'number' }
      : { key, type: 'number', init: 0 }
    props.onCommit([...props.fields, field])
  }
  const patchField = (index: number, patch: Record<string, unknown>): void => {
    props.onCommit(props.fields.map((field, i) => (i === index ? ({ ...field, ...patch } as StateFieldDef | ParamFieldDef) : field)))
  }
  const removeField = (index: number): void => {
    props.onCommit(props.fields.filter((_, i) => i !== index))
  }
  return (
    <section className="v4-card" data-testid={`v4-state-section-${props.kind}`}>
      <div className="v4-card-head">
        <b>{props.title}</b>
        <span className="muted">{props.hint}</span>
        <button type="button" className="v4-card-head-action" data-testid={`v4-state-add-${props.kind}`} onClick={addField}>
          + 字段
        </button>
      </div>
      {props.fields.length === 0 && <p className="muted">还没有字段。</p>}
      {props.fields.map((field, index) => (
        <div className="v4-field-row" key={`${field.key}:${index}`} data-testid={`v4-state-row-${props.kind}-${index}`}>
          <input
            className="v4-key-input"
            defaultValue={field.key}
            maxLength={64}
            placeholder="key"
            data-testid={`v4-state-key-${props.kind}-${index}`}
            onBlur={(e) => {
              const key = e.currentTarget.value.trim()
              if (key !== field.key) patchField(index, { key })
            }}
          />
          <select
            value={field.type}
            data-testid={`v4-state-type-${props.kind}-${index}`}
            onChange={(e) => {
              const nextType = e.target.value as StateType
              patchField(index, isArgs ? { type: nextType } : { type: nextType, init: defaultValueForType(nextType) })
            }}
          >
            {STATE_TYPES.map((stateType) => (
              <option key={stateType} value={stateType}>
                {stateType}
              </option>
            ))}
          </select>
          {isArgs ? (
            <>
              <label className="v4-inline-check">
                <input
                  type="checkbox"
                  checked={(field as ParamFieldDef).optional === true}
                  data-testid={`v4-state-optional-${props.kind}-${index}`}
                  onChange={(e) => patchField(index, { optional: e.target.checked })}
                />
                可选
              </label>
              <span className="muted">默认值</span>
              <ValueEditor
                type={field.type}
                value={(field as ParamFieldDef).default ?? null}
                allowNull
                testId={`v4-state-value-${props.kind}-${index}`}
                onChange={(value) => patchField(index, { default: value === null ? undefined : value })}
                onError={() => undefined}
              />
            </>
          ) : (
            <>
              <span className="muted">初值</span>
              <ValueEditor
                type={field.type}
                value={(field as StateFieldDef).init}
                testId={`v4-state-value-${props.kind}-${index}`}
                onChange={(value) => patchField(index, { init: value })}
                onError={() => undefined}
              />
            </>
          )}
          <button
            type="button"
            className="ginsp-argdel"
            title="删除字段"
            data-testid={`v4-state-remove-${props.kind}-${index}`}
            onClick={() => removeField(index)}
          >
            ×
          </button>
        </div>
      ))}
    </section>
  )
}

/** 按声明类型编辑 Json 值（number/boolean/string 内联；json 走文本解析） */
function ValueEditor(props: {
  type: StateType
  value: Json
  allowNull?: boolean
  testId: string
  onChange: (value: Json) => void
  onError: (message: string) => void
}): React.ReactElement {
  if (props.type === 'boolean') {
    return (
      <input
        type="checkbox"
        checked={props.value === true}
        data-testid={props.testId}
        onChange={(e) => props.onChange(e.target.checked)}
      />
    )
  }
  if (props.type === 'number') {
    return (
      <input
        type="number"
        className="v4-num"
        value={typeof props.value === 'number' ? String(props.value) : ''}
        data-testid={props.testId}
        onChange={(e) => {
          const text = e.target.value
          if (text === '') {
            props.onChange(props.allowNull ? null : 0)
            return
          }
          const numeric = Number(text)
          if (Number.isFinite(numeric)) props.onChange(numeric)
        }}
      />
    )
  }
  if (props.type === 'string') {
    return (
      <input
        value={typeof props.value === 'string' ? props.value : ''}
        data-testid={props.testId}
        onChange={(e) => props.onChange(e.target.value)}
      />
    )
  }
  return <JsonTextInput value={props.value} testId={props.testId} onChange={props.onChange} onError={props.onError} />
}

/** json 类型的值：本地文本态 + blur 解析（非法不提交并提示） */
function JsonTextInput(props: {
  value: Json
  testId: string
  onChange: (value: Json) => void
  onError: (message: string) => void
}): React.ReactElement {
  const [text, setText] = useState(() => (props.value === undefined ? 'null' : JSON.stringify(props.value)))
  return (
    <input
      className="v4-json-value"
      value={text}
      data-testid={props.testId}
      onChange={(e) => setText(e.target.value)}
      onBlur={() => {
        try {
          props.onChange(JSON.parse(text) as Json)
        } catch {
          props.onError('该值是 json 类型：需要合法 JSON')
        }
      }}
    />
  )
}
