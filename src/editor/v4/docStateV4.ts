/**
 * v4 编辑器文档状态操作（docs/53 §13.2）：单一更新入口的纯函数族。
 *
 * 纪律（与 v3 `src/editor/docState.ts` 同源，docs/40 §12.1 / docs/44 R18）：
 * - 恒返回新对象、**全仓禁原地 mutation**——历史栈按引用存档，旧 doc 树永不被改写；
 * - 结构共享：只复制 doc → content → 变更分支，未变更分支保持引用
 *   （所以 `updateTableCell` 之后 `next.content.flow` 必须 `===` 原引用）；
 * - 行/组件/题型 id 一律程序化生成（`newLocalId` / `newUniqueLocalId`），不得手抄；
 * - 目标不存在时返回入参引用（编辑器 `update` 有 no-op 短路，不会污染撤销栈）。
 *
 * 写作用域：本文件只被 v4 编辑器与 v6 图工作台（Slot API）使用；
 * v3 的 `docState.ts` 保持不动，W9 翻转后按 docs/52 §3.3 清理。
 */
import type { Json } from '../../engine/expr'
import type { ColumnType } from '../../engine/level'
import {
  LOGIC_VERSION_V4,
  RESERVED_LOCAL_IDS,
  ROW_RESERVED_KEYS,
  SCHEMA_LIMITS_V4,
  SCHEMA_VERSION_V4,
  isV4LocalId,
  newUniqueLocalId,
  type BehaviorProgram,
  type ComponentInstanceV4,
  type ExplicitManifest,
  type FlowProgram,
  type LevelContentV4,
  type LevelDocV4,
  type LevelShell,
  type ParamFieldDef,
  type QuestionRow,
  type QuestionTable,
  type QuestionTypeDef,
  type RunConfig,
  type StateFieldDef,
  type ViewDefV4,
} from '../../engine/v4/model'
import { newResourceId } from '../../library/id'

// ---------------------------------------------------------------------------
// 撤销 tag 常量（docs/53 §13.2；同一 tag 的连续 update 在撤销栈中合并为一条）
// ---------------------------------------------------------------------------
export const V4_TAGS = {
  /** 标题逐键输入 */
  title: 'title',
  /** 单元格逐键输入（文本框/数字框） */
  cell: 'cell',
  /** 行元数据（draft/phase/order） */
  rowMeta: 'row-meta',
  /** 列定义（重命名/显示名/类型） */
  column: 'column',
  /** 题型元信息 / 状态参数 schema */
  type: 'type',
  /** 舞台组件（布局/属性/绑定） */
  component: 'component',
  /** 题单 / run 配置 */
  manifest: 'manifest',
  /** JSON Tab 应用（整层替换视为一次操作） */
  json: 'json',
} as const

export type V4Tag = (typeof V4_TAGS)[keyof typeof V4_TAGS]

// ---------------------------------------------------------------------------
// 内部工具：结构共享的复制助手
// ---------------------------------------------------------------------------

function withContent(doc: LevelDocV4, patch: Partial<LevelContentV4>): LevelDocV4 {
  return { ...doc, content: { ...doc.content, ...patch } }
}

function withTable(doc: LevelDocV4, typeId: string, table: QuestionTable): LevelDocV4 {
  return withContent(doc, { tables: { ...doc.content.tables, [typeId]: table } })
}

function withTypes(doc: LevelDocV4, types: QuestionTypeDef[]): LevelDocV4 {
  return withContent(doc, { types })
}

function withShell(doc: LevelDocV4, shell: LevelShell): LevelDocV4 {
  return withContent(doc, { shell })
}

function withTypeAt(doc: LevelDocV4, typeId: string, patch: (type: QuestionTypeDef) => QuestionTypeDef): LevelDocV4 {
  const index = doc.content.types.findIndex((t) => t.id === typeId)
  if (index < 0) return doc
  const current = doc.content.types[index]
  const next = patch(current)
  if (next === current) return doc
  const types = doc.content.types.slice()
  types[index] = next
  return withTypes(doc, types)
}

/** 省略 content.manifest（不用解构 omit，避免 noUnusedLocals 干扰与类型断言） */
function contentWithoutManifest(content: LevelContentV4): LevelContentV4 {
  return {
    shell: content.shell,
    types: content.types,
    tables: content.tables,
    run: content.run,
    flow: content.flow,
  }
}

