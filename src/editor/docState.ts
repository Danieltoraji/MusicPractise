/**
 * 编辑器的文档状态操作：不可变更新 + 空白/副本模板（v3：视图 + 数据表）。
 * 编辑态是内存中的 LevelDoc 副本，保存时经 loadLevelDoc 校验后入库。
 */
import type { ComponentInstance, DataTable, LevelDoc, ViewDef } from '../engine/level'
import type { Json } from '../engine/expr'
import { migrateDocToV3 } from '../engine/migrateDoc'
import { newResourceId } from '../library/id'

export function blankLevelDoc(): LevelDoc {
  return {
    schemaVersion: 3,
    kind: 'level',
    id: newResourceId(),
    version: '0.1.0',
    meta: {
      title: '未命名关卡',
      description: '',
      author: { name: '' },
      tags: [],
      locale: 'zh-CN',
      license: 'CC0-1.0',
      difficulty: 1,
    },
    refs: [],
    content: {
      views: [{ id: 'main', name: '主视图' }],
      components: [],
      logic: {
        logicVersion: 2,
        variables: { score: 0 },
        nodes: [
          { id: 'on_correct', kind: 'on', event: 'level:correct' },
          { id: 'add_score', kind: 'assign', target: 'score', value: { expr: 'v.score + 10' } },
        ],
        edges: [{ id: 'e1', from: 'on_correct', to: 'add_score' }],
      },
      table: {
        columns: [
          { key: 'data', label: '数据' },
          { key: 'scoring', label: '分值' },
        ],
        rows: [{ data: {}, scoring: { max: 10 } }],
      },
      flow: { order: 'sequential', pass: { expr: 'v.score >= 10' } },
    },
  }
}

/** 以库内文档为底稿创建编辑副本：新 id、版本归零、标题加后缀（已有后缀不重复）；旧格式文档先迁移出 v3 */
export function copyForEditing(doc: LevelDoc): LevelDoc {
  const migrated = migrateDocToV3(doc)
  const copy = structuredClone(migrated) as LevelDoc
  copy.id = newResourceId()
  copy.version = '0.1.0'
  const title = String(copy.meta.title ?? '')
  copy.meta = { ...copy.meta, title: title.includes('（副本）') ? title : `${title}（副本）` }
  return copy
}

// ---------------------------------------------------------------------------
// 视图管理（v3）
// ---------------------------------------------------------------------------

/** 新增视图：id 自动去重（view2/view3…），返回更新后的文档与新视图 id */
export function addView(doc: LevelDoc, name?: string): { doc: LevelDoc; id: string } {
  const next = structuredClone(doc)
  const used = new Set(next.content.views.map((v) => v.id))
  let n = next.content.views.length + 1
  while (used.has(`view${n}`)) n++
  const id = `view${n}`
  next.content.views.push({ id, name: name ?? `视图${n}` })
  return { doc: next, id }
}

export function updateView(doc: LevelDoc, id: string, patch: Partial<Omit<ViewDef, 'id'>>): LevelDoc {
  const next = structuredClone(doc)
  const view = next.content.views.find((v) => v.id === id)
  if (!view) return next
  if (patch.name !== undefined) view.name = patch.name
  return next
}

export function removeView(doc: LevelDoc, id: string): LevelDoc {
  if (doc.content.views.length <= 1) return doc // 至少保留一个视图
  const next = structuredClone(doc)
  next.content.views = next.content.views.filter((v) => v.id !== id)
  // 级联删除该视图的组件；悬挂引用（视图不存在的组件）归入首视图
  next.content.components = next.content.components.filter((c) => c.view !== id)
  const first = next.content.views[0].id
  for (const c of next.content.components) {
    if (!next.content.views.some((v) => v.id === (c.view ?? ''))) c.view = first
  }
  return next
}

// ---------------------------------------------------------------------------
// 组件（视图归属）
// ---------------------------------------------------------------------------

/** 组件实例默认布局：按顺序纵向排列，避免全部叠在原点 */
export function defaultLayout(index: number): { x: number; y: number; w: number; h: number } {
  return { x: 40 + (index % 3) * 240, y: 40 + Math.floor(index / 3) * 120, w: 200, h: 60 }
}

export function addComponent(doc: LevelDoc, type: string, viewId?: string): LevelDoc {
  const next = structuredClone(doc)
  const view = viewId ?? next.content.views[0].id
  const used = new Set(next.content.components.map((c) => c.id))
  let n = 1
  while (used.has(`${type}${n}`)) n++
  const comp: ComponentInstance = {
    id: `${type}${n}`,
    type,
    visible: true,
    view,
    layout: defaultLayout(next.content.components.length),
  }
  next.content.components.push(comp)
  return next
}

export function updateComponent(doc: LevelDoc, cid: string, patch: Partial<ComponentInstance>): LevelDoc {
  const next = structuredClone(doc)
  const comp = next.content.components.find((c) => c.id === cid)
  if (comp) Object.assign(comp, patch)
  return next
}

