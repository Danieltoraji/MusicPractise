import { describe, expect, it } from 'vitest'
import { addComponent, blankLevelDoc, setMeta, setVariable } from '../editor/docState'
import type { GNode } from '../engine/graphProgram'
import type { LevelDoc } from '../engine/level'
import { buildEditorSystemPrompt, buildPlanExecutionPrompt, clipContractText, describeGNode, formatSelectionContext } from './prompts'

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

  it('F3：组件段附 props 契约（name/type/options/default + propsDoc）与生命周期事件目录', () => {
    let doc = blankLevelDoc()
    doc = addComponent(doc, 'synth', 'main')
    const text = buildEditorSystemPrompt(doc)
    // 结构化 props 字段：name:type[选项]=默认
    expect(text).toContain('wave:string[')
    expect(text).toContain(']="sawtooth"')
    expect(text).toContain('gain:number=0.35')
    // 自由说明 propsDoc
    expect(text).toContain('纯振荡器')
    // 生命周期事件目录（on 入口可用 + payload 提示）
    expect(text).toContain('生命周期事件目录')
    expect(text).toContain('level.started')
    expect(text).toContain('question.loaded')
    expect(text).toContain('view.entered')
  })

  it('F3：契约长文本单条截断到 ≤200 字符', () => {
    const long = 'x'.repeat(500)
    const clipped = clipContractText(long)
    expect(clipped.length).toBe(201) // 200 + 省略号
    expect(clipped.endsWith('…')).toBe(true)
    expect(clipContractText('短文本')).toBe('短文本')
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

describe('提示词节流与 plan 标记合并（工具粒度治理）', () => {
  it('agent 守则包含效率守则：批量参数与同轮多调用', () => {
    const text = buildEditorSystemPrompt(makeDoc(), 'agent')
    expect(text).toContain('效率守则')
    expect(text).toContain('items/updates/ids')
    expect(text).toContain('events 剧本')
  })

  it('agent 守则包含事件守则：契约清单为准、禁止臆测、run_level 一次性探测', () => {
    const text = buildEditorSystemPrompt(makeDoc(), 'agent')
    expect(text).toContain('事件守则')
    expect(text).toContain('绝不臆测')
    expect(text).toContain('无处理器命中')
  })

  it('ask/plan 守则不含效率与事件守则（只读模式无写入批量形态）', () => {
    expect(buildEditorSystemPrompt(makeDoc(), 'ask')).not.toContain('效率守则')
    expect(buildEditorSystemPrompt(makeDoc(), 'plan')).not.toContain('效率守则')
    expect(buildEditorSystemPrompt(makeDoc(), 'ask')).not.toContain('事件守则')
    expect(buildEditorSystemPrompt(makeDoc(), 'plan')).not.toContain('事件守则')
  })

  it('plan 执行提示：编号清单 + 要求合并标记（marks 批量）', () => {
    const text = buildPlanExecutionPrompt([{ text: '[set_variable] 声明 score' }, { text: '[run_level] 验证结算' }])
    expect(text).toContain('1. [set_variable] 声明 score')
    expect(text).toContain('2. [run_level] 验证结算')
    expect(text).toContain('marks')
    expect(text).toContain('合并标记')
  })
})
