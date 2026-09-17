// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { addComponent, blankLevelDoc, copyForEditing, removeComponent, updateQuestion } from './docState'
import { loadLevelDoc } from '../library/validate'

describe('docState（编辑器文档操作）', () => {
  it('addComponent：删除组件后再添加同类型，id 不重复（P1 回归）', () => {
    let doc = blankLevelDoc()
    doc = addComponent(doc, 'button') // button1
    doc = addComponent(doc, 'button') // button2
    doc = removeComponent(doc, 'button1')
    doc = addComponent(doc, 'button') // 若按长度生成会再次得到 button2
    const ids = doc.content.components.map((c) => c.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('blankLevelDoc 通过装载管线校验且无 lint 告警', () => {
    const r = loadLevelDoc(blankLevelDoc())
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.lintWarnings).toEqual([])
  })

  it('copyForEditing：新 id、版本归零、标题加后缀', () => {
    const doc = blankLevelDoc()
    doc.meta.title = '原关卡'
    const copy = copyForEditing(doc)
    expect(copy.id).not.toBe(doc.id)
    expect(copy.version).toBe('0.1.0')
    expect(String(copy.meta.title)).toContain('副本')
    expect(copy.content).toEqual(doc.content)
  })

  it('updateQuestion 更新指定题目', () => {
    let doc = blankLevelDoc()
    doc = updateQuestion(doc, 0, { prompt: { text: '新题面' } })
    expect(doc.content.questions[0].prompt?.text).toBe('新题面')
  })
})
