/**
 * 推进与过关编辑条（批次10，docs/20 遗留收尾）：order（顺序/乱序）、count（本局抽题数）、
 * pass.expr（过关条件）此前只能在 JSON tab 手写或让 AI 的 edit_flow 修改——这里给结构化 UI。
 * 挂在数据表 tab 工具条下：flow 描述的就是题目行的抽取与结算，与表格语义一体。
 * 全部修改走 onChange(setFlow(doc, patch)) → EditorPage update（自动撤销/重做+标脏）。
 * 清除语义 = 删键（setFlow 归一化）：pass 删除 = 结算默认通过；count 删除 = 全部行。
 */
import { useState } from 'react'
import { parseExpr } from '../engine/expr'
import type { LevelDoc } from '../engine/level'
import { setFlow } from './docState'
import { ConditionBuilder } from './graph/controls'
import type { BridgeCtx } from './graph/exprBridge'

/** 纯语法校验（与 EditorPage.checkExprText 同一 parseExpr 真源；此处独立引用避免编辑器页循环导入） */
function exprError(text: string): string | null {
  if (text.trim() === '') return null
  try {
    parseExpr(text)
    return null
  } catch (e) {
    return e instanceof Error ? e.message : String(e)
  }
}

export function FlowEditor({ doc, onChange }: { doc: LevelDoc; onChange: (doc: LevelDoc) => void }) {
  const flow = doc.content.flow ?? {}
  const rows = doc.content.table.rows.length
  const [exprErr, setExprErr] = useState('')
  const [exprWarn, setExprWarn] = useState('')

  const varNames = Object.keys(doc.content.logic.variables ?? {}).filter((n) => !n.startsWith('__'))
  const ctx: BridgeCtx = {
    varNames,
    refPaths: doc.content.table.columns.map((c) => `q.${c.key}`),
  }
  const datalistId = 'flow-expr-suggestions'

  const patchFlow = (patch: Parameters<typeof setFlow>[1]): void => {
    onChange(setFlow(doc, patch))
  }

  /** 过关条件提交门禁：非法语法不写 doc（求值失败运行时会静默判未通过），并给出未声明变量警告 */
  const commitPassExpr = (expr: string): void => {
    const err = exprError(expr)
    if (err) {
      setExprErr(err)
      return
    }
    setExprErr('')
    const undeclared = [...expr.matchAll(/\bv\.([A-Za-z_]\w*)/g)]
      .map((m) => m[1])
      .filter((n, i, arr) => arr.indexOf(n) === i)
      .filter((n) => !varNames.includes(n))
    setExprWarn(undeclared.length > 0 ? `引用了未声明的变量：v.${undeclared.join('、v.')}（可在节点图变量面板补声明）` : '')
    patchFlow({ pass: { expr } })
  }

  const order = flow.order ?? 'sequential'
  const count = typeof flow.count === 'number' ? flow.count : null
  const passOn = !!flow.pass

  const summary = (() => {
    if (rows === 0) return '数据表暂无行——先在下方添加题目行'
    const parts: string[] = []
    parts.push(count !== null ? `本局抽 ${count} / ${rows} 题${count > rows ? '（超过行数 = 全部）' : ''}` : `全部 ${rows} 题`)
    parts.push(order === 'shuffle' ? '每次进入随机乱序' : '按行顺序')
    parts.push(passOn ? `结算校验「${String(flow.pass?.expr ?? '')}」，不满足 = 未通过` : '结算默认通过')
    return parts.join(' · ')
  })()

  return (
    <div className="flow-editor">
      <b>推进与过关</b>
      <label className="flow-field">
        <span>顺序</span>
        <select
          value={order}
          onChange={(e) => patchFlow({ order: e.target.value as 'sequential' | 'shuffle' })}
          title="sequential = 按行顺序出题；shuffle = 本局每次进入随机打乱行序（v.__row 仍指向原始行号）"
        >
          <option value="sequential">顺序出题</option>
          <option value="shuffle">随机乱序</option>
        </select>
      </label>
      <label className="flow-field">
        <span>本局题数</span>
        <input
          type="number"
          min={1}
          step={1}
          defaultValue={count ?? ''}
          placeholder="全部"
          title="本局抽多少题（空 = 全部行）；乱序下 = 随机抽 N 题"
          onBlur={(e) => {
            const raw = e.currentTarget.value.trim()
            if (raw === '') {
              patchFlow({ count: null as never }) // 归一化为删键
              return
            }
            const n = Math.trunc(Number(raw))
            if (!Number.isFinite(n) || n < 1) {
              e.currentTarget.value = count !== null ? String(count) : '' // 非法：还原显示
              return
            }
            patchFlow({ count: n })
          }}
        />
      </label>
      <label className="flow-field flow-field-check" title="勾选后结算时求值过关表达式：真 = 通过，假/求值出错 = 未通过；不勾选 = 默认通过">
        <input
          type="checkbox"
          checked={passOn}
          onChange={(e) => {
            setExprErr('')
            setExprWarn('')
            if (e.target.checked) {
              const seed = varNames.includes('score') ? 'v.score >= 10' : varNames.length > 0 ? `v.${varNames[0]}` : 'true'
              patchFlow({ pass: { expr: seed } })
            } else {
              patchFlow({ pass: null as never }) // 归一化为删键
            }
          }}
        />
        <span>结算校验过关条件</span>
      </label>
      {passOn && (
        <div className="flow-pass">
          <ConditionBuilder cond={String(flow.pass?.expr ?? 'true')} ctx={ctx} onChange={commitPassExpr} datalistId={datalistId} />
          <datalist id={datalistId}>
            {varNames.map((n) => (
              <option key={n} value={`v.${n}`} />
            ))}
            {ctx.refPaths.map((p) => (
              <option key={p} value={p} />
            ))}
          </datalist>
        </div>
      )}
      {exprErr && <span className="tone-error flow-msg">{exprErr}</span>}
      {exprWarn && <span className="flow-warn flow-msg">{exprWarn}</span>}
      <span className="muted flow-summary">{summary}</span>
    </div>
  )
}