/** 对对象做 patch：undefined 值 = 删除该键；其余覆盖（禁止原地改） */
function applyPatch<T extends object>(base: T, patch: Record<string, unknown>): T {
  const next: Record<string, unknown> = { ...(base as Record<string, unknown>) }
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) delete next[key]
    else next[key] = value
  }
  return next as T
}

const RESERVED_ID_SET = new Set<string>(RESERVED_LOCAL_IDS)
const RESERVED_ROW_KEY_SET = new Set<string>(ROW_RESERVED_KEYS)

function assertTable(doc: LevelDocV4, typeId: string): QuestionTable {
  const table = doc.content.tables[typeId]
  if (!table) throw new Error(`题型 "${typeId}" 没有实例表`)
  return table
}

function assertRowIndex(rows: QuestionRow[], rowId: string): number {
  const index = rows.findIndex((r) => r.id === rowId)
  if (index < 0) throw new Error(`行 "${rowId}" 不存在`)
  return index
}

function rowIdOf(rows: QuestionRow[]): string {
  return newUniqueLocalId('row', rows.map((r) => r.id))
}

/** 行 id 在题型内唯一（v4 只要求题型内唯一；docs/53 §2） */
export function isRowIdTaken(doc: LevelDocV4, typeId: string, rowId: string): boolean {
  return (doc.content.tables[typeId]?.rows ?? []).some((row) => row.id === rowId)
}

// ---------------------------------------------------------------------------
// 默认文档 / 模板 / 副本 / 版本
// ---------------------------------------------------------------------------

/** 默认行为图：on start → return（最小可调用题型；W6 行为编辑器在其上扩展） */
export function defaultBehavior(): BehaviorProgram {
  return {
    logicVersion: LOGIC_VERSION_V4,
    kind: 'behavior',
    nodes: [
      { id: 'b_start', kind: 'on', event: 'start' },
      { id: 'b_return', kind: 'return', result: "{ status: 'answered' }" },
    ],
    edges: [{ id: 'be_1', from: 'b_start', to: 'b_return' }],
  }
}

/** 默认主流程：start → finish（最小可装载/可运行关卡） */
export function defaultFlow(): FlowProgram {
  return {
    logicVersion: LOGIC_VERSION_V4,
    kind: 'flow',
    nodes: [
      { id: 'f_start', kind: 'start' },
      { id: 'f_finish', kind: 'finish' },
    ],
    edges: [{ id: 'fe_1', from: 'f_start', to: 'f_finish' }],
  }
}

/** 空白 v4 关卡（`#/edit/new`）：结构完整、可通过 loadLevelDocV4 */
export function blankLevelDocV4(overrides: { title?: string; id?: string } = {}): LevelDocV4 {
  return {
    schemaVersion: SCHEMA_VERSION_V4,
    kind: 'level',
    id: overrides.id ?? newResourceId(),
    version: '0.1.0',
    meta: {
      title: overrides.title ?? '未命名关卡',
      description: '',
      author: { name: '' },
      tags: [],
      locale: 'zh-CN',
      license: 'CC0-1.0',
      difficulty: 1,
    },
    refs: [],
    content: {
      shell: { views: [{ id: 'main', name: '主视图' }], components: [] },
      types: [],
      tables: {},
      run: { order: 'manifest', count: null, seed: null, shuffleWithinPhase: true },
      flow: defaultFlow(),
    },
  }
}

const COPY_TITLE_SUFFIX = '（副本）'

/** 内置示例另存副本：新 id、版本归零、标题加后缀（已含后缀不重复） */
export function copyForEditingV4(doc: LevelDocV4): LevelDocV4 {
  const title = String(doc.meta.title ?? '')
  return {
    ...doc,
    id: newResourceId(),
    version: '0.1.0',
    meta: { ...doc.meta, title: title.includes(COPY_TITLE_SUFFIX) ? title : `${title}${COPY_TITLE_SUFFIX}` },
  }
}

/** 保存升版（semver 修订号 +1；非法版本保留原值不阻断保存） */
export function bumpVersionV4(doc: LevelDocV4): LevelDocV4 {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(String(doc.version ?? ''))
  if (!m) return doc
  return { ...doc, version: `${m[1]}.${m[2]}.${Number(m[3]) + 1}` }
}

