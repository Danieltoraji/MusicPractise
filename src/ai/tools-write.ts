/**
 * AI 写入工具七件套（批次2a，agent 模式专用）。
 * 统一走 applyAndCheck 管线：mutate 产出新 doc → loadLevelDoc 预检（Ajv+迁移+lint）→
 * 通过才 ctx.applyDoc(校验后的产物)（走编辑器唯一写路径，全视图自动刷新+标脏）；
 * 校验拒绝或 mutate 抛错则不应用，错误文本回喂模型自纠。
 * 编辑语义全部基于 docState 纯函数；结果一律返回可读中文摘要。
 */

import type { ColumnType, LevelDoc } from '../engine/level'
import type { Json } from '../engine/expr'
import { parseScript, ScriptError } from '../engine/script'
import { allContracts } from '../runtime/store'
import {
  addComponent,
  addTableColumn,
  addTableRow,
  addView,
  removeComponent,
  removeTableColumn,
  removeTableRow,
  removeView,
  setFlow,
  setMeta,
  setTableColumnType,
  updateComponent,
  updateTableCell,
  updateTableColumnLabel,
  updateView,
} from '../editor/docState'
import { loadLevelDoc } from '../library/validate'
import type { AiTool, ToolContext } from './tools'

// ---------------------------------------------------------------------------
// applyAndCheck 管线
// ---------------------------------------------------------------------------

function applyAndCheck(ctx: ToolContext, what: string | ((applied: LevelDoc) => string), mutate: (doc: LevelDoc) => LevelDoc): string {
  let next: LevelDoc
  try {
    next = mutate(ctx.getDoc())
  } catch (err) {
    return `修改失败（未应用）：${err instanceof Error ? err.message : String(err)}`
  }
  const check = loadLevelDoc(structuredClone(next))
  if (!check.ok) {
    return `修改被校验拒绝（未应用）——请修正后重试：\n${check.errors.map((e) => `- ${e}`).join('\n')}`
  }
  ctx.applyDoc(check.doc)
  const label = typeof what === 'function' ? what(check.doc) : what
  const warns = check.lintWarnings.length > 0 ? `\n校验警告：${check.lintWarnings.join('；')}` : ''
  return `✓ ${label}已应用。${warns}`
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '')
const obj = (v: unknown): Record<string, unknown> => (typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : {})

// ---------------------------------------------------------------------------
// write_script
// ---------------------------------------------------------------------------

const writeScriptTool: AiTool = {
  name: 'write_script',
  description:
    '用 LevelScript 伪代码全文替换关卡逻辑（节点图随之重建，变量声明保留）。' +
    '语法：on 事件 { … }、v.x = 表达式、实例.方法(参数)、if/else、while/repeat、wait、emit；' +
    '事件与组件 id 必须与 read_doc/read_script 读到的一致',
  parameters: {
    type: 'object',
    properties: { script: { type: 'string', description: '完整的 LevelScript 伪代码（全文替换，不是增量补丁）' } },
    required: ['script'],
  },
  exec: (args, ctx) => {
    const script = str(args.script)
    if (!script.trim()) return '修改失败（未应用）：script 不能为空'
    try {
      const parsed = parseScript(script, { variables: ctx.getDoc().content.logic.variables, idPrefix: 's' })
      const events = parsed.nodes.filter((n) => n.kind === 'on').map((n) => (n as { event: string }).event)
      const summary = `替换逻辑为 ${parsed.nodes.length} 节点 / ${parsed.edges.length} 连线，事件入口：${events.join('、') || '无'}`
      return applyAndCheck(ctx, `逻辑已替换（${summary}）`, (doc) => ({ ...doc, content: { ...doc.content, logic: parsed } }))
    } catch (err) {
      if (err instanceof ScriptError) {
        return `伪代码解析失败（未应用）：第 ${err.line} 行第 ${err.col} 列——${err.message}。请修正语法后重试（可先 read_script 看当前写法）。`
      }
      return `修改失败（未应用）：${err instanceof Error ? err.message : String(err)}`
    }
  },
}

// ---------------------------------------------------------------------------
// edit_table
// ---------------------------------------------------------------------------

