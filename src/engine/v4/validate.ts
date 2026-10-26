/**
 * v4 结构/引用校验（docs/53 §12 的 error 层；表达式根/写权限/可达性等语义检查在 lint.ts）。
 *
 * 输入 = 已通过 `schemas/v4/level.json` 并经 `normalizeLevelDocV4` 的文档：
 * - JSON Schema 负责字段类型/枚举/数组上限/id 形态；
 * - 本模块负责 schema 表达不了的约束：id 唯一性、跨集合引用、保留键、图结构（端口/端点/
 *   start/on 数量/terminator）、题单引用、绑定槽位、限额（行合计等）与 init 类型。
 *
 * 结果分 errors（装载拦截）与 warnings（可打开、编辑器提示）。
 */
import { DATA_APPLY_COMMANDS } from '../level'
import type { Json } from '../expr'
import {
  RESERVED_LOCAL_IDS,
  ROW_RESERVED_KEYS,
  SCHEMA_LIMITS_V4,
  isV4LocalId,
  type BehaviorProgram,
  type FlowProgram,
  type LevelDocV4,
  type QuestionRow,
  type QuestionTable,
  type StateFieldDef,
} from './model'
import { SHELL_BINDING_ROOTS, SURFACE_BINDING_ROOTS, checkV4Expr } from './expr'

export interface V4Issue {
  code: string
  level: 'error' | 'warning'
  message: string
  /** 定位：题型/行/节点/字段（可组合，编辑器用于跳转与高亮） */
  typeId?: string
  rowId?: string
  nodeId?: string
  path?: string
}

export interface V4Validation {
  ok: boolean
  errors: V4Issue[]
  warnings: V4Issue[]
}

class Issues {
  errors: V4Issue[] = []
  warnings: V4Issue[] = []

  error(code: string, message: string, extra: Omit<V4Issue, 'code' | 'level' | 'message'> = {}): void {
    this.errors.push({ code, level: 'error', message, ...extra })
  }

  warn(code: string, message: string, extra: Omit<V4Issue, 'code' | 'level' | 'message'> = {}): void {
    this.warnings.push({ code, level: 'warning', message, ...extra })
  }

  finish(): V4Validation {
    return { ok: this.errors.length === 0, errors: this.errors, warnings: this.warnings }
  }
}

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

const RESERVED_ID_SET = new Set<string>(RESERVED_LOCAL_IDS)
const RESERVED_ROW_KEY_SET = new Set<string>(ROW_RESERVED_KEYS)
const SEMVER_RE = /^\d+\.\d+\.\d+$/
const LEVEL_ID_RE = /^res_[0-9A-HJKMNP-TV-Z]{26}$/
const GRAPHLESS_TERMINALS = new Set(['return', 'restart', 'comment'])
const DUAL_PORT_NODES = new Set(['branch', 'loop', 'foreach'])
const INTERNAL_EVENT_RE = /^internal\.[A-Za-z_][A-Za-z0-9_-]*$/
const COMPONENT_EVENT_RE = /^([A-Za-z_][A-Za-z0-9_-]{0,63})\.([A-Za-z_][A-Za-z0-9_-]{0,63})$/

