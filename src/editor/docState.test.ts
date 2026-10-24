// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { loadLevelDoc } from '../library/validate'
import {
  addComponent,
  bumpVersion,
  addTableColumn,
  addTableRow,
  blankLevelDoc,
  removeComponent,
  removeTableRow,
  renameTableColumn,
  removeVariable,
  renameVariable,
  setMeta,
  setTable,
  setTableColumnType,
  setFlow,
  setVariable,
  updateComponent,
  updateTableColumnLabel,
  updateTableCell,
} from './docState'

describe('docState 变量操作', () => {
  it('setVariable 新增与覆盖', () => {
    let doc = blankLevelDoc()
    doc = setVariable(doc, 'score', 0)
    doc = setVariable(doc, 'score', 30)
    doc = setVariable(doc, 'flag', true)
    expect(doc.content.logic.variables).toEqual({ score: 30, flag: true })
  })

  it('renameVariable 保留值并迁移键', () => {
    let doc = blankLevelDoc()
    doc = setVariable(doc, 'old', 5)
    doc = renameVariable(doc, 'old', 'new')
    expect(doc.content.logic.variables).toMatchObject({ new: 5 })
  })

  it('renameVariable 原变量不存在时不新增', () => {
    let doc = blankLevelDoc()
    doc = renameVariable(doc, 'ghost', 'new')
    expect(doc.content.logic.variables).not.toHaveProperty('new')
  })

  it('removeVariable 删除指定变量', () => {
    let doc = blankLevelDoc()
    doc = setVariable(doc, 'a', 1)
    doc = setVariable(doc, 'b', 2)
    doc = removeVariable(doc, 'a')
    expect(doc.content.logic.variables).not.toHaveProperty('a')
    expect(doc.content.logic.variables).toHaveProperty('b', 2)
  })
})

describe('docState 组件操作', () => {
  it('addComponent：删除组件后再添加同类型，id 不重复（P1 回归）', () => {
    let doc = blankLevelDoc()
    doc = addComponent(doc, 'button') // button1
    doc = addComponent(doc, 'button') // button2
    doc = removeComponent(doc, 'button1')
    doc = addComponent(doc, 'button') // 若按长度生成会再次得到 button2
    const ids = doc.content.components.map((c) => c.id)
    expect(new Set(ids).size).toBe(ids.length)
  })
})

describe('docState 数据表操作（3-7 网格编辑配套）', () => {
  const withTable = () => {
    let doc = blankLevelDoc()
    doc = setTable(doc, { columns: [], rows: [] }) // 清空初始表格，从零验证列/行操作
    doc = addTableColumn(doc, 'title', '题面')
    doc = addTableColumn(doc, 'bpm', '速度')
    doc = addTableRow(doc)
    doc = updateTableCell(doc, 0, { title: '第一题', bpm: 96 })
    return doc
  }

  it('addTableColumn 补 null 列；updateTableCell 浅合并', () => {
    const doc = withTable()
    expect(doc.content.table.columns.map((c) => c.key)).toEqual(['title', 'bpm'])
    expect(doc.content.table.rows[0]).toEqual({ title: '第一题', bpm: 96 })
  })

  it('renameTableColumn：行内键迁移 + 撞名抛错', () => {
    let doc = withTable()
    doc = renameTableColumn(doc, 'title', 'name')
    expect(doc.content.table.rows[0].name).toBe('第一题')
    expect(doc.content.table.rows[0]).not.toHaveProperty('title')
    expect(() => renameTableColumn(doc, 'name', 'bpm')).toThrow(/列名已存在/)
  })

  it('setTableColumnType：只改列元数据，不动行数据', () => {
    let doc = withTable()
    doc = setTableColumnType(doc, 'bpm', 'number')
    expect(doc.content.table.columns.find((c) => c.key === 'bpm')?.type).toBe('number')
    expect(doc.content.table.rows[0].bpm).toBe(96)
  })

  it('addTableRow 可插行；removeTableRow 删行', () => {
    let doc = withTable()
    doc = addTableRow(doc, 0) // 插到第一行后：新行在 index 1
    expect(doc.content.table.rows).toHaveLength(2)
    expect(doc.content.table.rows[0].title).toBe('第一题')
    expect(doc.content.table.rows[1].title).toBeNull()
    doc = removeTableRow(doc, 1)
    expect(doc.content.table.rows).toHaveLength(1)
  })

  it('非法列名/重名列抛错', () => {
    const doc = withTable()
    expect(() => addTableColumn(doc, 'bad name')).toThrow(/非法列名/)
    expect(() => addTableColumn(doc, 'title')).toThrow(/列名已存在/)
  })
})