const COLUMN_TYPE_SET = new Set<string>(['text', 'number', 'boolean', 'notes', 'list', 'json'])

const editTableTool: AiTool = {
  name: 'edit_table',
  description:
    '修改题目数据表。op=add_rows 批量加行（行对象的 key 必须是现有列）；update_cell 改某行若干单元格（row 从 0 起）；' +
    'add_column/set_column_type/set_column_label 管列；remove_row/remove_column 删（不可撤销，谨慎）',
  parameters: {
    type: 'object',
    properties: {
      op: { type: 'string', enum: ['add_rows', 'update_cell', 'add_column', 'set_column_type', 'set_column_label', 'remove_row', 'remove_column'] },
      rows: { type: 'array', description: 'add_rows：行对象数组，key 必须匹配现有列' },
      row: { type: 'number', description: 'update_cell/remove_row：行号（0 起）' },
      patch: { type: 'object', description: 'update_cell：{列key: 新值}' },
      key: { type: 'string', description: '列 key' },
      label: { type: 'string', description: 'add_column/set_column_label：显示名' },
      type: { type: 'string', enum: ['text', 'number', 'boolean', 'notes', 'list', 'json'], description: 'add_column/set_column_type：列类型' },
    },
    required: ['op'],
  },
  exec: (args, ctx) => {
    const op = str(args.op)
    const doc = ctx.getDoc()
    const colKeys = doc.content.table.columns.map((c) => c.key)

    if (op === 'add_rows') {
      const rows = Array.isArray(args.rows) ? (args.rows as unknown[]).map(obj) : []
      if (rows.length === 0) return '修改失败（未应用）：rows 不能为空'
      const bad = rows.flatMap((r) => Object.keys(r).filter((k) => !colKeys.includes(k)))
      if (bad.length > 0) {
        return `修改失败（未应用）：行中出现了不存在的列 ${[...new Set(bad)].join('、')}。现有列：${colKeys.join('、')}（可先用 add_column 建列）`
      }
      return applyAndCheck(ctx, `数据表已追加 ${rows.length} 行（现共 ${doc.content.table.rows.length + rows.length} 行）`, (d) => {
        for (const r of rows) {
          const idx = d.content.table.rows.length
          d = addTableRow(d)
          d = updateTableCell(d, idx, r as Record<string, Json>)
        }
        return d
      })
    }
    if (op === 'update_cell') {
      const row = Number(args.row)
      const patch = obj(args.patch)
      if (!Number.isInteger(row) || row < 0 || row >= doc.content.table.rows.length) {
        return `修改失败（未应用）：行号越界（0–${doc.content.table.rows.length - 1}，共 ${doc.content.table.rows.length} 行）`
      }
      const bad = Object.keys(patch).filter((k) => !colKeys.includes(k))
      if (bad.length > 0) return `修改失败（未应用）：不存在的列 ${bad.join('、')}。现有列：${colKeys.join('、')}`
      return applyAndCheck(ctx, `第 ${row} 行已更新（${Object.keys(patch).join('、')}）`, (d) => updateTableCell(d, row, patch as Record<string, Json>))    }
    if (op === 'add_column') {
      const key = str(args.key)
      const label = str(args.label)
      const type = str(args.type)
      return applyAndCheck(ctx, `列 ${key} 已添加`, (d) => {
        let out = addTableColumn(d, key, label || undefined)
        if (type) out = setTableColumnType(out, key, type as ColumnType)
        return out
      })
    }
    if (op === 'set_column_type') {
      const key = str(args.key)
      const type = str(args.type)
      if (!COLUMN_TYPE_SET.has(type)) return `修改失败（未应用）：未知列类型 ${type}（可选 text/number/boolean/notes/list/json）`
      if (!colKeys.includes(key)) return `修改失败（未应用）：列 ${key} 不存在。现有列：${colKeys.join('、')}`
      return applyAndCheck(ctx, `列 ${key} 类型已设为 ${type}`, (d) => setTableColumnType(d, key, type as ColumnType))
    }
    if (op === 'set_column_label') {
      const key = str(args.key)
      if (!colKeys.includes(key)) return `修改失败（未应用）：列 ${key} 不存在`
      return applyAndCheck(ctx, `列 ${key} 显示名已更新`, (d) => updateTableColumnLabel(d, key, str(args.label)))
    }
    if (op === 'remove_row') {
      const row = Number(args.row)
      if (!Number.isInteger(row) || row < 0 || row >= doc.content.table.rows.length) {
        return `修改失败（未应用）：行号越界（共 ${doc.content.table.rows.length} 行）`
      }
      return applyAndCheck(ctx, `第 ${row} 行已删除（现剩 ${doc.content.table.rows.length - 1} 行）`, (d) => removeTableRow(d, row))
    }
    if (op === 'remove_column') {
      const key = str(args.key)
      if (!colKeys.includes(key)) return `修改失败（未应用）：列 ${key} 不存在`
      return applyAndCheck(ctx, `列 ${key} 已删除（注意：逻辑中引用 q.${key} 的节点会由 lint 标红）`, (d) => removeTableColumn(d, key))
    }
    return `修改失败（未应用）：未知 op「${op}」`
  },
}

