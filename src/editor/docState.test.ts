// @vitest-environment node
import { describe, expect, it } from 'vitest'
import {
  addComponent,
  addTableColumn,
  addTableRow,
  blankLevelDoc,
  removeComponent,
  removeTableRow,
  renameTableColumn,
  removeVariable,
  renameVariable,
  setTable,
  setTableColumnType,
  setVariable,
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