function str(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

function nonEmptyStr(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null
}

function isJsonObject(value: unknown): value is Record<string, Json> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function describeId(value: unknown): string {
  return typeof value === 'string' && value !== '' ? value : '（空）'
}

/** 同集合内 id 去重报错（带首次/重复位置说明） */
function checkUniqueIds(
  issues: Issues,
  ids: { id: string; what: string; typeId?: string }[],
  code = 'V4_DUPLICATE_ID',
): void {
  const seen = new Map<string, number[]>()
  ids.forEach((item, index) => {
    const at = seen.get(item.id)
    if (at) at.push(index + 1)
    else seen.set(item.id, [index + 1])
  })
  for (const [id, at] of seen) {
    if (at.length <= 1) continue
    const belongs = ids[at[1] - 1]
    issues.error(code, `${belongs.what} id「${describeId(id)}」重复出现 ${at.length} 次（第 ${at.join('、')} 项）——请改为唯一 id`)
  }
}

// ---------------------------------------------------------------------------
// 1) 身份与元信息
// ---------------------------------------------------------------------------

function validateIdentity(doc: LevelDocV4, issues: Issues): void {
  if (!LEVEL_ID_RE.test(doc.id)) {
    issues.error('V4_SCHEMA', `关卡 id「${describeId(doc.id)}」形态非法：应为 res_ + 26 位 Crockford Base32（ULID）`)
  }
  if (!SEMVER_RE.test(doc.version)) {
    issues.error('V4_SCHEMA', `版本号「${describeId(doc.version)}」形态非法：应为 x.y.z`)
  }
  const title = nonEmptyStr(doc.meta.title)
  if (!title) issues.error('V4_SCHEMA', '元信息 title 不能为空')
  else if (title.length > SCHEMA_LIMITS_V4.nameLength) {
    issues.error('V4_LIMIT', `元信息 title 超过 ${SCHEMA_LIMITS_V4.nameLength} 字`)
  }
}

// ---------------------------------------------------------------------------
// 2) shell（视图/组件/绑定）
// ---------------------------------------------------------------------------

function checkBindings(
  issues: Issues,
  layer: 'shell' | 'surface',
  comp: Record<string, unknown>,
  typeLabel: string,
): void {
  const bindings = comp.bindings
  if (bindings === undefined) return
  const compId = describeId(comp.id)
  const compType = typeof comp.type === 'string' ? comp.type : ''
  const slots = DATA_APPLY_COMMANDS[compType]
  const roots = layer === 'shell' ? SHELL_BINDING_ROOTS : SURFACE_BINDING_ROOTS
  for (const [slot, expr] of Object.entries(bindings as Record<string, unknown>)) {
    if (!slots) {
      issues.error('V4_BINDING_SLOT', `${typeLabel}「${compId}」的组件类型 "${compType}" 不支持绑定（可绑定类型：${Object.keys(DATA_APPLY_COMMANDS).join('/')}）`)
      continue
    }
    if (!Object.prototype.hasOwnProperty.call(slots, slot)) {
      issues.error('V4_BINDING_SLOT', `${typeLabel}「${compId}」的绑定槽位 "${slot}" 不被组件类型 "${compType}" 支持（可用：${Object.keys(slots).join('/')}）`)
      continue
    }
    const exprText = str(expr)
    if (exprText === null || exprText.trim() === '') {
      issues.warn('V4_BINDING_SLOT', `${typeLabel}「${compId}」的绑定槽位 "${slot}" 表达式为空，不会产生显示效果`)
      continue
    }
    const checked = checkV4Expr(exprText, { roots })
    if (!checked.ok) {
      issues.error('V4_EXPR_ROOT', `${typeLabel}「${compId}」绑定 "${slot}" 表达式非法：${checked.message}`)
    }
  }
}

function validateShell(doc: LevelDocV4, issues: Issues): void {
  const { shell } = doc.content
  checkUniqueIds(
    issues,
    shell.views.map((v) => ({ id: v.id, what: '视图' })),
  )
  const viewIds = new Set(shell.views.map((v) => v.id))
  if (shell.views.length === 0) issues.error('V4_REF', 'shell 至少需要一个视图')
  if (shell.initialView !== undefined && !viewIds.has(shell.initialView)) {
    issues.error('V4_REF', `shell.initialView 指向不存在的视图 "${shell.initialView}"`)
  }
  checkUniqueIds(
    issues,
    shell.components.map((c) => ({ id: c.id, what: 'shell 组件' })),
  )
  shell.components.forEach((rawComp) => {
    const comp = rawComp as unknown as Record<string, unknown>
    const compId = describeId(comp.id)
    if (RESERVED_ID_SET.has(compId)) {
      issues.error('V4_RESERVED', `shell 组件 id「${compId}」是保留字，会与作用域/平台伪实例冲突`)
    }
    if (comp.view !== undefined) {
      const view = str(comp.view)
      if (view === null || !viewIds.has(view)) {
        issues.error('V4_REF', `shell 组件「${compId}」指向不存在的视图「${describeId(comp.view)}」`, {
          path: `shell.components.${compId}`,
        })
      }
    }
    checkBindings(issues, 'shell', comp, 'shell 组件')
  })
  if (shell.components.length > SCHEMA_LIMITS_V4.shellComponents) {
    issues.error('V4_LIMIT', `shell 组件数超过上限 ${SCHEMA_LIMITS_V4.shellComponents}`)
  }
}

// ---------------------------------------------------------------------------
// 3) 题型定义 + 实例表
// ---------------------------------------------------------------------------

function checkStateFields(
  issues: Issues,
  fields: StateFieldDef[] | undefined,
  what: string,
  typeId: string,
): void {
  if (!fields) return
  checkUniqueIds(
    issues,
    fields.map((f) => ({ id: f.key, what: `${what}字段` })),
  )
  for (const field of fields) {
    if (!isV4LocalId(field.key)) {
      issues.error('V4_RESERVED', `题型 "${typeId}" 的 ${what} 字段 key「${describeId(field.key)}」形态非法`, {
        typeId,
        path: `types.${typeId}.${what}`,
      })
    }
    if (!initTypeMatches(field.init, field.type)) {
      issues.error('V4_SCHEMA', `题型 "${typeId}" 的 ${what} 字段 "${field.key}" 初值类型与声明 ${field.type} 不符`, {
        typeId,
        path: `types.${typeId}.${what}.${field.key}`,
      })
    }
  }
}

function initTypeMatches(init: Json | undefined, type: StateFieldDef['type']): boolean {
  switch (type) {
    case 'number':
      return typeof init === 'number' && Number.isFinite(init)
    case 'boolean':
      return typeof init === 'boolean'
    case 'string':
      return typeof init === 'string'
    case 'json':
      return true
    default:
      return false
  }
}

function validateTypesAndTables(doc: LevelDocV4, issues: Issues): void {
  const { types, tables } = doc.content
  if (types.length > SCHEMA_LIMITS_V4.types) {
    issues.error('V4_LIMIT', `题型数 ${types.length} 超过上限 ${SCHEMA_LIMITS_V4.types}`)
  }
  checkUniqueIds(
    issues,
    types.map((t) => ({ id: t.id, what: '题型' })),
  )
  const typeIds = new Set(types.map((t) => t.id))
  let totalRows = 0
  for (const table of Object.values(tables)) totalRows += table.rows.length
  if (totalRows > SCHEMA_LIMITS_V4.rowsTotal) {
    issues.error('V4_LIMIT', `全关行数 ${totalRows} 超过上限 ${SCHEMA_LIMITS_V4.rowsTotal}`)
  }
  for (const type of types) {
    if (RESERVED_ID_SET.has(type.id)) issues.error('V4_RESERVED', `题型 id「${type.id}」是保留字`, { typeId: type.id })
    if (!nonEmptyStr(type.name)) issues.error('V4_SCHEMA', `题型 "${type.id}" 缺少 name`, { typeId: type.id })
    else if (type.name.length > SCHEMA_LIMITS_V4.nameLength) {
      issues.error('V4_LIMIT', `题型 "${type.id}" 的 name 超过 ${SCHEMA_LIMITS_V4.nameLength} 字`, { typeId: type.id })
    }
    if (type.description !== undefined && type.description.length > SCHEMA_LIMITS_V4.descriptionLength) {
      issues.error('V4_LIMIT', `题型 "${type.id}" 的 description 超过 ${SCHEMA_LIMITS_V4.descriptionLength} 字`, { typeId: type.id })
    }
    checkStateFields(issues, type.state, '实例态', type.id)
    checkStateFields(issues, type.typeState, '题型态', type.id)
    checkUniqueIds(
      issues,
      (type.args ?? []).map((a) => ({ id: a.key, what: `题型 "${type.id}" 参数` })),
    )
    // surface 组件
    const surfaceIds = new Set<string>()
    type.surface.components.forEach((rawComp) => {
      const comp = rawComp as unknown as Record<string, unknown>
      const compId = describeId(comp.id)
      if (surfaceIds.has(compId)) {
        issues.error('V4_DUPLICATE_ID', `题型 "${type.id}" 的 surface 组件 id「${compId}」重复`, { typeId: type.id })
      }
      surfaceIds.add(compId)
      if (RESERVED_ID_SET.has(compId)) {
        issues.error('V4_RESERVED', `题型 "${type.id}" 的 surface 组件 id「${compId}」是保留字`, { typeId: type.id })
      }
      if (comp.view !== undefined) {
        issues.error('V4_REF', `题型 "${type.id}" 的 surface 组件「${compId}」不允许设置 view（题目区域整体渲染）`, { typeId: type.id })
      }
      checkBindings(issues, 'surface', comp, `题型 "${type.id}" 的 surface 组件`)
    })
    if (type.surface.components.length > SCHEMA_LIMITS_V4.surfaceComponentsPerType) {
      issues.error('V4_LIMIT', `题型 "${type.id}" 的 surface 组件数超过上限 ${SCHEMA_LIMITS_V4.surfaceComponentsPerType}`, {
        typeId: type.id,
      })
    }
  }
  // tables 与 types 一一对应
  for (const typeId of typeIds) {
    if (!tables[typeId]) issues.error('V4_REF', `题型 "${typeId}" 缺少实例表（content.tables.${typeId}）`, { typeId })
  }
  for (const tableId of Object.keys(tables)) {
    if (!typeIds.has(tableId)) issues.error('V4_REF', `实例表 "${tableId}" 没有对应的题型`, { path: `tables.${tableId}` })
  }
  for (const type of types) {
    const table = tables[type.id]
    if (!table) continue
    validateTable(type.id, table, issues)
  }
}

function validateTable(typeId: string, table: QuestionTable, issues: Issues): void {
  const columnKeys = new Set<string>()
  checkUniqueIds(
    issues,
    table.columns.map((c) => ({ id: c.key, what: `题型 "${typeId}" 的列` })),
  )
  for (const column of table.columns) {
    if (columnKeys.has(column.key)) continue
    columnKeys.add(column.key)
    if (!isV4LocalId(column.key)) {
      issues.error('V4_RESERVED', `题型 "${typeId}" 的列 key「${describeId(column.key)}」形态非法`, { typeId })
    }
    if (RESERVED_ROW_KEY_SET.has(column.key)) {
      issues.error('V4_RESERVED', `题型 "${typeId}" 的列 key「${column.key}」是保留字段，不能作为内容列`, { typeId })
    }
    if (column.key.length > 32) issues.error('V4_LIMIT', `题型 "${typeId}" 的列 key「${column.key}」超过 32 字符`, { typeId })
  }
  checkUniqueIds(
    issues,
    table.rows.map((r) => ({ id: r.id, what: `题型 "${typeId}" 的行` })),
  )
  for (const row of table.rows) {
    validateRow(typeId, row, columnKeys, issues)
  }
}

function validateRow(typeId: string, row: QuestionRow, columnKeys: Set<string>, issues: Issues): void {
  const rowId = describeId(row.id)
  const rowRecord = row as unknown as Record<string, unknown>
  for (const key of Object.keys(rowRecord)) {
    if (key === 'id' || key === 'draft' || key === 'phase' || key === 'order') continue
    if (RESERVED_ROW_KEY_SET.has(key)) {
      issues.error('V4_RESERVED', `题型 "${typeId}" 的行「${rowId}」含保留字段 "${key}"`, { typeId, rowId })
      continue
    }
    if (!columnKeys.has(key)) {
      issues.error('V4_REF', `题型 "${typeId}" 的行「${rowId}」内容列 "${key}" 未在表格列中声明`, { typeId, rowId })
    }
  }
}

// ---------------------------------------------------------------------------
// 4) 题单 / 发牌配置
// ---------------------------------------------------------------------------

function validateManifest(doc: LevelDocV4, issues: Issues): void {
  const manifest = doc.content.manifest
  if (!manifest) return
  const { types, tables } = doc.content
  const typeById = new Map(types.map((t) => [t.id, t]))
  const seen = new Set<string>()
  manifest.entries.forEach((entry, index) => {
    const slot = `${entry.type}/${entry.row}`
    const type = typeById.get(entry.type)
    if (!type) {
      issues.error('V4_REF', `题单第 ${index + 1} 项引用了不存在的题型「${describeId(entry.type)}」`, {
        path: `manifest.entries.${index}`,
      })
      return
    }
    const row = tables[entry.type]?.rows.find((r) => r.id === entry.row)
    if (!row) {
      issues.error('V4_REF', `题单第 ${index + 1} 项引用了题型 "${entry.type}" 中不存在的行「${describeId(entry.row)}」`, {
        path: `manifest.entries.${index}`,
      })
      return
    }
    if (entry.args !== undefined && entry.args !== null && !isJsonObject(entry.args)) {
      issues.error('V4_SCHEMA', `题单第 ${index + 1} 项的 args 必须是对象或 null`, { path: `manifest.entries.${index}` })
    }
    if (row.draft === true) {
      issues.warn('V4_MANIFEST_DRAFT', `题单第 ${index + 1} 项引用了草稿行 "${entry.type}/${entry.row}"——显式题单会执行它`, {
        typeId: entry.type,
        rowId: entry.row,
        path: `manifest.entries.${index}`,
      })
    }
    if (seen.has(slot)) {
      issues.warn('V4_MANIFEST_DUP', `题单重复引用同一槽位 "${slot}"（允许，实例态共享）`, {
        typeId: entry.type,
        rowId: entry.row,
        path: `manifest.entries.${index}`,
      })
    }
    seen.add(slot)
  })
}

function validateRun(doc: LevelDocV4, issues: Issues): void {
  const run = doc.content.run
  if (run.count !== null && (!Number.isInteger(run.count) || run.count < 0)) {
    issues.error('V4_SCHEMA', 'run.count 必须是 ≥0 的整数或 null')
  }
  if (typeof run.seed === 'number' && !Number.isFinite(run.seed)) {
    issues.error('V4_SCHEMA', 'run.seed 数字必须是有限值')
  }
}

// ---------------------------------------------------------------------------
// 5) 图结构：FlowProgram / BehaviorProgram
// ---------------------------------------------------------------------------

const FLOW_KINDS = new Set([
  'start',
  'assign',
  'call',
  'setView',
  'ask',
  'foreach',
  'branch',
  'loop',
  'wait',
  'waitShell',
  'finish',
  'restart',
  'comment',
])
const BEHAVIOR_KINDS = new Set(['on', 'return', 'assign', 'call', 'emit', 'branch', 'loop', 'wait', 'comment'])

interface GraphCtx {
  flow: boolean
  shellComponents: Set<string>
  views: Set<string>
  surfaceComponents: Set<string>
  typeId?: string
}

function checkRValue(issues: Issues, nodeId: string, value: unknown, ctx: GraphCtx): void {
  const add = (message: string): void => issues.error('V4_NODE', message, { nodeId, typeId: ctx.typeId })
  if (!isJsonObject(value)) {
    add(`节点「${nodeId}」的 value 必须是表达式对象`)
    return
  }
  const expr = value.expr
  if (typeof expr === 'string') {
    if (expr.trim() === '') add(`节点「${nodeId}」的 value.expr 不能为空`)
    return
  }
  const query = value.query
  if (isJsonObject(query)) {
    if (!nonEmptyStr(query.target)) add(`节点「${nodeId}」的 value.query.target 不能为空`)
    if (!nonEmptyStr(query.method)) add(`节点「${nodeId}」的 value.query.method 不能为空`)
    if (query.arg !== undefined && typeof query.arg !== 'string') {
      add(`节点「${nodeId}」的 value.query.arg 必须是表达式字符串`)
    }
    const target = nonEmptyStr(query.target)
    if (target) {
      const known = ctx.flow ? ctx.shellComponents : ctx.surfaceComponents
      if (!known.has(target)) {
        add(`节点「${nodeId}」的查询目标组件 "${target}" 不存在于${ctx.flow ? ' shell' : '本题 surface'}`)
      }
    }
    return
  }
  add(`节点「${nodeId}」的 value 必须是 { expr } 或 { query }`)
}

function checkNodeFields(node: Record<string, unknown>, ctx: GraphCtx, issues: Issues): void {
  const nodeId = describeId(node.id)
  const kind = typeof node.kind === 'string' ? node.kind : ''
  const add = (message: string): void => issues.error('V4_NODE', message, { nodeId, typeId: ctx.typeId })
  const requireStr = (key: string, label = key): void => {
    if (!nonEmptyStr(node[key])) add(`节点「${nodeId}」（${kind}）缺少必填字符串字段 ${label}`)
  }
  const requireId = (key: string, label = key): void => {
    const value = node[key]
    if (!isV4LocalId(value)) add(`节点「${nodeId}」（${kind}）的 ${label} 必须是合法本地 id`)
  }
  switch (kind) {
    case 'start':
    case 'restart':
      return
    case 'comment':
      if (typeof node.text !== 'string') add(`节点「${nodeId}」（comment）缺少 text 字符串`)
      return
    case 'assign':
      requireStr('target')
      checkRValue(issues, nodeId, node.value, ctx)
      return
    case 'call': {
      requireStr('target')
      requireStr('method')
      if (node.arg !== undefined && typeof node.arg !== 'string') add(`节点「${nodeId}」（call）的 arg 必须是表达式字符串`)
      const target = nonEmptyStr(node.target)
      if (target) {
        const known = ctx.flow ? ctx.shellComponents : ctx.surfaceComponents
        if (!known.has(target)) {
          add(`节点「${nodeId}」（call）的目标组件 "${target}" 不存在于${ctx.flow ? ' shell' : '本题 surface'}`)
        }
      }
      return
    }
    case 'setView': {
      requireStr('view')
      const view = str(node.view)
      if (view && !ctx.views.has(view)) add(`节点「${nodeId}」（setView）指向不存在的视图 "${view}"`)
      return
    }
    case 'ask':
      requireStr('target')
      requireId('resultVar')
      if (node.args !== undefined && typeof node.args !== 'string') add(`节点「${nodeId}」（ask）的 args 必须是表达式字符串`)
      return
    case 'foreach':
      requireStr('items')
      requireId('itemVar')
      if (node.indexVar !== undefined) requireId('indexVar')
      return
    case 'branch':
      requireStr('cond')
      return
    case 'loop': {
      const mode = node.mode
      if (mode !== 'while' && mode !== 'repeat') {
        add(`节点「${nodeId}」（loop）的 mode 必须是 while/repeat`)
        return
      }
      if (mode === 'while') requireStr('cond')
      else requireStr('times')
      return
    }
    case 'wait':
      requireStr('ms')
      return
    case 'waitShell': {
      requireStr('event')
      const event = str(node.event)
      if (!event) return
      const m = COMPONENT_EVENT_RE.exec(event)
      if (!m) {
        add(`节点「${nodeId}」（waitShell）的 event 必须是 "<shell组件>.<事件>" 形式`)
      } else if (!ctx.shellComponents.has(m[1])) {
        add(`节点「${nodeId}」（waitShell）引用了不存在的 shell 组件 "${m[1]}"`)
      }
      return
    }
    case 'finish':
      if (node.passed !== undefined && typeof node.passed !== 'string') add(`节点「${nodeId}」（finish）的 passed 必须是表达式字符串`)
      return
    case 'on': {
      const event = nonEmptyStr(node.event)
      if (!event) {
        add(`节点「${nodeId}」（on）缺少 event`)
        return
      }
      if (event === 'start') return
      if (INTERNAL_EVENT_RE.test(event)) return
      const m = COMPONENT_EVENT_RE.exec(event)
      if (!m) {
        add(`节点「${nodeId}」（on）的 event 必须是 start / internal.<名> / "<surface组件>.<事件>"`)
        return
      }
      if (!ctx.surfaceComponents.has(m[1])) add(`节点「${nodeId}」（on）引用了不存在的 surface 组件 "${m[1]}"`)
      return
    }
    case 'return':
      requireStr('result')
      return
    case 'emit': {
      requireStr('event')
      const event = str(node.event)
      if (event && !INTERNAL_EVENT_RE.test(event)) {
        add(`节点「${nodeId}」（emit）的 event 必须以 "internal." 开头（内部事件）`)
      }
      if (node.payload !== undefined) {
        if (!isJsonObject(node.payload)) add(`节点「${nodeId}」（emit）的 payload 必须是对象`)
        else {
          for (const [key, value] of Object.entries(node.payload)) {
            if (typeof value !== 'string') add(`节点「${nodeId}」（emit）的 payload.${key} 必须是表达式字符串`)
          }
        }
      }
      return
    }
    default:
      add(`节点「${nodeId}」的 kind "${kind}" 不是合法节点类型`)
  }
}

function validateGraph(program: FlowProgram | BehaviorProgram, ctx: GraphCtx, issues: Issues): void {
  const nodes = program.nodes as unknown as Record<string, unknown>[]
  const edges = program.edges
  const kindSet = ctx.flow ? FLOW_KINDS : BEHAVIOR_KINDS
  const byId = new Map<string, Record<string, unknown>>()
  for (const rawNode of nodes) {
    const node = rawNode
    const nodeId = str(node.id) ?? ''
    if (!isV4LocalId(nodeId)) {
      issues.error('V4_RESERVED', `节点 id「${describeId(node.id)}」形态非法`, { nodeId: nodeId || undefined, typeId: ctx.typeId })
    }
    const kind = str(node.kind) ?? ''
    if (!kindSet.has(kind)) {
      issues.error('V4_NODE', `节点「${nodeId || '（空）'}」的 kind「${kind || '（空）'}」不是合法节点类型`, {
        nodeId: nodeId || undefined,
        typeId: ctx.typeId,
      })
      continue
    }
    checkNodeFields(node, ctx, issues)
    byId.set(nodeId, node)
  }
  checkUniqueIds(
    issues,
    nodes.map((n, i) => ({ id: str(n.id) ?? `（空 ${i}）`, what: '节点' })),
  )
  // 边
  const edgeIds = new Set<string>()
  const portCount = new Map<string, number>()
  for (const edge of edges) {
    if (edgeIds.has(edge.id)) {
      issues.error('V4_DUPLICATE_ID', `连线 id「${edge.id}」重复`, { typeId: ctx.typeId })
    }
    edgeIds.add(edge.id)
    const from = byId.get(edge.from)
    const to = byId.get(edge.to)
    if (!from) {
      issues.error('V4_EDGE', `连线「${edge.id}」的起点 "${edge.from}" 不存在`, { typeId: ctx.typeId })
      continue
    }
    if (!to) {
      issues.error('V4_EDGE', `连线「${edge.id}」的终点 "${edge.to}" 不存在`, { typeId: ctx.typeId })
      continue
    }
    if (edge.from === edge.to) {
      issues.error('V4_EDGE', `连线「${edge.id}」不能自环（from == to）`, { typeId: ctx.typeId })
      continue
    }
    const fromKind = str(from.kind) ?? ''
    const fromIsComment = fromKind === 'comment'
    const toIsComment = str(to.kind) === 'comment'
    if (fromIsComment || toIsComment) {
      issues.error('V4_EDGE', `连线「${edge.id}」不能连接 comment 节点（注释不参与执行）`, { typeId: ctx.typeId })
      continue
    }
    const dual = DUAL_PORT_NODES.has(fromKind)
    if (dual && edge.port === undefined) {
      issues.error('V4_EDGE', `连线「${edge.id}」从 ${fromKind} 节点出发必须指定 port（true/false）`, { typeId: ctx.typeId })
      continue
    }
    if (!dual && edge.port !== undefined) {
      issues.error('V4_EDGE', `连线「${edge.id}」的起点 ${fromKind} 是单出口节点，不能指定 port`, { typeId: ctx.typeId })
      continue
    }
    if (dual) {
      const key = `${edge.from}:${edge.port}`
      const count = (portCount.get(key) ?? 0) + 1
      portCount.set(key, count)
      if (count > 1) {
        issues.error('V4_EDGE', `节点「${edge.from}」的 ${edge.port} 端口有多条出边（每端口最多一条）`, { typeId: ctx.typeId })
      }
    }
  }
  // 入口/终结点约束
  const incoming = new Map<string, number>()
  const outgoing = new Map<string, number>()
  for (const edge of edges) {
    incoming.set(edge.to, (incoming.get(edge.to) ?? 0) + 1)
    outgoing.set(edge.from, (outgoing.get(edge.from) ?? 0) + 1)
  }
  if (ctx.flow) {
    const starts = nodes.filter((n) => str(n.kind) === 'start')
    if (starts.length !== 1) {
      issues.error('V4_START_COUNT', `流程主图必须且只能有一个 start 节点（当前 ${starts.length} 个）`)
    }
    for (const start of starts) {
      const id = str(start.id) ?? ''
      if ((incoming.get(id) ?? 0) > 0) issues.error('V4_EDGE', `start 节点「${id}」不能有入边`, { nodeId: id })
    }
  } else {
    const starts = nodes.filter((n) => str(n.kind) === 'on' && str(n.event) === 'start')
    if (starts.length !== 1) {
      issues.error('V4_START_COUNT', `题型 "${ctx.typeId ?? '?'}" 的行为图必须且只能有一个 on start（当前 ${starts.length} 个）`, {
        typeId: ctx.typeId,
      })
    }
  }
  for (const node of nodes) {
    const id = str(node.id) ?? ''
    const kind = str(node.kind) ?? ''
    if (!kind) continue
    if ((kind === 'on' || kind === 'start') && (incoming.get(id) ?? 0) > 0) {
      issues.error('V4_EDGE', `入口节点「${id}」（${kind}）不能有入边`, { nodeId: id, typeId: ctx.typeId })
    }
    if (GRAPHLESS_TERMINALS.has(kind) && (outgoing.get(id) ?? 0) > 0) {
      issues.error('V4_EDGE', `节点「${id}」（${kind}）是终止节点，不能有出边`, { nodeId: id, typeId: ctx.typeId })
    }
  }
  // 声明变量（flow.vars / behavior.locals）
  const declared = ctx.flow ? (program as FlowProgram).vars : (program as BehaviorProgram).locals
  checkUniqueIds(
    issues,
    (declared ?? []).map((f) => ({ id: f.key, what: ctx.flow ? 'run 变量' : 'behavior 局部变量' })),
  )
  for (const field of declared ?? []) {
    if (!isV4LocalId(field.key)) {
      issues.error('V4_RESERVED', `${ctx.flow ? 'run 变量' : 'behavior 局部变量'} key「${describeId(field.key)}」形态非法`, {
        typeId: ctx.typeId,
      })
    }
    if (!initTypeMatches(field.init, field.type)) {
      issues.error('V4_SCHEMA', `${ctx.flow ? 'run 变量' : 'behavior 局部变量'} "${field.key}" 初值类型与声明 ${field.type} 不符`, {
        typeId: ctx.typeId,
      })
    }
  }
}

// ---------------------------------------------------------------------------
// 入口
// ---------------------------------------------------------------------------

/**
 * 校验已归一化的 v4 文档。供装载管线（loadLevelDocV4）与编辑器使用；
 * 直接对未过 schema 的原始 JSON 调用时只保证不崩、不保证覆盖所有类型错误。
 */
export function validateLevelDocV4(doc: LevelDocV4): V4Validation {
  const issues = new Issues()
  validateIdentity(doc, issues)
  validateShell(doc, issues)
  validateTypesAndTables(doc, issues)
  validateManifest(doc, issues)
  validateRun(doc, issues)

  const shellComponents = new Set(doc.content.shell.components.map((c) => c.id))
  const views = new Set(doc.content.shell.views.map((v) => v.id))
  validateGraph(doc.content.flow, { flow: true, shellComponents, views, surfaceComponents: new Set() }, issues)
  for (const type of doc.content.types) {
    validateGraph(
      type.behavior,
      {
        flow: false,
        shellComponents,
        views,
        surfaceComponents: new Set(type.surface.components.map((c) => c.id)),
        typeId: type.id,
      },
      issues,
    )
  }
  return issues.finish()
}