// ---------------------------------------------------------------------------
// edit_components
// ---------------------------------------------------------------------------

const editComponentsTool: AiTool = {
  name: 'edit_components',
  description:
    '管理画布组件实例。op=add 新增（type 必须是可用组件类型；可带 name/props/view/layout）；' +
    'op=update 按 id 改属性；op=remove 删除。添加后用返回的新 id 在 write_script 里引用它',
  parameters: {
    type: 'object',
    properties: {
      op: { type: 'string', enum: ['add', 'update', 'remove'] },
      type: { type: 'string', description: 'add：组件类型（staff/label/button/choice/input/slider/timer/sound/synth/fingering/rhythm/tuner）' },
      view: { type: 'string', description: 'add：所属视图 id（默认首视图）' },
      name: { type: 'string', description: 'add/update：显示名' },
      props: { type: 'object', description: 'add/update：组件 props' },
      layout: { type: 'object', description: 'add/update：{x,y,w,h}' },
      id: { type: 'string', description: 'update/remove：组件实例 id' },
      patch: { type: 'object', description: 'update：要改的字段（name/visible/view/layout/props）' },
    },
    required: ['op'],
  },
  exec: (args, ctx) => {
    const op = str(args.op)
    const doc = ctx.getDoc()

    if (op === 'add') {
      const type = str(args.type)
      const known = new Set(allContracts().map((c) => c.type))
      if (!known.has(type)) {
        return `修改失败（未应用）：未知组件类型「${type}」。可用：${[...known].sort().join('、')}`
      }
      const view = str(args.view) || doc.content.views[0]?.id
      if (view && !doc.content.views.some((v) => v.id === view)) {
        return `修改失败（未应用）：视图 ${view} 不存在。现有：${doc.content.views.map((v) => v.id).join('、')}`
      }
      const name = str(args.name)
      const props = obj(args.props)
      const layout = obj(args.layout)
      let newId = ''
      return applyAndCheck(
        ctx,
        () => `组件已添加：${newId}（${type}）——write_script 中即以 ${newId} 引用`,
        (d) => {
          const before = new Set(d.content.components.map((c) => c.id))
          let out = addComponent(d, type, view || undefined)
          newId = out.content.components.find((c) => !before.has(c.id))?.id ?? ''
          if (name || Object.keys(props).length > 0 || Object.keys(layout).length === 4) {
            out = updateComponent(out, newId, {
              ...(name ? { name } : {}),
              ...(Object.keys(props).length > 0 ? { props: props as Record<string, Json> } : {}),
              ...(Object.keys(layout).length === 4 ? { layout: layout as unknown as { x: number; y: number; w: number; h: number } } : {}),
            })
          }
          return out
        },
      )
    }
    if (op === 'update') {
      const id = str(args.id)
      if (!doc.content.components.some((c) => c.id === id)) {
        return `修改失败（未应用）：组件 ${id} 不存在。现有：${doc.content.components.map((c) => c.id).join('、')}`
      }
      const patch = obj(args.patch)
      const allowed: Record<string, unknown> = {}
      for (const k of ['name', 'visible', 'view', 'layout', 'props']) if (k in patch) allowed[k] = patch[k]
      if (Object.keys(allowed).length === 0) return '修改失败（未应用）：patch 为空（可改 name/visible/view/layout/props）'
      return applyAndCheck(ctx, `组件 ${id} 已更新（${Object.keys(allowed).join('、')}）`, (d) =>
        updateComponent(d, id, allowed as never),
      )
    }
    if (op === 'remove') {
      const id = str(args.id)
      if (!doc.content.components.some((c) => c.id === id)) {
        return `修改失败（未应用）：组件 ${id} 不存在。现有：${doc.content.components.map((c) => c.id).join('、')}`
      }
      return applyAndCheck(ctx, `组件 ${id} 已删除（引用它的节点会由 lint 标红，记得同步改逻辑）`, (d) => removeComponent(d, id))
    }
    return `修改失败（未应用）：未知 op「${op}」`
  },
}

