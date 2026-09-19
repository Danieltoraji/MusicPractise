/**
 * 节点 Inspector：选中节点的参数表单（按 kind 渲染）。
 * 本地草稿 + 失焦提交（与画布 Inspector/LinesField 模式一致，避免每键全图重算）；
 * 表达式输入带实时校验（checkExprText）；call/assign 的候选来自组件契约。
 */
import { useState } from 'react'
import type { LevelDoc } from '../../engine/level'
import { LEVEL_METHODS, type GNode, type LintIssue } from '../../engine/graphProgram'
import { getDef } from '../../runtime/store'
import { checkExprText } from '../EditorPage'
import { exprFunctionNames } from '../../engine/expr'

interface Props {
  node: GNode | undefined
  doc: LevelDoc
  issues: LintIssue[]
  onPatch: (patch: Partial<GNode>) => void
  onRemove: () => void
}

const exprDatalistId = 'ginsp-expr-options'

function ExprInput(props: {
  value: string
  onChange: (v: string) => void
  /** 失焦时提交草稿（评审 P1-3：消除切节点丢稿窗口；「应用」按钮保留为显式兜底） */
  onCommit?: () => void
  placeholder?: string
}): React.ReactElement {
  const err = props.value.trim() === '' ? null : checkExprText(props.value)
  return (
    <span className="ginsp-expr">
      <input
        value={props.value}
        placeholder={props.placeholder}
        list={exprDatalistId}
        onChange={(e) => props.onChange(e.target.value)}
        onBlur={() => props.onCommit?.()}
      />
      {err && <span className="tone-error">{err}</span>}
    </span>
  )
}

