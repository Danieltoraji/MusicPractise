import { describe, expect, it } from 'vitest'
import { buildPalette } from './palette'
import { arrangeLayout, dagrePositions } from './layout'
import { blankGraphProgram, addNode, connect, isGraphProgram } from '../../engine/graphProgram'
import type { LevelDoc } from '../../engine/level'
import type { Json } from '../../engine/expr'

const doc = (components: { id: string; type: string; name?: string }[], variables: Record<string, Json> = { score: 0 }): LevelDoc =>
  ({
    schemaVersion: 1,
    kind: 'level',
    id: 'x',
    version: '0.1.0',
    meta: { title: 't' },
    refs: [],
    content: {
      components: components.map((c) => ({ ...c, visible: true })),
      logic: { ...blankGraphProgram(), variables },
      questions: [{ id: 'q1', data: {}, scoring: { max: 10 } }],
    },
  }) as unknown as LevelDoc

describe('buildPalette（节点库候选）', () => {
  it('事件组：生命周期 + 契约事件；动作组：过滤内部命令', () => {
    const groups = buildPalette(doc([{ id: 'sound1', type: 'sound' }, { id: 'timer1', type: 'timer' }]))
    const byId = Object.fromEntries(groups.map((g) => [g.id, g]))
    const evtKeys = byId.event.items.map((i) => i.key)
    expect(evtKeys).toContain('evt-level.started')
    expect(evtKeys).toContain('evt-timer1.tick')
    // sound 契约没有事件，不应出现
    expect(evtKeys.filter((k) => k.startsWith('evt-sound1.'))).toEqual([])
    const actKeys = byId.action.items.map((i) => i.key)
    expect(actKeys).toContain('act-sound1.play')
    expect(actKeys.filter((k) => k.includes('__'))).toEqual([])
    expect(byId.level.items.map((i) => i.key)).toEqual(['lvl-next', 'lvl-restart', 'lvl-finish'])
  })

  it('make 产出合法节点形状（补 id 后过 addNode）', () => {
    const groups = buildPalette(doc([{ id: 'staff1', type: 'staff' }]))
    const item = groups.find((g) => g.id === 'action')!.items.find((i) => i.key === 'act-staff1.highlight')!
    const shape = item.make({ x: 10, y: 20 })
    const prog = addNode(blankGraphProgram(), { ...shape, id: 'n1' } as never)
    expect(isGraphProgram(prog)).toBe(true)
    expect(prog.nodes[0]).toMatchObject({ kind: 'call', target: 'staff1', method: 'highlight', x: 10, y: 20 })
  })

  it('变量赋值组按已声明变量生成；无组件时事件组只剩生命周期', () => {
    const groups = buildPalette(doc([], { score: 0, streak: 0 }))
    const varGroup = groups.find((g) => g.id === 'variable')!
    expect(varGroup.items.map((i) => i.label)).toEqual(['v.score = …', 'v.streak = …'])
    const evtGroup = groups.find((g) => g.id === 'event')!
    expect(evtGroup.items).toHaveLength(3)
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