// ---------------------------------------------------------------------------
// meta
// ---------------------------------------------------------------------------

/** 浅合并 meta（undefined 值 = 删除该键；title 恒保留字符串） */
export function withMeta(doc: LevelDocV4, patch: Partial<LevelDocV4['meta']>): LevelDocV4 {
  const meta = applyPatch(doc.meta, patch as Record<string, unknown>)
  return { ...doc, meta: { ...meta, title: String(meta.title ?? '') } }
}

// ---------------------------------------------------------------------------
// 题型（QuestionTypeDef）
// ---------------------------------------------------------------------------

export interface AddTypeSeed extends Partial<QuestionTypeDef> {
  /** 新题型附带实例表（列/行）；缺省空表 */
  table?: Partial<QuestionTable>
}

/** 新增题型：同步建空实例表（types↔tables 一一对应不变量）；id 程序化生成或沿用合法且不重复的 seed.id */
export function addType(doc: LevelDocV4, seed: AddTypeSeed = {}): { doc: LevelDocV4; id: string } {
  if (doc.content.types.length >= SCHEMA_LIMITS_V4.types) {
    throw new Error(`题型数已达上限 ${SCHEMA_LIMITS_V4.types}（schema 约束）`)
  }
  const used = new Set(doc.content.types.map((t) => t.id))
  const seedId = seed.id
  const id =
    seedId !== undefined && isV4LocalId(seedId) && !used.has(seedId) && !RESERVED_ID_SET.has(seedId)
      ? seedId
      : newUniqueLocalId('type', used)
  const type: QuestionTypeDef = {
    id,
    name: seed.name !== undefined && seed.name.trim() !== '' ? seed.name : '新题型',
    surface: {
      components: (seed.surface?.components ?? []).map((c) => ({ ...c })),
    },
    behavior: seed.behavior ?? defaultBehavior(),
  }
  if (seed.description !== undefined) type.description = seed.description
  if (seed.state !== undefined) type.state = seed.state
  if (seed.typeState !== undefined) type.typeState = seed.typeState
  if (seed.args !== undefined) type.args = seed.args
  const table: QuestionTable = {
    columns: (seed.table?.columns ?? []).map((c) => ({ ...c })),
    rows: (seed.table?.rows ?? []).map((r) => ({ ...r })),
  }
  return {
    doc: withContent(doc, {
      types: [...doc.content.types, type],
      tables: { ...doc.content.tables, [id]: table },
    }),
    id,
  }
}

/** 删除题型：级联删实例表与显式题单中引用它的条目（保持文档可装载） */
export function removeType(doc: LevelDocV4, typeId: string): LevelDocV4 {
  if (!doc.content.types.some((t) => t.id === typeId)) return doc
  const types = doc.content.types.filter((t) => t.id !== typeId)
  const tables = { ...doc.content.tables }
  delete tables[typeId]
  const patch: Partial<LevelContentV4> = { types, tables }
  const manifest = doc.content.manifest
  if (manifest) {
    patch.manifest = { entries: manifest.entries.filter((e) => e.type !== typeId) }
  }
  return withContent(doc, patch)
}

/** 更新题型元信息（id 不可改；显式 undefined 值 = 删除可选字段） */
export function updateType(doc: LevelDocV4, typeId: string, patch: Partial<QuestionTypeDef>): LevelDocV4 {
  return withTypeAt(doc, typeId, (type) => {
    const next = { ...type } as unknown as Record<string, unknown>
    let changed = false
    for (const key of Object.keys(patch)) {
      if (key === 'id') continue
      const value = (patch as Record<string, unknown>)[key]
      if (value === undefined) {
        if (key in next) {
          delete next[key]
          changed = true
        }
      } else if (next[key] !== value) {
        next[key] = value
        changed = true
      }
    }
    return changed ? (next as unknown as QuestionTypeDef) : type
  })
}

/**
 * 设置题型状态 schema：
 * - `state` → `type.state`（q.state.* 初始值，每 (type,row) 一份）
 * - `typeState` → `type.typeState`（t.* 初始值，每题型一份）
 * - `locals` → `type.behavior.locals`（每次调用局部变量初值）
 */