describe('setFlow 归一化（批次10）', () => {
  it('null/undefined 值的键一律删除（清除语义 = 缺键），文档保持 schema 合法', () => {
    let doc = blankLevelDoc()
    doc = setFlow(doc, { order: 'shuffle', count: 5, pass: { expr: 'v.score >= 60' } })
    expect(doc.content.flow).toMatchObject({ order: 'shuffle', count: 5, pass: { expr: 'v.score >= 60' } })

    // 清除过关条件：pass null → 删键（曾经存 null 导致 Ajv 拒绝 /content/flow/pass must be object）
    doc = setFlow(doc, { pass: null as never })
    expect(doc.content.flow).toMatchObject({ order: 'shuffle', count: 5 })
    expect('pass' in (doc.content.flow ?? {})).toBe(false)

    // count null（= 全部）→ 同样删键；order undefined → 删键（回落 sequential）
    doc = setFlow(doc, { count: null as never, order: undefined as never })
    expect(doc.content.flow).toEqual({})
  })

  it('归一化后的文档能通过 loadLevelDoc 装载（清除过关条件可保存）', () => {
    let doc = blankLevelDoc()
    doc = setFlow(doc, { pass: null as never, count: null as never })
    const r = loadLevelDoc(structuredClone(doc))
    expect(r.ok).toBe(true)
  })
})

describe('bumpVersion（docs/40 A3 裁决：保存自动升修订号）', () => {
  it('semver 修订号 +1', () => {
    const doc = { ...blankLevelDoc(), version: '0.1.0' }
    expect(bumpVersion(doc).version).toBe('0.1.1')
    expect(bumpVersion({ ...doc, version: '2.19.9' }).version).toBe('2.19.10')
  })

  it('非法/缺失版本保留原值不抛错（升版失败不阻断保存）', () => {
    const doc = blankLevelDoc()
    expect(bumpVersion({ ...doc, version: 'not-semver' }).version).toBe('not-semver')
    expect(bumpVersion({ ...doc, version: undefined as unknown as string }).version).toBeUndefined()
  })

  it('返回新对象、不改入参（不可变约定）', () => {
    const doc = { ...blankLevelDoc(), version: '0.1.0' }
    const next = bumpVersion(doc)
    expect(next).not.toBe(doc)
    expect(doc.version).toBe('0.1.0')
  })
})

describe('R11 写路径结构共享（docs/44 R18）', () => {
  /** 两行一列 + 一个按钮的最小文档 */
  function fixture() {
    let doc = blankLevelDoc()
    doc = setTable(doc, {
      columns: [{ key: 'title', label: '题面', type: 'text' }],
      rows: [{ title: 'a' }, { title: 'b' }],
    })
    doc = addComponent(doc, 'button')
    return doc
  }

  it('热路径只复制变更分支：未变更分支保持引用；入参树不被改写（历史栈安全）', () => {
    const prev = fixture()

    // 单元格：doc / content / table / rows / 该行 新引用；其它行与 components/logic 共享
    const next = updateTableCell(prev, 1, { title: 'b2' })
    expect(next).not.toBe(prev)
    expect(next.content).not.toBe(prev.content)
    expect(next.content.table).not.toBe(prev.content.table)
    expect(next.content.table.rows).not.toBe(prev.content.table.rows)
    expect(next.content.table.rows[1]).not.toBe(prev.content.table.rows[1])
    expect(next.content.table.rows[0]).toBe(prev.content.table.rows[0])
    expect(next.content.components).toBe(prev.content.components)
    expect(next.content.logic).toBe(prev.content.logic)
    expect(prev.content.table.rows[1].title).toBe('b') // 旧树不变

    // 组件：只复制 components 分支；table/logic 与上一版共享
    const comp = updateComponent(next, 'button1', { name: '确认' })
    expect(comp.content.components).not.toBe(next.content.components)
    expect(comp.content.components[0].name).toBe('确认')
    expect(next.content.components[0].name).toBeUndefined()
    expect(comp.content.table).toBe(next.content.table)
    expect(comp.content.logic).toBe(next.content.logic)

    // meta：只复制 meta 本身，content 整树共享
    const meta = setMeta(comp, { title: '新标题' })
    expect(meta.meta).not.toBe(comp.meta)
    expect(meta.content).toBe(comp.content)
    expect(comp.meta.title).not.toBe('新标题')

    // 变量：只复制 logic.variables 分支
    const vars = setVariable(meta, 'flag', true)
    expect(vars.content.logic).not.toBe(meta.content.logic)
    expect(vars.content.table).toBe(meta.content.table)
    expect(vars.content.components).toBe(meta.content.components)

    // 列显示名/类型：只复制 columns 分支
    const label = updateTableColumnLabel(vars, 'title', '题干')
    expect(label.content.table.columns).not.toBe(vars.content.table.columns)
    expect(label.content.table.rows).toBe(vars.content.table.rows)
    const typed = setTableColumnType(label, 'title', 'number')
    expect(typed.content.table.columns[0].type).toBe('number')
    expect(label.content.table.columns[0].type).toBe('text')
  })

  it('未命中的目标返回新 doc 但共享整树（保持「调用后返回新引用」语义）', () => {
    const prev = fixture()
    const noRow = updateTableCell(prev, 99, { title: 'x' })
    expect(noRow).not.toBe(prev)
    expect(noRow.content).toBe(prev.content)
    const noComp = updateComponent(prev, 'ghost', { name: 'x' })
    expect(noComp.content).toBe(prev.content)
  })
})

describe('addTableColumn 显式 type（docs/40 A6）', () => {
  it('新列携带 type:text，避免 UI 缺省显示与库内推断类型漂移', () => {
    const doc = addTableColumn(blankLevelDoc(), 'newcol')
    expect(doc.content.table.columns.find((c) => c.key === 'newcol')?.type).toBe('text')
  })
})
