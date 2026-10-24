/**
 * 编辑器的文档状态操作：不可变更新 + 空白/副本模板（v3：视图 + 数据表）。
 * 编辑态是内存中的 LevelDoc 副本，保存时经 loadLevelDoc 校验后入库。
 */
import type { ColumnType, ComponentInstance, DataTable, LevelDoc, ViewDef } from '../engine/level'
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
        // 列声明 type（docs/27）：新表即结构化编辑，无 [object Object] 兜底渲染
        columns: [
          { key: 'data', label: '数据', type: 'json' },
          { key: 'scoring', label: '分值', type: 'number' },
        ],
        rows: [{ data: {}, scoring: 10 }],
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

/**
 * 保存升版（docs/40 A3 裁决 2026-10-23）：保存成功时自动递增 semver 修订号（0.1.0 → 0.1.1）。
 * 导入/云盘冲突规则「同 id 同版本跳过、异版本覆盖」依赖版本具备内容变更语义——
 * 编辑器保存是内容变更的主要入口，此前 version 永不递增会让导出/同步静默跳过更新。
 * 版本非法（手改坏）时保留原值不抛错——升版失败不应阻断保存。
 */
export function bumpVersion(doc: LevelDoc): LevelDoc {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(String(doc.version ?? ''))
  if (!m) return doc
  return { ...doc, version: `${m[1]}.${m[2]}.${Number(m[3]) + 1}` }
}

// ---------------------------------------------------------------------------
// R11（docs/44 R18）：写路径结构共享
//
// 历史实现每个变换都 structuredClone 整份文档（512 行 × 32 列 ≈ 数百 KB），逐键输入
// 热路径 P95 >5ms（docs/42 浏览器实测）。改为「只复制变更路径」：doc → content → 分支
// （table/rows 或 components 或 logic.variables），未变更分支保持引用。
//
// 安全前提（与 docs/40 §12.1 纪律一致）：全仓禁原地 mutation——任何变换都不会修改入参
// 已共享的对象，因此历史栈按引用存档仍成立（旧 doc 树永不被改写）。
// ---------------------------------------------------------------------------

function withContent(doc: LevelDoc, patch: Partial<LevelDoc['content']>): LevelDoc {
  return { ...doc, content: { ...doc.content, ...patch } }
}

function withTable(doc: LevelDoc, tablePatch: Partial<DataTable>): LevelDoc {
  return withContent(doc, { table: { ...doc.content.table, ...tablePatch } })
}

function withLogic(doc: LevelDoc, logicPatch: Partial<LevelDoc['content']['logic']>): LevelDoc {
  return withContent(doc, { logic: { ...doc.content.logic, ...logicPatch } })
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
  const idx = doc.content.views.findIndex((v) => v.id === id)
  if (idx < 0) return { ...doc }
  const views = doc.content.views.map((v, i) => (i === idx && patch.name !== undefined ? { ...v, name: patch.name } : v))
  return withContent(doc, { views })
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
  const idx = doc.content.components.findIndex((c) => c.id === cid)
  if (idx < 0) return { ...doc }
  const components = doc.content.components.map((c, i) => (i === idx ? { ...c, ...patch } : c))
  return withContent(doc, { components })
}

export function removeComponent(doc: LevelDoc, cid: string): LevelDoc {
  const next = structuredClone(doc)
  next.content.components = next.content.components.filter((c) => c.id !== cid)
  return next
}

// ---------------------------------------------------------------------------
// 数据表（v3：取代 questions；与变量平权的自定义字段大表格）
// ---------------------------------------------------------------------------

/** 新增列：key 需为合法标识符且不与现有列重名；显式 type:'text'
 *  （docs/40 A6：缺省 type 会让 UI 按 text 渲染而迁移器按行值推断入库，内存与库内漂移） */
export function addTableColumn(doc: LevelDoc, key: string, label?: string): LevelDoc {
  const next = structuredClone(doc)
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw new Error(`非法列名: ${key}`)
  if (next.content.table.columns.some((c) => c.key === key)) throw new Error(`列名已存在: ${key}`)
  next.content.table.columns.push({ key, label, type: 'text' })
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
  const idx = doc.content.table.columns.findIndex((c) => c.key === key)
  if (idx < 0) return { ...doc }
  const columns = doc.content.table.columns.map((c, i) => (i === idx ? { ...c, label } : c))
  return withTable(doc, { columns })
}

/** 列类型（编辑器按类型渲染单元格编辑器；切换类型不改写既有数据，仅改变渲染与编辑方式） */
export function setTableColumnType(doc: LevelDoc, key: string, type: ColumnType): LevelDoc {
  const idx = doc.content.table.columns.findIndex((c) => c.key === key)
  if (idx < 0) return { ...doc }
  const columns = doc.content.table.columns.map((c, i) => (i === idx ? { ...c, type } : c))
  return withTable(doc, { columns })
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
  const row = doc.content.table.rows[index]
  if (!row) return { ...doc }
  const rows = doc.content.table.rows.map((r, i) => (i === index ? { ...r, ...patch } : r))
  return withTable(doc, { rows })
}

export function setTable(doc: LevelDoc, table: DataTable): LevelDoc {
  const next = structuredClone(doc)
  next.content.table = table
  return next
}

/**
 * 推进配置（AI 写入工具批次2a；patch 中显式给出的键才覆盖）。
 * 归一化：patch 值为 null/undefined 的键一律**删除**——pass 的 null 过不了 Ajv（type:object，
 * 曾经导致 edit_flow 清除过关条件后无法保存），count 的 null 虽合法但与缺省同义，删键保持文档干净。
 * 「清除」语义 = 删键（结算默认通过 / 全部行）。
 */
export function setFlow(doc: LevelDoc, patch: Partial<NonNullable<LevelDoc['content']['flow']>>): LevelDoc {
  const merged: Record<string, unknown> = { ...(doc.content.flow ?? {}), ...patch }
  for (const k of Object.keys(merged)) {
    if (merged[k] === null || merged[k] === undefined) delete merged[k]
  }
  return withContent(doc, { flow: merged as NonNullable<LevelDoc['content']['flow']> })
}

export function setMeta(doc: LevelDoc, patch: Partial<LevelDoc['meta']>): LevelDoc {
  // 浅合并；Partial 的 undefined 值不会写入（Object.assign 旧语义），类型上用 LevelDoc['meta'] 收口
  return { ...doc, meta: { ...doc.meta, ...patch } as LevelDoc['meta'] }
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
  return withLogic(doc, { variables: { ...(doc.content.logic.variables ?? {}), [name]: value } })
}

export function renameVariable(doc: LevelDoc, oldName: string, newName: string): LevelDoc {
  const vars = { ...(doc.content.logic.variables ?? {}) }
  if (oldName in vars) {
    vars[newName] = vars[oldName]
    delete vars[oldName]
  }
  return withLogic(doc, { variables: vars })
}

export function removeVariable(doc: LevelDoc, name: string): LevelDoc {
  const vars = { ...(doc.content.logic.variables ?? {}) }
  delete vars[name]
  return withLogic(doc, { variables: vars })
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