export function setTypeState(
  doc: LevelDocV4,
  typeId: string,
  fields: StateFieldDef[],
  kind: 'state' | 'typeState' | 'locals' = 'state',
): LevelDocV4 {
  return withTypeAt(doc, typeId, (type) => {
    const next: QuestionTypeDef = { ...type }
    if (kind === 'locals') {
      next.behavior = { ...type.behavior, locals: fields }
    } else if (kind === 'state') {
      next.state = fields
    } else {
      next.typeState = fields
    }
    return next
  })
}

/** 设置 ask 调用参数 schema（args） */
export function setTypeArgs(doc: LevelDocV4, typeId: string, args: ParamFieldDef[]): LevelDocV4 {
  return withTypeAt(doc, typeId, (type) => ({ ...type, args }))
}

/** 以纯函数方式替换行为图（返回同一引用 = no-op） */
export function updateBehavior(
  doc: LevelDocV4,
  typeId: string,
  fn: (program: BehaviorProgram) => BehaviorProgram,
): LevelDocV4 {
  return withTypeAt(doc, typeId, (type) => {
    const next = fn(type.behavior)
    return next === type.behavior ? type : { ...type, behavior: next }
  })
}

// ---------------------------------------------------------------------------
// 列（ColumnDefV4）
// ---------------------------------------------------------------------------

export interface AddColumnInput {
  key: string
  label?: string
  type?: ColumnType
}

/** 新增列：key 必须合法本地 id 且不与现有列/保留字段重名；所有行补 null 单元格 */
export function addColumn(doc: LevelDocV4, typeId: string, input: AddColumnInput | string): LevelDocV4 {
  const normalized: AddColumnInput = typeof input === 'string' ? { key: input } : input
  const key = normalized.key.trim()
  if (!isV4LocalId(key)) throw new Error(`非法列名「${key}」：需字母/下划线开头，仅含字母数字下划线短横`)
  if (RESERVED_ROW_KEY_SET.has(key)) throw new Error(`列名「${key}」是行保留字段，不能作为内容列`)
  if (key.length > 32) throw new Error(`列名「${key}」超过 32 字符（schema 约束）`)
  const table = assertTable(doc, typeId)
  if (table.columns.some((c) => c.key === key)) throw new Error(`列名「${key}」已存在`)
  if (table.columns.length >= SCHEMA_LIMITS_V4.columnsPerType) {
    throw new Error(`列数已达上限 ${SCHEMA_LIMITS_V4.columnsPerType}（schema 约束）`)
  }
  const column = { key } as { key: string; label?: string; type?: ColumnType }
  if (normalized.label !== undefined) column.label = normalized.label
  column.type = normalized.type ?? 'text'
  const rows = table.rows.map((row) => ({ ...row, [key]: null }))
  return withTable(doc, typeId, { columns: [...table.columns, column], rows })
}

/** 删除列：同步删除各行该单元格 */
export function removeColumn(doc: LevelDocV4, typeId: string, key: string): LevelDocV4 {
  const table = doc.content.tables[typeId]
  if (!table || !table.columns.some((c) => c.key === key)) return doc
  const columns = table.columns.filter((c) => c.key !== key)
  const rows = table.rows.map((row) => {
    const next: Record<string, Json | undefined> = {}
    for (const [k, v] of Object.entries(row)) {
      if (k !== key) next[k] = v as Json | undefined
    }
    return next as QuestionRow
  })
  return withTable(doc, typeId, { columns, rows })
}

/** 重命名列（表达式 q.<key> 的旧引用由 lint 提示） */
export function renameColumn(doc: LevelDocV4, typeId: string, oldKey: string, newKeyInput: string): LevelDocV4 {
  const newKey = newKeyInput.trim()
  const table = doc.content.tables[typeId]
  if (!table) return doc
  const column = table.columns.find((c) => c.key === oldKey)
  if (!column) return doc
  if (newKey === oldKey) return doc
  if (!isV4LocalId(newKey)) throw new Error(`非法列名「${newKey}」`)
  if (RESERVED_ROW_KEY_SET.has(newKey)) throw new Error(`列名「${newKey}」是行保留字段，不能作为内容列`)
  if (newKey.length > 32) throw new Error(`列名「${newKey}」超过 32 字符（schema 约束）`)
  if (table.columns.some((c) => c.key === newKey)) throw new Error(`列名「${newKey}」已存在`)
  const columns = table.columns.map((c) => (c.key === oldKey ? { ...c, key: newKey } : c))
  const rows = table.rows.map((row) => {
    if (!(oldKey in row)) return row
    const next: Record<string, Json | undefined> = {}
    for (const [k, v] of Object.entries(row)) {
      if (k === oldKey) next[newKey] = v as Json | undefined
      else next[k] = v as Json | undefined
    }
    return next as QuestionRow
  })
  return withTable(doc, typeId, { columns, rows })
}

