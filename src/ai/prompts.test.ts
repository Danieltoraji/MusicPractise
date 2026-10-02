import { describe, expect, it } from 'vitest'
import { addComponent, blankLevelDoc, setMeta, setVariable } from '../editor/docState'
import type { GNode } from '../engine/graphProgram'
import type { LevelDoc } from '../engine/level'
import { buildEditorSystemPrompt, describeGNode, formatSelectionContext } from './prompts'

function makeDoc(): LevelDoc {
  let doc = setMeta(blankLevelDoc(), { title: '测试关' })
  doc = setVariable(doc, 'score', 0)
  doc = addComponent(doc, 'button', 'main')
  return doc
}

describe('describeGNode', () => {
  it('各 kind 的单行摘要', () => {
    expect(describeGNode({ id: 'a', kind: 'on', event: 'b1.clicked' } as GNode)).toBe('on b1.clicked')
    expect(describeGNode({ id: 'a', kind: 'call', target: 's1', method: 'play', args: ['1', 'x'] } as GNode)).toBe('s1.play(1, x)')
    expect(describeGNode({ id: 'a', kind: 'assign', target: 'score', value: { expr: 'v.score + 10' } } as GNode)).toBe('v.score = v.score + 10')
    expect(
      describeGNode({ id: 'a', kind: 'assign', target: 'g', value: { call: { target: 't1', method: 'getCount', args: [] } } } as GNode),
    ).toBe('v.g = t1.getCount(...)')
    expect(describeGNode({ id: 'a', kind: 'branch', cond: 'v.score >= 10' } as GNode)).toBe('if (v.score >= 10)')
    expect(describeGNode({ id: 'a', kind: 'loop', mode: 'repeat', times: '3' } as GNode)).toBe('repeat (3)')
    expect(describeGNode({ id: 'a', kind: 'wait', ms: '500' } as GNode)).toBe('wait (500)')
    expect(describeGNode({ id: 'a', kind: 'emit', event: 'app:x' } as GNode)).toBe("emit 'app:x'")
  })
})

describe('buildEditorSystemPrompt', () => {
  it('包含组件契约清单、变量、表列与视图', () => {
    const doc = makeDoc()
    const text = buildEditorSystemPrompt(doc)
    expect(text).toContain('测试关')
    expect(text).toContain('ask 模式')
    expect(text).toContain('button1') // 组件 id（addComponent 自动生成）
    expect(text).toContain('clicked') // button 契约事件
    expect(text).toContain('setText') // button 契约命令
    expect(text).toContain('score=0')
    expect(text).toContain('data(') // blankLevelDoc 默认列 data(json)
    expect(text).toContain('scoring(')
    expect(text).toContain('main')
    expect(text).toContain('pass=')
  })
})

describe('formatSelectionContext', () => {
  it('无选中 → 空串；仅 tab 无具体选中 → 空串', () => {
    expect(formatSelectionContext(null, makeDoc())).toBe('')
    expect(formatSelectionContext({ tab: 'table' }, makeDoc())).toBe('')
  })

  it('画布组件 / 图节点 / 脚本选区三种上下文', () => {
    const doc = makeDoc()
    const compId = doc.content.components[0].id
    const comp = formatSelectionContext({ tab: 'canvas', componentId: compId }, doc)
    expect(comp).toContain('当前页面：画布')
    expect(comp).toContain(`选中组件 ${compId}（button`)

    doc.content.logic.nodes.push({ id: 'br1', kind: 'branch', cond: 'v.score >= 10' } as GNode)
    const node = formatSelectionContext({ tab: 'graph', nodeId: 'br1' }, doc)
    expect(node).toContain('当前页面：节点图')
    expect(node).toContain('选中节点 br1：if (v.score >= 10)')

    const script = formatSelectionContext(
      { tab: 'script', scriptRange: { startLine: 2, endLine: 3, text: 'sound1.play()' } },
      doc,
    )
    expect(script).toContain('当前页面：脚本')
    expect(script).toContain('选中脚本 第 2–3 行')
    expect(script).toContain('sound1.play()')
  })
})