export function NodeInspector({ node, doc, issues, onPatch, onRemove }: Props) {
  // 草稿 = node + 未提交覆盖层（按节点 id 键控），渲染期派生——
  // 不用 useEffect 同步草稿，避免「切节点后的首渲染帧拿到上一个节点的草稿」
  // 导致 assign 的 `'expr' in draft.value` 等字段读取崩溃（白屏级）。
  const [overrides, setOverrides] = useState<Record<string, Record<string, unknown>>>({})
  if (!node) {
    return (
      <div className="ginsp">
        <div className="glib-title">属性</div>
        <p className="muted">选中一个节点后在这里编辑参数。双击连线可断开。</p>
      </div>
    )
  }

  const draft: Record<string, unknown> = { ...node, ...(overrides[node.id] ?? {}) }
  const set = (patch: Record<string, unknown>): void => {
    setOverrides((o) => ({ ...o, [node.id]: { ...(o[node.id] ?? {}), ...patch } }))
  }
  const commit = (patch: Record<string, unknown>): void => {
    onPatch(patch as Partial<GNode>)
    // 已提交的覆盖即与节点同步，清掉避免陈旧覆盖压过后续外部变更
    setOverrides((o) => {
      const rest = { ...(o[node.id] ?? {}) }
      for (const key of Object.keys(patch)) delete rest[key]
      return { ...o, [node.id]: rest }
    })
  }
  // 输入失焦：以草稿值提交（与节点当前值相同则跳过）
  const blurCommit = (key: string): void => {
    if (key in draft && draft[key] !== (node as unknown as Record<string, unknown>)[key]) commit({ [key]: draft[key] })
  }

  const comps = doc.content.components
  const compNames = comps.map((c) => c.id)
  const varNames = Object.keys(doc.content.logic.variables ?? {})

  const callTargetOptions = [...compNames, 'level']
  const methodOptions = (target: string): string[] => {
    if (target === 'level') return [...LEVEL_METHODS]
    return Object.keys(getDef(comps.find((c) => c.id === target)?.type ?? '').contract.commands).filter(
      (m) => !m.startsWith('__'),
    )
  }
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
        {exprFunctionNames.map((fn) => (
          <option key={fn} value={`${fn}(`} label={fn} />
        ))}
        <option value="q.data" />
        <option value="event." />
      </datalist>

      {node.kind === 'on' && (
        <label className="ginsp-row">
          事件名
          <input
            value={String(draft.event ?? '')}
            onChange={(e) => set({ event: e.target.value })}
            onBlur={() => blurCommit('event')}
          />
        </label>
      )}

      {node.kind === 'call' && (
        <>
          <label className="ginsp-row">
            实例
            <select
              value={String(draft.target ?? '')}
              onChange={(e) => {
                const target = e.target.value
                const methods = methodOptions(target)
                // 切实例后方法大概率失效：无候选时回退空，有候选取首个
                const method = methods.includes(String(draft.method ?? '')) ? draft.method : (methods[0] ?? '')
                commit({ target, method } as unknown as Partial<GNode>)
                set({ target, method })
              }}
            >
              {callTargetOptions.map((t) => (
                <option key={t} value={t}>{t}</option>
              ))}
            </select>
          </label>
          <label className="ginsp-row">
            方法
            <select
              value={String(draft.method ?? '')}
              onChange={(e) => {
                commit({ method: e.target.value } as unknown as Partial<GNode>)
                set({ method: e.target.value })
              }}
            >
              {methodOptions(String(draft.target ?? '')).map((m) => (
                <option key={m} value={m}>{m}</option>
              ))}
            </select>
          </label>
          <div className="ginsp-row">
            参数（首参作为命令参数；表达式）
            {(Array.isArray(draft.args) ? (draft.args as string[]) : []).map((arg, i) => (
              <div key={i} className="ginsp-argline">
                <ExprInput
                  value={arg}
                  onChange={(v) => {
                    const args = [...(draft.args as string[])]
                    args[i] = v
                    set({ args })
                  }}
                  onCommit={() => blurCommit('args')}
                />
                <button
                  type="button"
                  className="ginsp-argdel"
                  title="删除该参数"
                  onClick={() => {
                    const args = (draft.args as string[]).filter((_, j) => j !== i)
                    commit({ args } as unknown as Partial<GNode>)
                    set({ args })
                  }}
                >
                  ×
                </button>
              </div>
            ))}
            <button
              type="button"
              onClick={() => {
                const args = [...(Array.isArray(draft.args) ? (draft.args as string[]) : []), '']
                commit({ args } as unknown as Partial<GNode>)
                set({ args })
              }}
            >
              + 参数
            </button>
          </div>
        </>
      )}

      {node.kind === 'assign' && (
        <>
          <label className="ginsp-row">
            变量
            <select
              value={String(draft.target ?? '')}
              onChange={(e) => {
                commit({ target: e.target.value } as unknown as Partial<GNode>)
                set({ target: e.target.value })
              }}
            >
              {varNames.map((v) => (
                <option key={v} value={v}>{`v.${v}`}</option>
              ))}
            </select>
          </label>
          <AssignValueEditor node={node} draft={draft} doc={doc} set={set} commit={commit} exprDatalistId={exprDatalistId} />
        </>
      )}

      {node.kind === 'branch' && (
        <label className="ginsp-row">
          条件（失焦即保存）
          <ExprInput
            value={String(draft.cond ?? '')}
            onChange={(v) => set({ cond: v })}
            onCommit={() => blurCommit('cond')}
            placeholder="v.score >= 10"
          />
        </label>
      )}

      {node.kind === 'loop' && (
        <>
          <label className="ginsp-row">
            模式
            <select
              value={String(draft.mode ?? 'repeat')}
              onChange={(e) => {
                const mode = e.target.value as 'while' | 'repeat'
                // 切模式时补默认字段，避免缺 cond/times 的结构 lint
                const patch = mode === 'while' ? { mode, cond: String(draft.cond ?? '') || 'false', times: undefined } : { mode, times: String(draft.times ?? '') || '3', cond: undefined }
                commit(patch as unknown as Partial<GNode>)
                set(patch)
              }}
            >
              <option value="repeat">repeat（固定次数）</option>
              <option value="while">while（条件）</option>
            </select>
          </label>
          {draft.mode === 'while' ? (
            <label className="ginsp-row">
              条件（失焦即保存）
              <ExprInput value={String(draft.cond ?? '')} onChange={(v) => set({ cond: v })} onCommit={() => blurCommit('cond')} />
            </label>
          ) : (
            <label className="ginsp-row">
              次数（失焦即保存）
              <ExprInput value={String(draft.times ?? '')} onChange={(v) => set({ times: v })} onCommit={() => blurCommit('times')} />
            </label>
          )}
        </>
      )}

      {node.kind === 'wait' && (
        <label className="ginsp-row">
          毫秒（失焦即保存）
          <ExprInput value={String(draft.ms ?? '')} onChange={(v) => set({ ms: v })} onCommit={() => blurCommit('ms')} />
        </label>
      )}

      {node.kind === 'emit' && (
        <>
          <label className="ginsp-row">
            内部事件（名:名）
            <input
              value={String(draft.event ?? '')}
              onChange={(e) => set({ event: e.target.value })}
              onBlur={() => blurCommit('event')}
            />
          </label>
          <EmitPayloadEditor node={node} draft={draft} set={set} commit={commit} exprDatalistId={exprDatalistId} />
        </>
      )}

      {node.kind === 'comment' && (
        <label className="ginsp-row">
          文本
          <textarea
            value={String(draft.text ?? '')}
            rows={2}
            onChange={(e) => set({ text: e.target.value })}
            onBlur={() => blurCommit('text')}
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

/** assign 的值编辑：表达式 / 查询调用 两种模式 */
function AssignValueEditor(props: {
  node: Extract<GNode, { kind: 'assign' }>
  draft: Record<string, unknown>
  doc: LevelDoc
  set: (patch: Record<string, unknown>) => void
  commit: (patch: Record<string, unknown>) => void
  exprDatalistId: string
}) {
  const { node, draft, doc, set, commit } = props
  const value = node.value
  const mode = 'call' in value ? 'call' : 'expr'
  const comps = doc.content.components.map((c) => c.id)

  const switchMode = (next: 'expr' | 'call'): void => {
    if (next === mode) return
    const patch =
      next === 'call'
        ? { value: { call: { target: comps[0] ?? '', method: '', args: [] } } }
        : { value: { expr: '' } }
    commit(patch as unknown as Partial<GNode>)
    set(patch)
  }
  const writeValue = (v: unknown): void => {
    commit({ value: v } as unknown as Partial<GNode>)
    set({ value: v })
  }

  return (
    <div className="ginsp-row">
      值
      <div className="ginsp-modes">
        <button type="button" className={mode === 'expr' ? 'active' : ''} onClick={() => switchMode('expr')}>
          表达式
        </button>
        <button type="button" className={mode === 'call' ? 'active' : ''} onClick={() => switchMode('call')}>
          查询调用
        </button>
      </div>
      {mode === 'expr' ? (
        <ExprInput
          value={'expr' in (draft.value as object) ? String((draft.value as { expr: string }).expr) : ''}
          onChange={(v) => {
            set({ value: { expr: v } })
          }}
          onCommit={() => commit({ value: draft.value } as unknown as Partial<GNode>)}
        />
      ) : (
        (() => {
          const call = (draft.value as { call?: { target: string; method: string; args: string[] } }).call ?? { target: '', method: '', args: [] }
          const queryMethods = Object.keys(
            getDef(doc.content.components.find((c) => c.id === call.target)?.type ?? '').contract.queries ?? {},
          )
          return (
            <>
              <select
                value={call.target}
                onChange={(e) => writeValue({ call: { ...call, target: e.target.value, method: '' } })}
              >
                {comps.map((c) => (
                  <option key={c} value={c}>{c}</option>
                ))}
              </select>
              <select
                value={call.method}
                onChange={(e) => writeValue({ call: { ...call, method: e.target.value } })}
              >
                <option value="">（选择查询方法）</option>
                {queryMethods.map((m) => (
                  <option key={m} value={m}>{m}</option>
                ))}
              </select>
            </>
          )
        })()
      )}

    </div>
  )
}

/** emit payload 键值对编辑（键 + 表达式值） */
function EmitPayloadEditor(props: {
  node: Extract<GNode, { kind: 'emit' }>
  draft: Record<string, unknown>
  set: (patch: Record<string, unknown>) => void
  commit: (patch: Record<string, unknown>) => void
  exprDatalistId: string
}) {
  const { node, draft, set, commit } = props
  const payload: Record<string, string> = (draft.payload as Record<string, string> | undefined) ?? node.payload ?? {}
  const entries: [string, string][] = Object.entries(payload)
  const write = (next: Record<string, string>): void => {
    const clean: Record<string, string> = {}
    for (const [k, v] of Object.entries(next)) {
      if (k.trim() !== '') clean[k.trim()] = v
    }
    const patch = Object.keys(clean).length > 0 ? { payload: clean } : { payload: undefined }
    commit(patch as unknown as Partial<GNode>)
    set({ payload: next })
  }
  return (
    <div className="ginsp-row">
      负载（可选）
      {entries.map(([k, v], i) => (
        <div key={`${k}-${i}`} className="ginsp-argline">
          <input
            className="ginsp-payload-key"
            defaultValue={k}
            placeholder="键"
            onBlur={(e) => {
              const next: Record<string, string> = { ...payload }
              delete next[k]
              next[e.target.value] = v
              write(next)
            }}
          />
          <input
            defaultValue={v}
            placeholder="表达式"
            list={props.exprDatalistId}
            onBlur={(e) => write({ ...payload, [k]: e.target.value })}
          />
          <button
            type="button"
            className="ginsp-argdel"
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
          // 占位键名（空键会被 write 过滤）；用户改键后 onBlur 重写
          const base = { ...payload }
          let i = 1
          while (`key${i}` in base) i++
          write({ ...base, [`key${i}`]: '' })
        }}
      >
        + 负载项
      </button>
    </div>
  )
}