// ---------------------------------------------------------------------------
// edit_meta / edit_views / edit_flow / set_variable
// ---------------------------------------------------------------------------

const editMetaTool: AiTool = {
  name: 'edit_meta',
  description: '修改关卡元信息：title（标题）/ description（描述）/ difficulty（1–5）/ tags（标签数组）等',
  parameters: {
    type: 'object',
    properties: {
      patch: {
        type: 'object',
        description: '要修改的 meta 字段，如 {"title":"新的标题","difficulty":3,"tags":["练耳"]}',
      },
    },
    required: ['patch'],
  },
  exec: (args, ctx) => {
    const patch = obj(args.patch)
    if (Object.keys(patch).length === 0) return '修改失败（未应用）：patch 为空'
    if ('difficulty' in patch) patch.difficulty = clampDifficulty(patch.difficulty)
    return applyAndCheck(ctx, `meta 已更新（${Object.keys(patch).join('、')}）`, (d) => setMeta(d, patch as never))
  },
}
function clampDifficulty(v: unknown): unknown {
  const n = Number(v)
  return Number.isFinite(n) ? Math.min(5, Math.max(1, Math.round(n))) : v
}

const editViewsTool: AiTool = {
  name: 'edit_views',
  description: '管理互斥视图。op=add 新增（可带 name）；op=rename 改显示名；op=remove 删除（其组件级联删除，关卡至少保留一个视图）',
  parameters: {
    type: 'object',
    properties: {
      op: { type: 'string', enum: ['add', 'rename', 'remove'] },
      id: { type: 'string', description: 'rename/remove：视图 id' },
      name: { type: 'string', description: 'add/rename：视图显示名' },
    },
    required: ['op'],
  },
  exec: (args, ctx) => {
    const op = str(args.op)
    const doc = ctx.getDoc()
    if (op === 'add') {
      let newId = ''
      const name = str(args.name)
      return applyAndCheck(ctx, () => `视图已添加（新视图 id=${newId}，views.goto 即可跳转）`, (d) => {
        const r = addView(d, name || undefined)
        newId = r.id
        return r.doc
      })
    }
    if (op === 'rename') {
      const id = str(args.id)
      if (!doc.content.views.some((v) => v.id === id)) return `修改失败（未应用）：视图 ${id} 不存在`
      return applyAndCheck(ctx, `视图 ${id} 已改名`, (d) => updateView(d, id, { name: str(args.name) }))
    }
    if (op === 'remove') {
      const id = str(args.id)
      if (!doc.content.views.some((v) => v.id === id)) return `修改失败（未应用）：视图 ${id} 不存在`
      if (doc.content.views.length <= 1) return '修改失败（未应用）：至少保留一个视图'
      const cascade = doc.content.components.filter((c) => c.view === id).length
      return applyAndCheck(ctx, `视图 ${id} 已删除${cascade > 0 ? `（级联删除其 ${cascade} 个组件）` : ''}`, (d) => removeView(d, id))
    }
    return `修改失败（未应用）：未知 op「${op}」`
  },
}

