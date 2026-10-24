/**
 * AI 写入工具七件套（批次2a，agent 模式专用）。
 * 统一走 applyAndCheck 管线：mutate 产出新 doc → loadLevelDoc 预检（Ajv+迁移+lint）→
 * 通过才 ctx.applyDoc(校验后的产物)（走编辑器唯一写路径，全视图自动刷新+标脏）；
 * 校验拒绝或 mutate 抛错则不应用，错误文本回喂模型自纠。
 * 编辑语义全部基于 docState 纯函数；结果一律返回可读中文摘要。
 */

import { COLUMN_TYPE_LABELS, type ColumnType, type LevelDoc } from '../engine/level'
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
      type: {
        // F19（docs/44 R16）：列类型枚举从 COLUMN_TYPE_LABELS 派生，不再手写第二份清单
        type: 'string',
        enum: Object.keys(COLUMN_TYPE_LABELS),
        description: `add_column/set_column_type：列类型（${Object.entries(COLUMN_TYPE_LABELS)
          .map(([k, v]) => `${k}=${v}`)
          .join('/')}）`,
      },
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

/** F8（docs/44 R16）：组件 layout 逐字段解析——未知键/非数字/不完整给出可读错误，
 * 不再静默忽略或整块丢弃（此前 add 只收恰好 4 键，update 直接整体替换/透传）。 */
const LAYOUT_KEYS = ['x', 'y', 'w', 'h'] as const
type FullLayout = { x: number; y: number; w: number; h: number }

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function parseLayout(raw: unknown, base: unknown, requireComplete: boolean): { layout?: FullLayout; error?: string } {
  if (raw === undefined || raw === null) return {}
  if (!isPlainObject(raw)) return { error: 'layout 必须是对象 {x,y,w,h}' }
  const provided = Object.keys(raw)
  if (provided.length === 0) return {}
  const badKeys = provided.filter((k) => !(LAYOUT_KEYS as readonly string[]).includes(k))
  if (badKeys.length > 0) return { error: `layout 含不支持的字段「${badKeys.join('、')}」（只允许 x/y/w/h）` }
  const merged: Record<string, unknown> = { ...(isPlainObject(base) ? base : {}), ...raw }
  const missing = LAYOUT_KEYS.filter((k) => typeof merged[k] !== 'number' || !Number.isFinite(merged[k] as number))
  if (missing.length > 0) {
    return {
      error: requireComplete
        ? `layout 需要完整的 x/y/w/h（缺少或非数字：${missing.join('、')}）`
        : `layout 缺少可合并的现有坐标（缺少：${missing.join('、')}）；请一次给全 x/y/w/h`,
    }
  }
  return { layout: { x: merged.x as number, y: merged.y as number, w: merged.w as number, h: merged.h as number } }
}

/** F8：props 深合并（对象递归合并、数组/标量整体替换；replaceProps=true 时整体替换） */
function mergePropsDeep(base: unknown, patch: unknown): Record<string, Json> {
  const out: Record<string, Json> = { ...(isPlainObject(base) ? (base as Record<string, Json>) : {}) }
  if (!isPlainObject(patch)) return out
  for (const [k, v] of Object.entries(patch)) {
    const cur = out[k]
    out[k] = isPlainObject(v) && isPlainObject(cur) ? (mergePropsDeep(cur, v) as Json) : (v as Json)
  }
  return out
}

/** F8：把 update patch 规划为最终写入值（props 深合并 / layout 与现有坐标合并并校验） */
function planComponentPatch(
  comp: { layout?: unknown; props?: unknown },
  patch: Record<string, unknown>,
  replaceProps: boolean,
): { planned?: Record<string, unknown>; error?: string } {
  const planned: Record<string, unknown> = { ...patch }
  if ('layout' in patch) {
    const r = parseLayout(patch.layout, comp.layout, false)
    if (r.error) return { error: r.error }
    if (r.layout) planned.layout = r.layout
    else delete planned.layout
  }
  if ('props' in patch) {
    if (!isPlainObject(patch.props)) return { error: 'props 必须是对象（如 {"text":"确定"}）' }
    planned.props = replaceProps ? patch.props : mergePropsDeep(comp.props, patch.props)
  }
  return { planned }
}