export function removeComponent(doc: LevelDoc, cid: string): LevelDoc {
  const next = structuredClone(doc)
  next.content.components = next.content.components.filter((c) => c.id !== cid)
  return next
}

// ---------------------------------------------------------------------------
// 数据表（v3：取代 questions；与变量平权的自定义字段大表格）
// ---------------------------------------------------------------------------

/** 新增列：key 需为合法标识符且不与现有列重名 */
export function addTableColumn(doc: LevelDoc, key: string, label?: string): LevelDoc {
  const next = structuredClone(doc)
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw new Error(`非法列名: ${key}`)
  if (next.content.table.columns.some((c) => c.key === key)) throw new Error(`列名已存在: ${key}`)
  next.content.table.columns.push({ key, label })
  for (const row of next.content.table.rows) row[key] = null
  return next
}

export function renameTableColumn(doc: LevelDoc, oldKey: string, newKey: string): LevelDoc {
  const next = structuredClone(doc)
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(newKey)) throw new Error(`非法列名: ${newKey}`)
  const col = next.content.table.columns.find((c) => c.key === oldKey)
  if (!col) return next
  if (newKey !== oldKey && next.content.table.columns.some((c) => c.key === newKey)) throw new Error(`列名已存在: ${newKey}`)
  col.key = newKey
  for (const row of next.content.table.rows) {
    if (oldKey in row) {
      row[newKey] = row[oldKey]
      delete row[oldKey]
    }
  }
  return next
}

export function removeTableColumn(doc: LevelDoc, key: string): LevelDoc {
  const next = structuredClone(doc)
  next.content.table.columns = next.content.table.columns.filter((c) => c.key !== key)
  for (const row of next.content.table.rows) delete row[key]
  return next
}

export function updateTableColumnLabel(doc: LevelDoc, key: string, label: string): LevelDoc {
  const next = structuredClone(doc)
  const col = next.content.table.columns.find((c) => c.key === key)
  if (col) col.label = label
  return next
}

export function addTableRow(doc: LevelDoc, afterIndex?: number): LevelDoc {
  const next = structuredClone(doc)
  const row: Record<string, Json> = {}
  for (const c of next.content.table.columns) row[c.key] = null
  const at = afterIndex === undefined ? next.content.table.rows.length : afterIndex + 1
  next.content.table.rows.splice(at, 0, row)
  return next
}

export function removeTableRow(doc: LevelDoc, index: number): LevelDoc {
  const next = structuredClone(doc)
  next.content.table.rows.splice(index, 1)
  return next
}

/** 单元格更新（浅合并到该行） */
export function updateTableCell(doc: LevelDoc, index: number, patch: Record<string, Json>): LevelDoc {
  const next = structuredClone(doc)
  const row = next.content.table.rows[index]
  if (row) Object.assign(row, patch)
  return next
}

export function setTable(doc: LevelDoc, table: DataTable): LevelDoc {
  const next = structuredClone(doc)
  next.content.table = table
  return next
}

export function setMeta(doc: LevelDoc, patch: Partial<LevelDoc['meta']>): LevelDoc {
  const next = structuredClone(doc)
  Object.assign(next.meta, patch)
  return next
}

// ---------------------------------------------------------------------------
// 变量管理（变量面板用）
// ---------------------------------------------------------------------------

/** 值解析启发式：true/false → 布尔、可解析数字 → number、[/{ 开头按 JSON、其余字符串 */
export function parseScalarInput(text: string): number | boolean | string | Json {
  const t = text.trim()
  if (t === 'true') return true
  if (t === 'false') return false
  if (t !== '' && !Number.isNaN(Number(t))) return Number(t)
  if (t.startsWith('[') || t.startsWith('{')) {
    const v = parseJsonText(t)
    if (v !== null) return v
  }
  return text
}

export function setVariable(doc: LevelDoc, name: string, value: number | boolean | string): LevelDoc {
  const next = structuredClone(doc)
  next.content.logic.variables = { ...(next.content.logic.variables ?? {}), [name]: value }
  return next
}

export function renameVariable(doc: LevelDoc, oldName: string, newName: string): LevelDoc {
  const next = structuredClone(doc)
  const vars = { ...(next.content.logic.variables ?? {}) }
  if (oldName in vars) {
    vars[newName] = vars[oldName]
    delete vars[oldName]
  }
  next.content.logic.variables = vars
  return next
}

export function removeVariable(doc: LevelDoc, name: string): LevelDoc {
  const next = structuredClone(doc)
  const vars = { ...(next.content.logic.variables ?? {}) }
  delete vars[name]
  next.content.logic.variables = vars
  return next
}

/** 解析 JSON 文本；失败返回 null（调用方显示错误） */
export function parseJsonText(text: string): Json | null {
  try {
    const v = JSON.parse(text)
    return v === null ? null : (v as Json)
  } catch {
    return null
  }
}
