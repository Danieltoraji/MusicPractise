/**
 * 关卡编辑器 MVP：组件面板 / 画布拖放 / 属性检查器 / 规则表单 / 题目编辑 / JSON 视图 / 保存与试运行。
 * 组件类型与事件/命令枚举全部来自组件注册表契约（单一来源）。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { db } from '../library/db'
import type { LibraryRecord } from '../library/db'
import { loadLevelDoc } from '../library/validate'
import { putResource } from '../library/db'
import { allContracts, getDef } from '../runtime/store'
import type { ComponentInstance, LevelDoc, Question } from '../engine/level'
import type { Rule } from '../engine/logic'
import type { Json } from '../engine/expr'
import { exprFunctionNames, parseExpr, ExprError } from '../engine/expr'
import {
  addComponent,
  blankLevelDoc,
  parseJsonText,
  removeComponent,
  removeVariable,
  renameVariable,
  setMeta,
  setVariable,
  parseScalarInput,
  updateComponent,
  updateQuestion,
} from './docState'

type Tab = 'canvas' | 'rules' | 'questions' | 'json'

/** 表达式实时校验：语法错误返回消息，合法返回 null */
export function checkExprText(text: string): string | null {
  if (text.trim() === '') return null
  try {
    parseExpr(text)
    return null
  } catch (e) {
    return e instanceof ExprError ? e.message : String(e)
  }
}

interface Props {
  id: string
}