/** 更新列定义（key 不可改；label/type 只能通过本函数改） */
export function updateColumn(
  doc: LevelDocV4,
  typeId: string,
  key: string,
  patch: Partial<Omit<{ key: string; label?: string; type?: ColumnType }, 'key'>>,
): LevelDocV4 {
  const table = doc.content.tables[typeId]
  if (!table) return doc
  const index = table.columns.findIndex((c) => c.key === key)
  if (index < 0) return doc
  const current = table.columns[index]
  const next: { key: string; label?: string; type?: ColumnType } = { ...current }
  if (patch.label !== undefined) next.label = patch.label
  if (patch.type !== undefined) next.type = patch.type
  if (next.label === current.label && next.type === current.type) return doc
  const columns = table.columns.slice()
  columns[index] = next
  return withTable(doc, typeId, { columns, rows: table.rows })
}

// ---------------------------------------------------------------------------
// 行（QuestionRow）
// ---------------------------------------------------------------------------

/** 新增行：id 程序化生成并返回；afterRowId 指定插入位置（缺省追加到末尾） */
export function addRow(doc: LevelDocV4, typeId: string, afterRowId?: string): { doc: LevelDocV4; rowId: string } {
  const table = assertTable(doc, typeId)
  if (table.rows.length >= SCHEMA_LIMITS_V4.rowsPerType) {
    throw new Error(`该题型行数已达上限 ${SCHEMA_LIMITS_V4.rowsPerType}（schema 约束）`)
  }
  let total = 0
  for (const t of Object.values(doc.content.tables)) total += t.rows.length
  if (total >= SCHEMA_LIMITS_V4.rowsTotal) {
    throw new Error(`全关行数已达上限 ${SCHEMA_LIMITS_V4.rowsTotal}（schema 约束）`)
  }
  const rowId = rowIdOf(table.rows)
  const row = { id: rowId } as QuestionRow
  for (const column of table.columns) row[column.key] = null
  const rows = table.rows.slice()
  const at = afterRowId === undefined ? rows.length : assertRowIndex(rows, afterRowId) + 1
  rows.splice(at, 0, row)
  return { doc: withTable(doc, typeId, { columns: table.columns, rows }), rowId }
}

/** 删除行：级联删除显式题单中引用它的条目 */
export function removeRow(doc: LevelDocV4, typeId: string, rowId: string): LevelDocV4 {
  const table = doc.content.tables[typeId]
  if (!table || !table.rows.some((r) => r.id === rowId)) return doc
  const patch: Partial<LevelContentV4> = {
    tables: {
      ...doc.content.tables,
      [typeId]: { columns: table.columns, rows: table.rows.filter((r) => r.id !== rowId) },
    },
  }
  const manifest = doc.content.manifest
  if (manifest) {
    patch.manifest = { entries: manifest.entries.filter((e) => !(e.type === typeId && e.row === rowId)) }
  }
  return withContent(doc, patch)
}

/** 行重排：rowId 移动到 toIndex（越界 clamp 到合法区间） */
export function moveRow(doc: LevelDocV4, typeId: string, rowId: string, toIndex: number): LevelDocV4 {
  const table = doc.content.tables[typeId]
  if (!table) return doc
  const from = table.rows.findIndex((r) => r.id === rowId)
  if (from < 0) return doc
  const to = Math.max(0, Math.min(table.rows.length - 1, Math.trunc(toIndex)))
  if (to === from) return doc
  const rows = table.rows.slice()
  const [moved] = rows.splice(from, 1)
  rows.splice(to, 0, moved)
  return withTable(doc, typeId, { columns: table.columns, rows })
}

