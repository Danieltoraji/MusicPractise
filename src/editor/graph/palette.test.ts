import { describe, expect, it } from 'vitest'
import { buildEventGroups, buildPalette, buildTemplates } from './palette'
import { applyTemplate } from './applyTemplate'
import { arrangeLayout, dagrePositions } from './layout'
import { blankGraphProgram, addNode, connect, isGraphProgram, lintGraphProgram, removeGraphVariable } from '../../engine/graphProgram'
import type { LevelDoc } from '../../engine/level'
import type { Json } from '../../engine/expr'

const doc = (components: { id: string; type: string; name?: string }[], variables: Record<string, Json> = { score: 0 }): LevelDoc =>
  ({
    schemaVersion: 3,
    kind: 'level',
    id: 'x',
    version: '0.1.0',
    meta: { title: 't' },
    refs: [],
    content: {
      views: [{ id: 'main', name: '主视图' }],
      components: components.map((c) => ({ ...c, visible: true, view: 'main' })),
      logic: { ...blankGraphProgram(), variables },
      table: { columns: [], rows: [] },
    },
  }) as unknown as LevelDoc

describe('buildPalette（节点库候选，精简后）', () => {
  it('动作/视图收敛为通用单项；关卡组完整；事件不再进节点库', () => {
    const groups = buildPalette(doc([{ id: 'sound1', type: 'sound' }, { id: 'timer1', type: 'timer' }]))
    const byId = Object.fromEntries(groups.map((g) => [g.id, g]))
    expect(byId.event).toBeUndefined() // 事件由「事件」面板提供
    const act = byId.action.items
    expect(act).toHaveLength(1)
    expect(act[0].key).toBe('act-generic')
    // 落图默认指向第一个组件的第一个公开命令（无 __ 内部命令）
    const shape = act[0].make() as { kind: 'call'; target: string; method: string }
    expect(shape.target).toBe('sound1')
    expect(shape.method).toBe('play')
    expect(byId.view.items).toHaveLength(1)
    expect(byId.view.items[0].key).toBe('view-goto-generic')
    expect(byId.level.items.map((i) => i.key)).toEqual(['q-next', 'lvl-restart', 'lvl-finish'])
    const next = byId.level.items[0].make() as { kind: 'call'; target: string; method: string }
    expect(next).toMatchObject({ target: 'question', method: 'next' })
  })

  it('make 产出合法节点形状（补 id 后过 addNode）', () => {
    const groups = buildPalette(doc([{ id: 'staff1', type: 'staff' }]))
    const item = groups.find((g) => g.id === 'action')!.items[0]
    const shape = item.make({ x: 10, y: 20 })
    const prog = addNode(blankGraphProgram(), { ...shape, id: 'n1' } as never)
    expect(isGraphProgram(prog)).toBe(true)
    expect(prog.nodes[0]).toMatchObject({ kind: 'call', target: 'staff1', x: 10, y: 20 })
  })

  it('变量赋值组按已声明变量生成；无组件时组件动作落 question.next', () => {
    const groups = buildPalette(doc([], { score: 0, streak: 0 }))
    const varGroup = groups.find((g) => g.id === 'variable')!
    expect(varGroup.items.map((i) => i.label)).toEqual(['v.score = …', 'v.streak = …'])
    const act = groups.find((g) => g.id === 'action')!.items[0].make()
    expect(act).toMatchObject({ kind: 'call', target: 'question', method: 'next' })
  })
})

describe('buildEventGroups（事件面板候选）', () => {
  it('生命周期 + 组件事件 + 内部事件三组', () => {
    let d = doc([{ id: 'staff1', type: 'staff' }])
    d = {
      ...d,
      content: {
        ...d.content,
        logic: {
          ...d.content.logic,
          nodes: [...d.content.logic.nodes, { id: 'e1', kind: 'on', event: 'app:burst' }],
        },
      },
    } as typeof d
    const groups = buildEventGroups(d)
    const byName = Object.fromEntries(groups.map((g) => [g.group, g.items]))
    expect(byName['关卡']?.map((i) => i.value)).toEqual(['level.started', 'level.finished'])
    expect(byName['题目']?.map((i) => i.value)).toEqual(['question.loaded'])
    expect(byName['视图']?.map((i) => i.value)).toEqual(['view.entered'])
    expect(byName['组件事件']?.map((i) => i.value)).toEqual(['staff1.noteClicked'])
    expect(byName['内部事件']?.map((i) => i.value)).toEqual(['app:burst'])
  })
})