const editFlowTool: AiTool = {
  name: 'edit_flow',
  description: '修改推进与过关配置：order（sequential 顺序 / shuffle 随机）、count（本局抽题数）、pass.expr（过关条件表达式，如 v.score >= 60）',
  parameters: {
    type: 'object',
    properties: {
      order: { type: 'string', enum: ['sequential', 'shuffle'] },
      count: { type: 'number', description: '抽题数（null = 全部）' },
      pass: { type: 'string', description: '过关条件表达式；传空串 = 清除过关条件' },
    },
  },
  exec: (args, ctx) => {
    const patch: Record<string, unknown> = {}
    if ('order' in args) patch.order = str(args.order) || undefined
    if ('count' in args) patch.count = args.count === null ? null : Number(args.count)
    if ('pass' in args) patch.pass = str(args.pass).trim() === '' ? null : { expr: str(args.pass) }
    if (Object.keys(patch).length === 0) return '修改失败（未应用）：未给出任何字段'
    return applyAndCheck(ctx, `推进配置已更新（${Object.keys(patch).join('、')}）`, (d) => setFlow(d, patch as never))
  },
}

const setVariableTool: AiTool = {
  name: 'set_variable',
  description: '管理逻辑变量。op=set 声明/改初值（value 为 JSON 值：数字/布尔/字符串/数组/对象）；op=rename 改名；op=remove 删除（双下划线开头为系统变量不可改）',
  parameters: {
    type: 'object',
    properties: {
      op: { type: 'string', enum: ['set', 'rename', 'remove'] },
      name: { type: 'string', description: '变量名' },
      value: { description: 'op=set：初值（JSON）' },
      newName: { type: 'string', description: 'op=rename：新名' },
    },
    required: ['op', 'name'],
  },
  exec: (args, ctx) => {
    const op = str(args.op)
    const name = str(args.name)
    const guard = (n: string): string | null =>
      n.startsWith('__') ? `修改失败（未应用）：${n} 是系统变量（双下划线保留字），不可通过工具修改` : null
    const doc = ctx.getDoc()
    const vars = doc.content.logic.variables ?? {}

    if (op === 'set') {
      const bad = guard(name)
      if (bad) return bad
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) return `修改失败（未应用）：变量名 ${name} 非法（字母/下划线开头，仅字母数字下划线）`
      return applyAndCheck(
        ctx,
        `变量 ${name} 已声明（初值 ${JSON.stringify(args.value ?? 0)}）——write_script 中以 v.${name} 引用`,
        (d) => {
          const next = structuredClone(d)
          next.content.logic.variables = { ...(next.content.logic.variables ?? {}), [name]: (args.value ?? 0) as Json }
          return next
        },
      )
    }
    if (op === 'rename') {
      const newName = str(args.newName)
      const bad = guard(newName) ?? guard(name)
      if (bad) return bad
      if (!(name in vars)) return `修改失败（未应用）：变量 ${name} 不存在。现有：${Object.keys(vars).join('、')}`
      return applyAndCheck(ctx, `变量 ${name} 已改名为 ${newName}（注意：assign 节点会同步，表达式旧引用由 lint 提示）`, (d) => {
        const next = structuredClone(d)
        const v = { ...(next.content.logic.variables ?? {}) }
        v[newName] = v[name]
        delete v[name]
        next.content.logic.variables = v
        return next
      })
    }
    if (op === 'remove') {
      const bad = guard(name)
      if (bad) return bad
      if (!(name in vars)) return `修改失败（未应用）：变量 ${name} 不存在`
      return applyAndCheck(ctx, `变量 ${name} 已删除（引用它的表达式会由 lint 标红）`, (d) => {
        const next = structuredClone(d)
        const v = { ...(next.content.logic.variables ?? {}) }
        delete v[name]
        next.content.logic.variables = v
        return next
      })
    }
    return `修改失败（未应用）：未知 op「${op}」`
  },
}

/** 写入工具集：agent 模式在只读工具之外追加这组 */
export const WRITE_TOOLS: AiTool[] = [
  writeScriptTool,
  editTableTool,
  editComponentsTool,
  editMetaTool,
  editViewsTool,
  editFlowTool,
  setVariableTool,
]
