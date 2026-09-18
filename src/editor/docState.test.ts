// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { addComponent, blankLevelDoc, removeComponent, removeVariable, renameVariable, setVariable } from './docState'

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