export interface RowMetaPatch {
  draft?: boolean | null
  phase?: number | null
  order?: number | null
}

/** 行元数据（draft/phase/order）：null/undefined = 删除该键（回缺省语义） */
export function updateRowMeta(doc: LevelDocV4, typeId: string, rowId: string, patch: RowMetaPatch): LevelDocV4 {
  const table = doc.content.tables[typeId]
  if (!table) return doc
  const index = table.rows.findIndex((r) => r.id === rowId)
  if (index < 0) return doc
  const row = table.rows[index]
  let changed = false
  const next: QuestionRow = { ...row }
  for (const [key, value] of Object.entries(patch)) {
    if (key !== 'draft' && key !== 'phase' && key !== 'order') continue
    if (value === null || value === undefined) {
      if (key in next) {
        delete next[key]
        changed = true
      }
    } else if (key === 'draft') {
      if (next.draft !== value) {
        next.draft = value === true
        changed = true
      }
    } else {
      const numeric = Math.trunc(Number(value))
      if (!Number.isFinite(numeric)) continue
      if (key === 'phase') {
        if (next.phase !== numeric) {
          next.phase = Math.max(1, numeric)
          changed = true
        }
      } else if (next.order !== numeric) {
        next.order = numeric
        changed = true
      }
    }
  }
  if (!changed) return doc
  const rows = table.rows.slice()
  rows[index] = next
  return withTable(doc, typeId, { columns: table.columns, rows })
}

/** 单元格更新（列必须已声明；目标不存在返回入参引用） */
export function updateTableCell(
  doc: LevelDocV4,
  typeId: string,
  rowId: string,
  columnKey: string,
  value: Json,
): LevelDocV4 {
  const table = doc.content.tables[typeId]
  if (!table) return doc
  if (!table.columns.some((c) => c.key === columnKey)) return doc
  const index = table.rows.findIndex((r) => r.id === rowId)
  if (index < 0) return doc
  const row = table.rows[index]
  if (row[columnKey] === value) return doc
  const rows = table.rows.slice()
  rows[index] = { ...row, [columnKey]: value }
  return withTable(doc, typeId, { columns: table.columns, rows })
}

// ---------------------------------------------------------------------------
// 舞台：视图 / 组件（shell 与题型 surface 两层）
// ---------------------------------------------------------------------------

/** 组件层：shell（跨题常驻）或某题型的 surface（调用期局部） */
export type ComponentLayer = { kind: 'shell' } | { kind: 'surface'; typeId: string }

export const SHELL_LAYER: ComponentLayer = { kind: 'shell' }

function layerComponents(doc: LevelDocV4, layer: ComponentLayer): ComponentInstanceV4[] {
  if (layer.kind === 'shell') return doc.content.shell.components
  const type = doc.content.types.find((t) => t.id === layer.typeId)
  if (!type) throw new Error(`题型 "${layer.typeId}" 不存在`)
  return type.surface.components
}

function withLayerComponents(
  doc: LevelDocV4,
  layer: ComponentLayer,
  components: ComponentInstanceV4[],
): LevelDocV4 {
  if (layer.kind === 'shell') return withShell(doc, { ...doc.content.shell, components })
  return withTypeAt(doc, layer.typeId, (type) => ({ ...type, surface: { components } }))
}

function componentIdBase(type: string): string {
  const cleaned = type.replace(/[^A-Za-z0-9_]/g, '')
  return /^[A-Za-z_]/.test(cleaned) ? cleaned : `comp_${cleaned}`
}

/** 组件默认布局：按序号纵向排布，避免全部叠在原点 */
export function defaultComponentLayout(index: number): { x: number; y: number; w: number; h: number } {
  return { x: 40 + (index % 3) * 240, y: 40 + Math.floor(index / 3) * 120, w: 200, h: 60 }
}