export function EditorPage({ id }: Props) {
  const record = useLiveQuery(async () => (id === 'new' ? 'new' : (await db.resources.get(id)) ?? null), [id], 'loading')
  const [doc, setDoc] = useState<LevelDoc | null>(null)
  const [tab, setTab] = useState<Tab>('canvas')
  const [selected, setSelected] = useState<string | null>(null)
  const [saveErrors, setSaveErrors] = useState<string[]>([])
  const [lintWarnings, setLintWarnings] = useState<string[]>([])
  const [savedTip, setSavedTip] = useState('')

  // 装载：new = 空白模板；否则取库内文档
  useEffect(() => {
    if (record === 'loading' || record === undefined || record === null) return
    if (doc) return
    if (record === 'new') setDoc(blankLevelDoc())
    else setDoc(structuredClone((record as LibraryRecord).doc) as LevelDoc)
  }, [record, doc])
  const selectedComp = doc?.content.components.find((c) => c.id === selected) ?? null

  /** 编辑器内所有文档修改走这里：修改即清「已保存」提示 */
  const update = useCallback((next: LevelDoc) => {
    setSavedTip('')
    setDoc(next)
  }, [])

  const save = useCallback(async (): Promise<boolean> => {
    if (!doc) return false
    const result = loadLevelDoc(doc)
    if (!result.ok) {
      setSaveErrors(result.errors)
      return false
    }
    // 内置示例不可被编辑器覆盖保存（会让 builtIn 记录被翻成用户文档）
    const existing = await db.resources.get(doc.id)
    if (existing?.builtIn === 1) {
      setSaveErrors(['内置示例不可直接覆盖保存——请在资源库对该关卡使用「编辑副本」获得可保存的副本'])
      return false
    }
    setSaveErrors([])
    setLintWarnings(result.lintWarnings)
    await putResource(result.doc as never)
    setSavedTip(`已保存（v${result.doc.version}）`)
    return true
  }, [doc])

  async function tryRun(): Promise<void> {
    if ((await save()) && doc) window.location.hash = `#/level/${doc.id}`
  }

  if (record === 'loading' || record === undefined || !doc) {
    return <p className="muted page">{record === null && id !== 'new' ? '库中没有这个关卡' : '编辑器加载中…'}</p>
  }

  return (
    <div className="page editor">
      <div className="editor-head">
        <a href="#/library">← 资源库</a>
        <input
          className="editor-title"
          value={String(doc.meta.title ?? '')}
          onChange={(e) => update(setMeta(doc, { title: e.target.value }))}
        />
        <button type="button" className="primary" onClick={() => save()}>
          💾 保存
        </button>
        <button type="button" onClick={tryRun}>
          ▶ 试运行
        </button>
      </div>
      {saveErrors.length > 0 && (
        <div className="editor-errors">
          <b>无法保存，请修正：</b>
          <ul>
            {saveErrors.map((e, i) => (
              <li key={i}>{e}</li>
            ))}
          </ul>
        </div>
      )}
      {lintWarnings.length > 0 && (
        <div className="editor-lint">
          ⚠ lint：{lintWarnings.join('；')}
        </div>
      )}
      {savedTip && <div className="editor-saved">{savedTip}</div>}

      <div className="editor-tabs">
        {([
          ['canvas', '画布'],
          ['rules', '规则'],
          ['questions', '题目'],
          ['json', 'JSON'],
        ] as [Tab, string][]).map(([t, label]) => (
          <button key={t} type="button" className={tab === t ? 'active' : ''} onClick={() => setTab(t)}>
            {label}
          </button>
        ))}
      </div>

      {tab === 'canvas' && (
        <EditorCanvas
          doc={doc}
          selected={selected}
          onSelect={setSelected}
          onChange={update}
        />
      )}
      {tab === 'canvas' && selectedComp && (
        <Inspector
          comp={selectedComp}
          onChange={(patch) => update(updateComponent(doc, selectedComp.id, patch))}
          onRemove={() => {
            update(removeComponent(doc, selectedComp.id))
            setSelected(null)
          }}
        />
      )}

      {tab === 'rules' && (
        <RulesEditor
          doc={doc}
          onChange={setDoc}
        />
      )}

      {tab === 'questions' && (
        <QuestionsEditor doc={doc} onChange={setDoc} />
      )}

      {tab === 'json' && (
        <JsonTab doc={doc} onApply={update} />
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// 画布 + 组件面板
// ---------------------------------------------------------------------------

function EditorCanvas({
  doc,
  selected,
  onSelect,
  onChange,
}: {
  doc: LevelDoc
  selected: string | null
  onSelect: (id: string | null) => void
  onChange: (doc: LevelDoc) => void
}) {
  const canvasRef = useRef<HTMLDivElement>(null)
  const dragRef = useRef<{ id: string; grabX: number; grabY: number; rect: DOMRect } | null>(null)

  function onBoxPointerDown(e: React.PointerEvent, comp: ComponentInstance): void {
    e.currentTarget.setPointerCapture(e.pointerId)
    onSelect(comp.id)
    const rect = canvasRef.current!.getBoundingClientRect()
    const layout = comp.layout ?? { x: 0, y: 0, w: 120, h: 40 }
    dragRef.current = { id: comp.id, grabX: e.clientX - rect.left - layout.x, grabY: e.clientY - rect.top - layout.y, rect }
  }

  function onBoxPointerMove(e: React.PointerEvent, comp: ComponentInstance): void {
    const drag = dragRef.current
    if (!drag || drag.id !== comp.id) return
    const rect = drag.rect
    const snap = (v: number) => Math.round(v / 10) * 10
    const boxW = comp.layout?.w ?? 120
    const boxH = comp.layout?.h ?? 40
    // 双向 clamp：画布内自由拖动，不出界
    const x = Math.min(rect.width - boxW, Math.max(0, snap(e.clientX - rect.left - drag.grabX)))
    const y = Math.min(rect.height - boxH, Math.max(0, snap(e.clientY - rect.top - drag.grabY)))
    onChange(updateComponent(doc, comp.id, { layout: { ...(comp.layout ?? { w: 120, h: 40 }), x, y } }))
  }

  function onBoxPointerUp(): void {
    dragRef.current = null
  }

  const palette = allContracts()

  return (
    <div className="editor-canvas-layout">
      <div className="palette">
        <b>组件面板</b>
        {(['music', 'ui', 'hidden'] as const).map((cat) => (
          <div key={cat}>
            <div className="palette-cat">{cat === 'music' ? '音乐' : cat === 'ui' ? '交互' : '隐形'}</div>
            {palette
              .filter((c) => c.category === cat)
              .map((c) => (
                <button key={c.type} type="button" onClick={() => onChange(addComponent(doc, c.type))}>
                  + {c.displayName}
                </button>
              ))}
          </div>
        ))}
      </div>

      <div
        ref={canvasRef}
        className="editor-canvas"
        onPointerDown={() => onSelect(null)}
      >
        {doc.content.components.map((comp) => (
          <div
            key={comp.id}
            className={`editor-box ${selected === comp.id ? 'is-selected' : ''} ${comp.visible === false ? 'is-ghost' : ''}`}
            style={comp.layout ? { left: comp.layout.x, top: comp.layout.y, width: comp.layout.w, height: comp.layout.h } : undefined}
            data-comp-type={comp.type}
            onPointerDown={(e) => {
              e.stopPropagation()
              onBoxPointerDown(e, comp)
            }}
            onPointerMove={(e) => onBoxPointerMove(e, comp)}
            onPointerUp={onBoxPointerUp}
            onPointerCancel={onBoxPointerUp}
            title={`${comp.type} · ${comp.name ?? comp.id}`}
          >
            <span className="box-label">{comp.name ?? comp.id}</span>
            <span className="box-type">{comp.type}</span>
          </div>
        ))}
        {doc.content.components.length === 0 && (
          <p className="muted" style={{ padding: 24 }}>
            从左侧组件面板添加组件
          </p>
        )}
      </div>

      <InspectorHint />
    </div>
  )
}

function InspectorHint() {
  return (
    <p className="muted" style={{ margin: '6px 2px' }}>
      拖拽移动组件；选中后在右侧属性检查器编辑。未选中的点击落在画布空白处即取消选中。
    </p>
  )
}

// ---------------------------------------------------------------------------
// 属性检查器
// ---------------------------------------------------------------------------

function Inspector({
  comp,
  onChange,
  onRemove,
}: {
  comp: ComponentInstance
  onChange: (patch: Partial<ComponentInstance>) => void
  onRemove: () => void
}) {
  const contract = safeContract(comp.type)
  const [propsText, setPropsText] = useState(() => JSON.stringify(comp.props ?? {}, null, 2))
  const [propsErr, setPropsErr] = useState('')
  const [bindText, setBindText] = useState(() => JSON.stringify(comp.bindings ?? {}, null, 2))
  const [bindErr, setBindErr] = useState('')

  // 切换选中组件时同步文本
  useEffect(() => {
    setPropsText(JSON.stringify(comp.props ?? {}, null, 2))
    setBindText(JSON.stringify(comp.bindings ?? {}, null, 2))
  }, [comp.id])

  const applyProps = (text: string): void => {
    setPropsText(text)
    const v = parseJsonText(text)
    if (v === null && text.trim() !== '') setPropsErr('不是合法 JSON')
    else {
      setPropsErr('')
      onChange({ props: v ?? {} })
    }
  }

  const applyBindings = (text: string): void => {
    setBindText(text)
    const v = parseJsonText(text)
    if (v === null || typeof v !== 'object' || Array.isArray(v)) setBindErr('需为 JSON 对象')
    else {
      setBindErr('')
      onChange({ bindings: v as Record<string, Json> })
    }
  }

  const num = (label: string, key: 'x' | 'y' | 'w' | 'h') => (
    <label>
      {label}{' '}
      <input
        type="number"
        value={(comp.layout ?? { x: 0, y: 0, w: 120, h: 40 })[key]}
        onChange={(e) => {
          const v = Number(e.target.value)
          if (Number.isFinite(v)) {
            const layout = { ...(comp.layout ?? { x: 0, y: 0, w: 120, h: 40 }), [key]: v }
            onChange({ layout })
          }
        }}
      />
    </label>
  )

  return (
    <div className="inspector">
      <b>属性 · {comp.type}</b>
      <label>
        名称 <input value={comp.name ?? ''} onChange={(e) => onChange({ name: e.target.value })} />
      </label>
      <label>
        <input type="checkbox" checked={comp.visible !== false} onChange={(e) => onChange({ visible: e.target.checked })} /> 可见
      </label>
      <div className="inspector-layout">
        {num('X', 'x')}
        {num('Y', 'y')}
        {num('宽', 'w')}
        {num('高', 'h')}
      </div>
      {contract.propsDoc && <p className="muted props-doc">{contract.propsDoc}</p>}
      <label>
        props JSON
        <textarea rows={4} value={propsText} onChange={(e) => applyProps(e.target.value)} />
        {propsErr && <span className="tone-error">{propsErr}</span>}
      </label>
      {comp.bindings && (
        <label>
          bindings JSON
          <textarea rows={4} value={bindText} onChange={(e) => applyBindings(e.target.value)} />
          {bindErr && <span className="tone-error">{bindErr}</span>}
        </label>
      )}
      <button type="button" className="danger" onClick={onRemove}>
        删除组件
      </button>
      <p className="muted">id：{comp.id}</p>
    </div>
  )
}

function safeContract(type: string) {
  try {
    return getDef(type).contract
  } catch {
    return { type, displayName: type, category: 'ui' as const, events: {}, commands: {} }
  }
}

// ---------------------------------------------------------------------------
// 规则编辑器
// ---------------------------------------------------------------------------

type RawAction = Record<string, unknown>

function actionKind(a: RawAction): 'cmd' | 'set' | 'emit' {
  // 与引擎运行时判定顺序对齐（cmd > set > emit）
  if ('cmd' in a) return 'cmd'
  if ('set' in a) return 'set'
  return 'emit'
}

export function RulesEditor({ doc, onChange }: { doc: LevelDoc; onChange: (doc: LevelDoc) => void }) {
  const rules = doc.content.logic.rules
  const patchRule = (index: number, patch: Partial<Rule>): void => {
    const next = structuredClone(doc)
    Object.assign(next.content.logic.rules[index], patch)
    onChange(next)
  }

  const eventOptions = ['level.started', 'level.questionLoaded', 'level.finished']
  const commandOptions = ['level.next', 'level.restart']
  for (const c of doc.content.components) {
    const contract = safeContract(c.type)
    for (const ev of Object.keys(contract.events)) eventOptions.push(`${c.id}.${ev}`)
    for (const cmd of Object.keys(contract.commands)) {
      if (!cmd.startsWith('__')) commandOptions.push(`${c.id}.${cmd}`)
    }
  }
  const variableNames = Object.keys(doc.content.logic.variables ?? {})
  const exprSuggestions = [
    ...variableNames.map((v) => `v.${v}`),
    'q.data',
    'event.',
    ...exprFunctionNames,
  ]

  const variables = doc.content.logic.variables ?? {}
  const patchVarValue = (name: string, text: string): void => {
    onChange(setVariable(doc, name, parseScalarInput(text)))
  }
  const renameVar = (oldName: string, nextName: string): void => {
    if (nextName === oldName) return
    if (nextName.trim() === '') return
    onChange(renameVariable(doc, oldName, nextName.trim()))
  }

  return (
    <div className="rules-editor">
      <div className="vars-editor">
        <b>变量（logic.variables）</b>
        {variableNames.map((name) => (
          <div key={name} className="var-row">
            <input
              value={name}
              aria-label="变量名"
              onChange={(e) => renameVar(name, e.target.value)}
            />
            <input
              value={String(variables[name])}
              aria-label="初始值"
              onChange={(e) => patchVarValue(name, e.target.value)}
            />
            <button
              type="button"
              className="link danger"
              onClick={() => onChange(removeVariable(doc, name))}
            >
              ✕
            </button>
          </div>
        ))}
        <button
          type="button"
          onClick={() => {
            let n = variableNames.length + 1
            while (variableNames.includes(`var${n}`)) n++
            onChange(setVariable(doc, `var${n}`, 0))
          }}
        >
          + 添加变量
        </button>
      </div>

      <div className="rules-toolbar">
        <button
          type="button"
          onClick={() => {
            const next = structuredClone(doc)
            next.content.logic.rules.push({ id: `rule-${rules.length + 1}`, on: eventOptions[0] ?? 'level.started', do: [] })
            onChange(next)
          }}
        >
          + 添加规则
        </button>
        <span className="muted">
          事件/命令在输入时可从下拉建议中选择（来自组件契约）。同事件多条规则按声明顺序执行。
        </span>
      </div>
      <datalist id="event-options">
        {eventOptions.map((o) => (
          <option key={o} value={o} />
        ))}
      </datalist>
      <datalist id="command-options">
        {commandOptions.map((o) => (
          <option key={o} value={o} />
        ))}
      </datalist>
      <datalist id="expr-options">
        {exprSuggestions.map((o) => (
          <option key={o} value={o} />
        ))}
      </datalist>

      {rules.map((rule, ri) => (
        <div key={rule.id} className="rule-card">
          <div className="rule-head">
            <b>{rule.id}</b>
            <button
              type="button"
              className="link danger"
              onClick={() => {
                const next = structuredClone(doc)
                next.content.logic.rules = next.content.logic.rules.filter((_, i) => i !== ri)
                onChange(next)
              }}
            >
              删除规则
            </button>
          </div>
          <label>
            当事件
            <input value={rule.on} list="event-options" onChange={(e) => patchRule(ri, { on: e.target.value })} />
          </label>
          <label>
            条件（每行一个表达式，全部满足才走 do；失焦时提交，留空 = 恒真）
            <LinesField
              value={rule.when ?? []}
              onCommit={(lines) => patchRule(ri, { when: lines })}
              validateLine={checkExprText}
            />
          </label>
          <ActionList
            label="则执行（do）"
            actions={rule.do as unknown as RawAction[]}
            onChange={(actions) => patchRule(ri, { do: actions as unknown as Rule['do'] })}
          />
          <ActionList
            label="否则执行（else，可空）"
            actions={(rule.else ?? []) as unknown as RawAction[]}
            onChange={(actions) => patchRule(ri, { else: actions as unknown as Rule['else'] })}
          />
        </div>
      ))}
      {rules.length === 0 && <p className="muted">还没有规则。</p>}
      <p className="muted">
        变量：{JSON.stringify(doc.content.logic.variables ?? {})}（编辑器可视化变量管理在后续版本提供）
      </p>
    </div>
  )
}

/** 多行条件输入：本地编辑、失焦提交（避免受控值过滤空行导致无法换行）。
 *  validateLine 可选：逐行实时校验，首个错误显示在输入下方。 */
function LinesField({
  value,
  onCommit,
  validateLine,
}: {
  value: string[]
  onCommit: (lines: string[]) => void
  validateLine?: (line: string) => string | null
}) {
  const [text, setText] = useState(value.join('\n'))
  const lines = text.split('\n')
  const firstError = validateLine
    ? lines.map((l, i) => ({ l, i })).map(({ l, i }) => ({ i, err: l.trim() === '' ? null : validateLine(l) })).find((x) => x.err !== null)
    : null
  return (
    <>
      <textarea
        rows={2}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onBlur={() => onCommit(text.split('\n').map((s) => s.trim()).filter((s) => s !== ''))}
      />
      {firstError && <span className="tone-error">第 {firstError.i + 1} 行：{firstError.err}</span>}
    </>
  )
}

function ActionList({
  label,
  actions,
  onChange,
}: {
  label: string
  actions: RawAction[]
  onChange: (actions: RawAction[]) => void
}) {
  const patch = (index: number, a: RawAction): void => {
    const next = actions.map((x, i) => (i === index ? a : x))
    onChange(next)
  }
  return (
    <div className="action-list">
      <b>{label}</b>
      {actions.map((a, i) => {
        const kind = actionKind(a)
        return (
          <div key={i} className="action-row">
            <select
              value={kind}
              onChange={(e) => {
                const k = e.target.value
                if (k === 'cmd') patch(i, { cmd: '', args: {} })
                else if (k === 'set') patch(i, { set: '', expr: '' })
                else patch(i, { emit: ':', payload: {} })
              }}
            >
              <option value="cmd">命令</option>
              <option value="set">写变量</option>
              <option value="emit">发事件</option>
            </select>
            {kind === 'cmd' && (
              <>
                <input
                  value={String(a.cmd ?? '')}
                  list="command-options"
                  placeholder="组件id.命令"
                  onChange={(e) => patch(i, { cmd: e.target.value, args: a.args ?? {} })}
                />
                <input
                  value={JSON.stringify(a.args ?? {})}
                  onChange={(e) => {
                    const v = parseJsonText(e.target.value)
                    if (v !== null && typeof v === 'object' && !Array.isArray(v)) patch(i, { cmd: a.cmd, args: v as Record<string, Json> })
                  }}
                  title="参数 JSON"
                />
              </>
            )}
            {kind === 'set' && (
              <>
                <input
                  value={String(a.set ?? '')}
                  placeholder="变量名"
                  onChange={(e) => patch(i, { set: e.target.value, expr: a.expr ?? '' })}
                />
                <input
                  value={String(a.expr ?? '')}
                  placeholder="表达式，如 v.score + 10"
                  list="expr-options"
                  onChange={(e) => patch(i, { set: a.set, expr: e.target.value })}
                />
                {(() => {
                  const err = checkExprText(String(a.expr ?? ''))
                  return err ? <span className="tone-error expr-err">{err}</span> : null
                })()}
              </>
            )}
            {kind === 'emit' && (
              <>
                <input
                  value={String(a.emit ?? '')}
                  placeholder="名字:名字"
                  onChange={(e) => patch(i, { emit: e.target.value, payload: a.payload ?? {} })}
                />
              </>
            )}
            <button type="button" className="link danger" onClick={() => onChange(actions.filter((_, x) => x !== i))}>
              ✕
            </button>
          </div>
        )
      })}
      <div className="action-add">
        <button type="button" onClick={() => onChange([...actions, { cmd: '', args: {} }])}>
          + 命令
        </button>
        <button type="button" onClick={() => onChange([...actions, { set: '', expr: '' }])}>
          + 写变量
        </button>
        <button type="button" onClick={() => onChange([...actions, { emit: '名字:名字' }])}>
          + 发事件
        </button>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// 题目编辑
// ---------------------------------------------------------------------------

function QuestionsEditor({ doc, onChange }: { doc: LevelDoc; onChange: (doc: LevelDoc) => void }) {
  const questions = doc.content.questions
  const patchQ = (index: number, patch: Partial<Question>): void => {
    onChange(updateQuestion(doc, index, patch))
  }
  // 草稿文本按题目 id 键控（id 在编辑中变化时以新 id 重新草稿化）
  const [dataTexts, setDataTexts] = useState<Record<string, string>>({})
  const [dataErrs, setDataErrs] = useState<Record<string, string>>({})

  return (
    <div className="questions-editor">
      <div className="rules-toolbar">
        <button
          type="button"
          onClick={() => {
            const next = structuredClone(doc)
            let n = next.content.questions.length + 1
            const used = new Set(next.content.questions.map((q) => q.id))
            while (used.has(`q${n}`)) n++
            next.content.questions.push({ id: `q${n}`, data: {}, scoring: { max: 10 } })
            onChange(next)
          }}
        >
          + 添加题目
        </button>
      </div>
      {questions.map((q, i) => {
        const dataText = dataTexts[q.id] ?? JSON.stringify(q.data ?? {}, null, 2)
        return (
          <div key={i} className="rule-card">
            <div className="rule-head">
              <b>{q.id}</b>
              <button
                type="button"
                className="link danger"
                onClick={() => {
                  const next = structuredClone(doc)
                  next.content.questions = next.content.questions.filter((_, x) => x !== i)
                  onChange(next)
                }}
              >
                删除题目
              </button>
            </div>
            <label>
              题目 id
              <input value={q.id} onChange={(e) => patchQ(i, { id: e.target.value })} />
            </label>
            <label>
              题面文字
              <input value={q.prompt?.text ?? ''} onChange={(e) => patchQ(i, { prompt: { ...q.prompt, text: e.target.value } })} />
            </label>
            <label>
              本题分值
              <input
                type="number"
                value={q.scoring?.max ?? 10}
                onChange={(e) => patchQ(i, { scoring: { max: Number(e.target.value) || 0 } })}
              />
            </label>
            <label>
              data JSON（$q.data 供绑定与表达式读取）
              <textarea
                rows={6}
                value={dataText}
                onChange={(e) => {
                  setDataTexts((s) => ({ ...s, [q.id]: e.target.value }))
                  const v = parseJsonText(e.target.value)
                  if (v === null || typeof v !== 'object' || Array.isArray(v)) setDataErrs((s) => ({ ...s, [q.id]: '需为 JSON 对象' }))
                  else {
                    setDataErrs((s) => ({ ...s, [q.id]: '' }))
                    patchQ(i, { data: v })
                  }
                }}
              />
              {dataErrs[q.id] && <span className="tone-error">{dataErrs[q.id]}</span>}
            </label>
          </div>
        )
      })}
    </div>
  )
}

// ---------------------------------------------------------------------------
// JSON 视图
// ---------------------------------------------------------------------------

function JsonTab({ doc, onApply }: { doc: LevelDoc; onApply: (doc: LevelDoc) => void }) {
  const [text, setText] = useState(() => JSON.stringify(doc, null, 2))
  const [err, setErr] = useState('')

  // doc 外部变化（保存/试运行返回等）时同步文本；应用 JSON 引起的 setDoc
  // 会带上新 doc 再触发本 effect，文本被格式化刷新属预期
  useEffect(() => {
    setText(JSON.stringify(doc, null, 2))
  }, [doc])

  return (
    <div className="json-tab">
      <button
        type="button"
        onClick={() => {
          try {
            const parsed = JSON.parse(text)
            if (parsed.kind !== 'level') {
              setErr('kind 必须是 level')
              return
            }
            // 保留当前关卡 id：应用 JSON 改 id 会让保存落为新记录、URL 与库脱节
            parsed.id = doc.id
            onApply(parsed as LevelDoc)
            setErr('')
          } catch (e) {
            setErr(String(e instanceof Error ? e.message : e))
          }
        }}
      >
        应用 JSON 到编辑器
      </button>
      {err && <span className="tone-error" style={{ marginLeft: 12 }}>{err}</span>}
      <textarea rows={24} value={text} onChange={(e) => setText(e.target.value)} />
    </div>
  )
}