describe('buildTemplates + applyTemplate（一键模板）', () => {
  it('计分模板：无 timer 组件时只有 1 个；含 timer 时出现防卡死守卫', () => {
    const without = buildTemplates(doc([{ id: 'sound1', type: 'sound' }]))
    expect(without.map((t) => t.key)).toEqual(['tpl-score-gate'])
    const withTimer = buildTemplates(doc([{ id: 'timer1', type: 'timer' }]))
    expect(withTimer.map((t) => t.key)).toEqual(['tpl-score-gate', 'tpl-timeout-guard'])
  })

  it('落图后 lint 零错且结构正确（applyTemplate 纯函数）', () => {
    const groups = buildPalette(doc([{ id: 'timer1', type: 'timer' }]))
    const templates = buildTemplates(doc([{ id: 'timer1', type: 'timer' }]))
    void groups
    let prog = blankGraphProgram()
    for (const tpl of templates) {
      prog = applyTemplate(prog, tpl, { x: 100, y: 100 })
    }
    // 5 + 4 个节点；lint 零错（默认值合法、变量 score 已声明）
    expect(prog.nodes).toHaveLength(9)
    expect(lintGraphProgram(prog, { componentIds: ['timer1'] })).toEqual([])
    // 模板 2 引用了真实 timer 实例
    expect(prog.nodes.some((n) => n.kind === 'call' && n.target === 'timer1' && n.method === 'start')).toBe(true)
    // 相对坐标落在 pos 偏移处
    const first = prog.nodes[0]
    expect(first.x).toBe(100)
  })

  it('P1 回归：已删 score 的关卡落计分模板 → 变量自动声明、lint 零错', () => {
    const templates = buildTemplates(doc([{ id: 'sound1', type: 'sound' }]))
    const tpl = templates.find((t) => t.key === 'tpl-score-gate')!
    let prog = blankGraphProgram()
    prog = removeGraphVariable(prog, 'score') // 用户已删掉 score
    prog = applyTemplate(prog, tpl, { x: 0, y: 0 })
    expect(prog.variables).toMatchObject({ score: 0 })
    expect(lintGraphProgram(prog)).toEqual([])
  })

  it('连线引用越界抛错', () => {
    const bad = {
      key: 'bad',
      label: 'bad',
      desc: '',
      make: () => ({
        nodes: [{ kind: 'comment', text: 'only' }],
        links: [{ from: 0, to: 5 }],
      }),
    } as unknown as Parameters<typeof applyTemplate>[1]
    expect(() => applyTemplate(blankGraphProgram(), bad, undefined)).toThrow(/越界/)
  })
})

describe('arrangeLayout（dagre 布局）', () => {
  it('missing 模式只补无位置节点；all 模式全重排', () => {
    let prog = blankGraphProgram()
    prog = addNode(prog, { id: 'a', kind: 'on', event: 'level.started', x: 100, y: 100 })
    prog = addNode(prog, { id: 'b', kind: 'comment', text: 'x' })
    prog = connect(prog, 'a', 'b')

    const filled = arrangeLayout(prog, 'missing')
    expect(filled.nodes.find((n) => n.id === 'a')).toMatchObject({ x: 100, y: 100 })
    expect(filled.nodes.find((n) => n.id === 'b')?.x).toBeTypeOf('number')

    const all = arrangeLayout(prog, 'all')
    const a = all.nodes.find((n) => n.id === 'a')!
    const b = all.nodes.find((n) => n.id === 'b')!
    // LR 布局：下游节点在右侧
    expect(b.x!).toBeGreaterThan(a.x!)
    expect(dagrePositions(prog).size).toBe(2)
  })
})