/** 新增组件：id 在该层内查重生成；返回更新后的 doc 与新组件 id */
export function addComponent(
  doc: LevelDocV4,
  layer: ComponentLayer,
  type: string,
  init: Partial<ComponentInstanceV4> = {},
): { doc: LevelDocV4; id: string } {
  const components = layerComponents(doc, layer)
  const limit =
    layer.kind === 'shell' ? SCHEMA_LIMITS_V4.shellComponents : SCHEMA_LIMITS_V4.surfaceComponentsPerType
  if (components.length >= limit) throw new Error(`组件数已达上限 ${limit}（schema 约束）`)
  const id = newUniqueLocalId(componentIdBase(type), components.map((c) => c.id))
  const component: ComponentInstanceV4 = {
    id,
    type,
    visible: true,
    layout: defaultComponentLayout(components.length),
    ...init,
  }
  if (layer.kind === 'shell') {
    if (component.view === undefined) {
      component.view = doc.content.shell.initialView ?? doc.content.shell.views[0]?.id ?? 'main'
    }
  } else if (component.view !== undefined) {
    // surface 组件禁止 view（docs/53 §3）；忽略调用方误传
    delete component.view
  }
  return { doc: withLayerComponents(doc, layer, [...components, component]), id }
}

/** 更新组件（浅合并；undefined 值 = 删除可选字段） */
export function updateComponent(
  doc: LevelDocV4,
  layer: ComponentLayer,
  componentId: string,
  patch: Partial<ComponentInstanceV4>,
): LevelDocV4 {
  let components: ComponentInstanceV4[]
  try {
    components = layerComponents(doc, layer)
  } catch {
    return doc
  }
  const index = components.findIndex((c) => c.id === componentId)
  if (index < 0) return doc
  // id 不可变：调用方误传 id 时忽略（身份的稳定是题单/流程引用的前提）
  const safePatch: Record<string, unknown> = { ...(patch as Record<string, unknown>) }
  delete safePatch.id
  const next = applyPatch(components[index], safePatch)
  return withLayerComponents(
    doc,
    layer,
    components.map((c, i) => (i === index ? next : c)),
  )
}

/** 删除组件 */
export function removeComponent(doc: LevelDocV4, layer: ComponentLayer, componentId: string): LevelDocV4 {
  let components: ComponentInstanceV4[]
  try {
    components = layerComponents(doc, layer)
  } catch {
    return doc
  }
  if (!components.some((c) => c.id === componentId)) return doc
  return withLayerComponents(
    doc,
    layer,
    components.filter((c) => c.id !== componentId),
  )
}

/** 视图新增：id 自动去重（view2/view3…），返回新视图 id */
export function addView(doc: LevelDocV4, name?: string): { doc: LevelDocV4; id: string } {
  const views = doc.content.shell.views
  if (views.length >= SCHEMA_LIMITS_V4.views) throw new Error(`视图数已达上限 ${SCHEMA_LIMITS_V4.views}`)
  const used = new Set(views.map((v) => v.id))
  let n = views.length + 1
  while (used.has(`view${n}`) || RESERVED_ID_SET.has(`view${n}`)) n += 1
  const id = `view${n}`
  const view: ViewDefV4 = { id, name: name ?? `视图${n}` }
  return { doc: withShell(doc, { ...doc.content.shell, views: [...views, view] }), id }
}

/** 视图更新（name 为空串 = 删除显示名，回落 id） */
export function updateView(doc: LevelDocV4, viewId: string, patch: { name?: string }): LevelDocV4 {
  const views = doc.content.shell.views
  const index = views.findIndex((v) => v.id === viewId)
  if (index < 0) return doc
  const current = views[index]
  const next: ViewDefV4 = { ...current }
  if (patch.name !== undefined) {
    if (patch.name === '') delete next.name
    else next.name = patch.name
  }
  if (next.name === current.name) return doc
  const list = views.slice()
  list[index] = next
  return withShell(doc, { ...doc.content.shell, views: list })
}

/** 视图删除：至少保留一个；级联删除归属该视图的 shell 组件，悬空组件归入首视图 */
export function removeView(doc: LevelDocV4, viewId: string): LevelDocV4 {
  const shell = doc.content.shell
  if (shell.views.length <= 1) return doc
  if (!shell.views.some((v) => v.id === viewId)) return doc
  const views = shell.views.filter((v) => v.id !== viewId)
  const first = views[0].id
  const components = shell.components
    .filter((c) => c.view !== viewId)
    .map((c) => (c.view !== undefined && !views.some((v) => v.id === c.view) ? { ...c, view: first } : c))
  const next: LevelShell = { ...shell, views, components }
  if (next.initialView === viewId) delete next.initialView
  return withShell(doc, next)
}