/** F19（docs/44 R16）：组件类型清单从运行时契约派生，避免工具描述与契约双清单漂移 */
const COMPONENT_TYPE_NAMES = allContracts().map((c) => c.type).sort()

const editComponentsTool: AiTool = {
  name: 'edit_components',
  description:
    '管理画布组件实例。op=add 新增（type 必须是可用组件类型；可带 name/props/view/layout）——多个组件用 items 一次批量添加（推荐）；' +
    'op=update 按 id 改属性（批量用 updates: [{id,patch}]）；op=remove 删除（批量用 ids 数组）。' +
    '添加后用返回的新 id 在 write_script 里引用它',
  parameters: {
    type: 'object',
    properties: {
      op: { type: 'string', enum: ['add', 'update', 'remove'] },
      type: { type: 'string', description: `add：组件类型（${COMPONENT_TYPE_NAMES.join('/')}）` },
      view: { type: 'string', description: 'add：所属视图 id（默认首视图）' },
      name: { type: 'string', description: 'add/update：显示名' },
      props: { type: 'object', description: 'add/update：组件 props（update 默认与现有 props 深合并）' },
      layout: { type: 'object', description: 'add/update：{x,y,w,h}（update 可只给部分字段，与现有坐标合并）' },
      replaceProps: { type: 'boolean', description: 'update：true 时 props 整体替换（默认深合并）' },
      items: {
        type: 'array',
        description: 'add 批量：一次添加多个组件（与单件参数二选一，多组件时优先用它）',
        items: {
          type: 'object',
          properties: { type: { type: 'string' }, view: { type: 'string' }, name: { type: 'string' }, props: { type: 'object' }, layout: { type: 'object' } },
          required: ['type'],
        },
      },
      id: { type: 'string', description: 'update/remove：组件实例 id' },
      patch: { type: 'object', description: 'update：要改的字段（name/visible/view/layout/props）' },
      updates: {
        type: 'array',
        description: 'update 批量：一次改多个组件（与 id/patch 二选一）',
        items: {
          type: 'object',
          properties: { id: { type: 'string' }, patch: { type: 'object' }, replaceProps: { type: 'boolean' } },
          required: ['id', 'patch'],
        },
      },
      ids: { type: 'array', items: { type: 'string' }, description: 'remove 批量：一次删除多个组件 id（与 id 二选一）' },
    },
    required: ['op'],
  },
  exec: (args, ctx) => {
    const op = str(args.op)
    const doc = ctx.getDoc()
    /** 只放行可改字段（单件与批量 update 共用） */
    const pickPatch = (patch: unknown): Record<string, unknown> => {
      const p = obj(patch)
      const allowed: Record<string, unknown> = {}
      for (const k of ['name', 'visible', 'view', 'layout', 'props']) if (k in p) allowed[k] = p[k]
      return allowed
    }

    if (op === 'add') {
      const known = new Set(allContracts().map((c) => c.type))
      const defView = doc.content.views[0]?.id
      // 批量形态：items 一次添加多个组件（任一类型/视图非法则整批不应用）
      if (Array.isArray(args.items)) {
        const items = (args.items as unknown[]).map(obj)
        if (items.length === 0) return '修改失败（未应用）：items 不能为空'
        const badTypes = [...new Set(items.map((it) => str(it.type)).filter((t) => !known.has(t)))]
        if (badTypes.length > 0) {
          return `修改失败（未应用）：未知组件类型「${badTypes.join('、')}」。可用：${[...known].sort().join('、')}`
        }
        const badViews = [
          ...new Set(items.map((it) => str(it.view) || (defView ?? '')).filter((v) => v && !doc.content.views.some((x) => x.id === v))),
        ]
        if (badViews.length > 0) {
          return `修改失败（未应用）：视图 ${badViews.join('、')} 不存在。现有：${doc.content.views.map((v) => v.id).join('、')}`
        }
        // F8：批量项 layout/props 预检——任一项非法则整批不应用，避免半批成功
        const itemLayouts: (FullLayout | undefined)[] = []
        const itemProblems: string[] = []
        for (const [i, it] of items.entries()) {
          const r = parseLayout(it.layout, undefined, true)
          if (r.error) itemProblems.push(`第 ${i + 1} 项：${r.error}`)
          itemLayouts.push(r.layout)
          if ('props' in it && !isPlainObject(it.props)) itemProblems.push(`第 ${i + 1} 项：props 必须是对象（如 {"text":"确定"}）`)
        }
        if (itemProblems.length > 0) return `修改失败（未应用）：${itemProblems.join('；')}`
        const labels: string[] = []
        return applyAndCheck(
          ctx,
          () => `已添加 ${labels.length} 个组件：${labels.join('、')}——write_script 中即以这些 id 引用`,
          (d) => {
            let out = d
            for (const [idx, it] of items.entries()) {
              const before = new Set(out.content.components.map((c) => c.id))
              out = addComponent(out, str(it.type), str(it.view) || defView || undefined)
              const newId = out.content.components.find((c) => !before.has(c.id))?.id ?? ''
              const name = str(it.name)
              const props = obj(it.props)
              const layout = itemLayouts[idx]
              if (name || Object.keys(props).length > 0 || layout) {
                out = updateComponent(out, newId, {
                  ...(name ? { name } : {}),
                  ...(Object.keys(props).length > 0 ? { props: props as Record<string, Json> } : {}),
                  ...(layout ? { layout } : {}),
                })
              }
              labels.push(`${newId}（${str(it.type)}${name ? `·${name}` : ''}）`)
            }
            return out
          },
        )
      }
      const type = str(args.type)
      if (!known.has(type)) {
        return `修改失败（未应用）：未知组件类型「${type}」。可用：${[...known].sort().join('、')}`
      }
      const view = str(args.view) || doc.content.views[0]?.id
      if (view && !doc.content.views.some((v) => v.id === view)) {
        return `修改失败（未应用）：视图 ${view} 不存在。现有：${doc.content.views.map((v) => v.id).join('、')}`
      }
      const name = str(args.name)
      if ('props' in args && !isPlainObject(args.props)) return '修改失败（未应用）：props 必须是对象（如 {"text":"确定"}）'
      const props = obj(args.props)
      const layoutParsed = parseLayout(args.layout, undefined, true)
      if (layoutParsed.error) return `修改失败（未应用）：${layoutParsed.error}`
      const layout = layoutParsed.layout
      let newId = ''
      return applyAndCheck(
        ctx,
        () => `组件已添加：${newId}（${type}）——write_script 中即以 ${newId} 引用`,
        (d) => {
          const before = new Set(d.content.components.map((c) => c.id))
          let out = addComponent(d, type, view || undefined)
          newId = out.content.components.find((c) => !before.has(c.id))?.id ?? ''
          if (name || Object.keys(props).length > 0 || layout) {
            out = updateComponent(out, newId, {
              ...(name ? { name } : {}),
              ...(Object.keys(props).length > 0 ? { props: props as Record<string, Json> } : {}),
              ...(layout ? { layout } : {}),
            })
          }
          return out
        },
      )
    }
    if (op === 'update') {
      // 批量形态：updates 一次改多个组件（任一 id 不存在或 patch 为空则整批不应用）
      if (Array.isArray(args.updates)) {
        const updates = (args.updates as unknown[]).map(obj)
        if (updates.length === 0) return '修改失败（未应用）：updates 不能为空'
        const problems: string[] = []
        const plans: { id: string; patch: Record<string, unknown> }[] = []
        for (const [i, u] of updates.entries()) {
          const id = str(u.id)
          const comp = doc.content.components.find((c) => c.id === id)
          if (!comp) {
            problems.push(`第 ${i + 1} 项：组件 ${id} 不存在`)
            continue
          }
          const allowed = pickPatch(u.patch)
          if (Object.keys(allowed).length === 0) {
            problems.push(`第 ${i + 1} 项：组件 ${id} 的 patch 为空（可改 name/visible/view/layout/props）`)
            continue
          }
          const plan = planComponentPatch(comp, allowed, u.replaceProps === true)
          if (plan.error) {
            problems.push(`第 ${i + 1} 项：组件 ${id} ${plan.error}`)
            continue
          }
          plans.push({ id, patch: plan.planned! })
        }
        if (problems.length > 0) {
          return `修改失败（未应用）：${problems.join('；')}。现有组件：${doc.content.components.map((c) => c.id).join('、')}`
        }
        return applyAndCheck(ctx, `已更新 ${plans.length} 个组件（${plans.map((p) => p.id).join('、')}）`, (d) => {
          let out = d
          for (const p of plans) out = updateComponent(out, p.id, p.patch as never)
          return out
        })
      }
      const id = str(args.id)
      const comp = doc.content.components.find((c) => c.id === id)
      if (!comp) {
        return `修改失败（未应用）：组件 ${id} 不存在。现有：${doc.content.components.map((c) => c.id).join('、')}`
      }
      const allowed = pickPatch(args.patch)
      if (Object.keys(allowed).length === 0) return '修改失败（未应用）：patch 为空（可改 name/visible/view/layout/props）'
      const plan = planComponentPatch(comp, allowed, args.replaceProps === true)
      if (plan.error) return `修改失败（未应用）：${plan.error}`
      return applyAndCheck(ctx, `组件 ${id} 已更新（${Object.keys(plan.planned!).join('、')}）`, (d) =>
        updateComponent(d, id, plan.planned as never),
      )
    }
    if (op === 'remove') {
      // 批量形态：ids 一次删除多个组件
      if (Array.isArray(args.ids)) {
        const ids = (args.ids as unknown[]).map(str).filter((x) => x !== '')
        if (ids.length === 0) return '修改失败（未应用）：ids 不能为空'
        const missing = ids.filter((id) => !doc.content.components.some((c) => c.id === id))
        if (missing.length > 0) {
          return `修改失败（未应用）：组件 ${missing.join('、')} 不存在。现有：${doc.content.components.map((c) => c.id).join('、')}`
        }
        return applyAndCheck(
          ctx,
          () => `已删除 ${ids.length} 个组件（${ids.join('、')}）——引用它们的节点会由 lint 标红，记得同步改逻辑`,
          (d) => {
            let out = d
            for (const id of ids) out = removeComponent(out, id)
            return out
          },
        )
      }
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
  description:
    '管理互斥视图。op=add 新增（可带 name）；op=rename 改显示名；op=remove 删除（其组件级联删除，关卡至少保留一个视图）。' +
    '多个操作可用 ops 数组一次批量执行（如同时建 3 个视图）',
  parameters: {
    type: 'object',
    properties: {
      op: { type: 'string', enum: ['add', 'rename', 'remove'], description: '单件形态的 op（用 ops 批量时可省略）' },
      id: { type: 'string', description: 'rename/remove：视图 id' },
      name: { type: 'string', description: 'add/rename：视图显示名' },
      ops: {
        type: 'array',
        description: '批量形态：一次执行多个视图操作（与单件 op 二选一，多视图时优先用它）',
        items: {
          type: 'object',
          properties: { op: { type: 'string', enum: ['add', 'rename', 'remove'] }, id: { type: 'string' }, name: { type: 'string' } },
          required: ['op'],
        },
      },
    },
  },
  exec: (args, ctx) => {
    const doc = ctx.getDoc()

    // 批量形态：ops 一次执行多个视图操作（预检全部通过才应用）
    if (Array.isArray(args.ops)) {
      const ops = (args.ops as unknown[]).map(obj)
      if (ops.length === 0) return '修改失败（未应用）：ops 不能为空'
      const problems: string[] = []
      let removeCount = 0
      for (const [i, o] of ops.entries()) {
        const oop = str(o.op)
        const id = str(o.id)
        if (oop === 'add') continue
        if (oop !== 'rename' && oop !== 'remove') {
          problems.push(`第 ${i + 1} 项：未知 op「${oop}」`)
          continue
        }
        if (!doc.content.views.some((v) => v.id === id)) {
          problems.push(`第 ${i + 1} 项：视图 ${id} 不存在。现有：${doc.content.views.map((v) => v.id).join('、')}`)
          continue
        }
        if (oop === 'remove') removeCount += 1
      }
      if (problems.length === 0 && doc.content.views.length - removeCount < 1) {
        problems.push('至少保留一个视图（remove 项过多）')
      }
      if (problems.length > 0) return `修改失败（未应用）：${problems.join('；')}`
      let added = 0
      let renamed = 0
      let removed = 0
      const newIds: string[] = []
      return applyAndCheck(
        ctx,
        () => {
          const parts = [
            added > 0 ? `新增 ${added} 个（${newIds.join('、')}）` : '',
            renamed > 0 ? `改名 ${renamed} 个` : '',
            removed > 0 ? `删除 ${removed} 个` : '',
          ].filter(Boolean)
          return `视图批量操作完成：${parts.join('、')}`
        },
        (d) => {
          let out = d
          for (const o of ops) {
            const oop = str(o.op)
            if (oop === 'add') {
              const r = addView(out, str(o.name) || undefined)
              newIds.push(r.id)
              added += 1
              out = r.doc
            } else if (oop === 'rename') {
              out = updateView(out, str(o.id), { name: str(o.name) })
              renamed += 1
            } else {
              out = removeView(out, str(o.id))
              removed += 1
            }
          }
          return out
        },
      )
    }

    const op = str(args.op)
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
  description:
    '管理逻辑变量。op=set 声明/改初值（value 为 JSON 值：数字/布尔/字符串/数组/对象）——可用 vars 一次声明多个变量（如 {"vars":{"score":0,"level":1}}，推荐）；' +
    'op=rename 改名；op=remove 删除（双下划线开头为系统变量不可改）',
  parameters: {
    type: 'object',
    properties: {
      op: { type: 'string', enum: ['set', 'rename', 'remove'] },
      name: { type: 'string', description: '变量名（op=set 用 vars 批量时可省略）' },
      value: { description: 'op=set：初值（JSON）' },
      vars: { type: 'object', description: 'op=set 批量形态：{变量名: 初值}，一次声明多个（与 name/value 二选一，多变量时优先用它）' },
      newName: { type: 'string', description: 'op=rename：新名' },
    },
    required: ['op'],
  },
  exec: (args, ctx) => {
    const op = str(args.op)
    const name = str(args.name)
    const guard = (n: string): string | null =>
      n.startsWith('__') ? `修改失败（未应用）：${n} 是系统变量（双下划线保留字），不可通过工具修改` : null
    const doc = ctx.getDoc()
    const vars = doc.content.logic.variables ?? {}

    if (op === 'set') {
      // 批量形态：vars 对象一次声明多个；任一名字非法则整批不应用
      if (args.vars !== undefined) {
        const batch = obj(args.vars)
        const names = Object.keys(batch)
        if (names.length === 0) return '修改失败（未应用）：vars 不能为空'
        const bad = names.filter((n) => guard(n) !== null || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(n))
        if (bad.length > 0) {
          return `修改失败（未应用）：以下变量名非法或是系统保留字：${bad.join('、')}（字母/下划线开头，仅字母数字下划线；双下划线开头为系统保留）`
        }
        return applyAndCheck(
          ctx,
          `已声明 ${names.length} 个变量（${names.map((n) => `${n}=${JSON.stringify(batch[n] ?? 0)}`).join('、')}）——write_script 中以 v.名字 引用`,
          (d) => {
            const next = structuredClone(d)
            next.content.logic.variables = { ...(next.content.logic.variables ?? {}), ...(batch as Record<string, Json>) }
            return next
          },
        )
      }
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