/** 以纯函数方式替换 shell（返回同一引用 = no-op） */
export function updateShell(doc: LevelDocV4, fn: (shell: LevelShell) => LevelShell): LevelDocV4 {
  const next = fn(doc.content.shell)
  return next === doc.content.shell ? doc : withShell(doc, next)
}

// ---------------------------------------------------------------------------
// 题单 / 运行配置 / 主流程
// ---------------------------------------------------------------------------

/** 设置显式题单；null = 删除（回落自动题单） */
export function setManifest(doc: LevelDocV4, manifest: ExplicitManifest | null): LevelDocV4 {
  if (manifest === null) {
    if (doc.content.manifest === undefined) return doc
    return { ...doc, content: contentWithoutManifest(doc.content) }
  }
  const entries = manifest.entries.map((entry) => {
    const next: ExplicitManifest['entries'][number] = { type: entry.type, row: entry.row }
    if (entry.args !== undefined) next.args = entry.args
    return next
  })
  return withContent(doc, { manifest: { entries } })
}

/** 更新 run 配置（只覆盖显式给出的键；count 归一为 ≥0 整数或 null） */
export function setRunConfig(doc: LevelDocV4, patch: Partial<RunConfig>): LevelDocV4 {
  const current = doc.content.run
  const count =
    patch.count === undefined
      ? current.count
      : patch.count === null || !Number.isFinite(patch.count)
        ? null
        : Math.max(0, Math.trunc(patch.count))
  const seed = patch.seed === undefined ? current.seed : patch.seed
  const next: RunConfig = {
    order: patch.order ?? current.order,
    count,
    seed: typeof seed === 'number' && !Number.isFinite(seed) ? null : seed,
    shuffleWithinPhase: patch.shuffleWithinPhase ?? current.shuffleWithinPhase,
  }
  if (
    next.order === current.order &&
    next.count === current.count &&
    next.seed === current.seed &&
    next.shuffleWithinPhase === current.shuffleWithinPhase
  ) {
    return doc
  }
  return withContent(doc, { run: next })
}

/** 以纯函数方式替换主流程（返回同一引用 = no-op） */
export function updateFlow(doc: LevelDocV4, fn: (program: FlowProgram) => FlowProgram): LevelDocV4 {
  const next = fn(doc.content.flow)
  return next === doc.content.flow ? doc : withContent(doc, { flow: next })
}

// ---------------------------------------------------------------------------
// 撤销栈（EditorPageV4 使用；history.ts 的 remapHistoryForCopy 是 v3 类型签名）
// ---------------------------------------------------------------------------

export interface EditorHistoryV4 {
  past: LevelDocV4[]
  future: LevelDocV4[]
}

/**
 * 内置示例另存副本后的历史身份重映射：id/version 改写为副本身份，标题补「（副本）」后缀。
 * 与 v3 `history.ts` 的 `remapHistoryForCopy` 同语义（v3 版本按 LevelDoc 类型签名，v4 独立实现）。
 */
export function remapHistoryForCopyV4(
  history: EditorHistoryV4,
  saved: Pick<LevelDocV4, 'id' | 'version'>,
): EditorHistoryV4 {
  const remap = (doc: LevelDocV4): LevelDocV4 => {
    const title = String(doc.meta.title ?? '')
    return {
      ...doc,
      id: saved.id,
      version: saved.version,
      meta: { ...doc.meta, title: title.includes(COPY_TITLE_SUFFIX) ? title : `${title}${COPY_TITLE_SUFFIX}` },
    }
  }
  return { past: history.past.map(remap), future: history.future.map(remap) }
}

// ---------------------------------------------------------------------------
// 只读查询小工具（编辑器 UI 共用）
// ---------------------------------------------------------------------------

/** 题型 id → 显示名（题单/预览等只读展示用） */
export function typeName(doc: LevelDocV4, typeId: string): string {
  const type = doc.content.types.find((t) => t.id === typeId)
  return type ? type.name : typeId
}

/** 行 id → 行（题型内） */
export function findRow(doc: LevelDocV4, typeId: string, rowId: string): QuestionRow | undefined {
  return doc.content.tables[typeId]?.rows.find((r) => r.id === rowId)
}
