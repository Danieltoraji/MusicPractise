import { describe, expect, it } from 'vitest'
import { connect, type GEdge, type GNode, type GraphProgram } from './graphProgram'
import { migrateLogicV1toV2 } from './migrate'
import { generateScript, parseScript, ScriptError } from './script'
import type { Json } from './expr'
import type { LogicProgram } from './logic'

import noteClickDoc from '../sample/note-click.level.json'
import melodyDictationDoc from '../sample/melody-dictation.level.json'
import timedReactionDoc from '../sample/timed-reaction.level.json'

function prog(nodes: GNode[], edges: GEdge[], variables?: Record<string, Json>): GraphProgram {
  return { logicVersion: 2, variables: variables ?? {}, nodes, edges }
}

function linked(nodes: GNode[], links: [string, string, ('true' | 'false')?][]): GraphProgram {
  let edges: GEdge[] = []
  let p = prog(nodes, edges)
  for (const [from, to, port] of links) {
    const next = connect(p, from, to, port)
    edges = next.edges
    p = { ...p, edges }
  }
  return p
}

const SAMPLE_TEXT = `// 听音点击
on level.started {
  v.score = 0
  scoreLabel.show('得分: 0', 'info')
}

on staff1.noteClicked {
  if (event.midi == q.data.target) {
    sound1.play(q.data.rewardChord)
    v.score = v.score + q.scoring.max
    v.last = staff1.getSelection()
  } else {
    sound1.play([{ midi: 60 }])
  }
  wait (500)
  emit 'app:answer' { ok: event.midi == q.data.target, n: v.score }
  repeat (len(q.data.items)) {
    v.i = v.i + 1
  }
  while (v.i > 0 && v.done == false) {
    v.i = v.i - 1
  }
  if (v.score >= q.scoring.max) { level.finish() }
}`

describe('generateScript', () => {
  it('简单链：call/assign/emit/wait/comment', () => {
    const g = linked(
      [
        { id: 'a', kind: 'on', event: 'level.started' },
        { id: 'b', kind: 'call', target: 'label1', method: 'show', args: ["'hi'"] },
        { id: 'c', kind: 'assign', target: 'score', value: { expr: 'v.score + 1' } },
        { id: 'd', kind: 'assign', target: 'reading', value: { call: { target: 'tuner1', method: 'getReading', args: [] } } },
        { id: 'e', kind: 'emit', event: 'app:tick', payload: { n: 'v.score' } },
        { id: 'f', kind: 'wait', ms: '500' },
        { id: 'g', kind: 'comment', text: '结束' },
      ],
      [['a', 'b'], ['b', 'c'], ['c', 'd'], ['d', 'e'], ['e', 'f'], ['f', 'g']],
    )
    const text = generateScript(g)
    expect(text).toBe(
      [
        'on level.started {',
        "  label1.show('hi')",
        '  v.score = v.score + 1',
        '  v.reading = tuner1.getReading()',
        "  emit 'app:tick' {n: v.score}",
        '  wait (500)',
        '  // 结束',
        '}',
        '',
      ].join('\n'),
    )
  })

  it('branch 与 else-if 链', () => {
    const g = linked(
      [
        { id: 'a', kind: 'on', event: 'level.started' },
        { id: 'b', kind: 'branch', cond: 'v.x > 0' },
        { id: 'c', kind: 'call', target: 'l', method: 'show', args: [] },
        { id: 'd', kind: 'branch', cond: 'v.x < 0' },
        { id: 'e', kind: 'call', target: 'l', method: 'hide', args: [] },
      ],
      [['a', 'b'], ['b', 'c', 'true'], ['b', 'd', 'false'], ['d', 'e', 'true']],
    )
    expect(generateScript(g)).toBe(
      ['on level.started {', '  if (v.x > 0) {', '    l.show()', '  } else if (v.x < 0) {', '    l.hide()', '  }', '}', ''].join('\n'),
    )
  })

  it('loop：while/repeat 与体回边', () => {
    const g = linked(
      [
        { id: 'a', kind: 'on', event: 'app:tick' },
        { id: 'w', kind: 'loop', mode: 'while', cond: 'v.i < 3' },
        { id: 'b', kind: 'assign', target: 'i', value: { expr: 'v.i + 1' } },
        { id: 'r', kind: 'loop', mode: 'repeat', times: '3' },
        { id: 'c', kind: 'call', target: 'l', method: 'show', args: [] },
      ],
      [
        ['a', 'w'],
        ['w', 'b', 'true'],
        ['b', 'w'], // 回边
        ['w', 'r', 'false'],
        ['r', 'c', 'true'],
        ['c', 'r'], // 回边
      ],
    )
    const text = generateScript(g)
    expect(text).toContain('while (v.i < 3) {')
    expect(text).toContain('v.i = v.i + 1')
    expect(text).toContain('repeat (3) {')
  })

  it('汇合与循环体掉出抛错', () => {
    // 菱形汇合：两分支连到同一节点
    const g = linked(
      [
        { id: 'a', kind: 'on', event: 'level.started' },
        { id: 'br', kind: 'branch', cond: 'v.x' },
        { id: 'c1', kind: 'call', target: 'l', method: 'show', args: [] },
        { id: 'c2', kind: 'call', target: 'l', method: 'show', args: [] },
        { id: 't', kind: 'call', target: 'l', method: 'hide', args: [] },
      ],
      [['a', 'br'], ['br', 'c1', 'true'], ['br', 'c2', 'false'], ['c1', 't'], ['c2', 't']],
    )
    expect(() => generateScript(g)).toThrow(/汇入/)

    // 循环体末尾连到循环后继（跳出）
    const g2 = linked(
      [
        { id: 'a', kind: 'on', event: 'level.started' },
        { id: 'w', kind: 'loop', mode: 'while', cond: 'v.i < 3' },
        { id: 'b', kind: 'call', target: 'l', method: 'show', args: [] },
        { id: 'z', kind: 'call', target: 'l', method: 'hide', args: [] },
      ],
      [['a', 'w'], ['w', 'b', 'true'], ['b', 'z'], ['w', 'z', 'false']],
    )
    expect(() => generateScript(g2)).toThrow(/提前结束|跳出/)
  })
})

describe('parseScript', () => {
  it('SAMPLE_TEXT 全语句形态解析', () => {
    const g = parseScript(SAMPLE_TEXT, { variables: { score: 0 } })
    expect(g.logicVersion).toBe(2)
    expect(g.variables).toEqual({ score: 0 })
    const ons = g.nodes.filter((n) => n.kind === 'on')
    expect(ons.map((n) => (n as Extract<GNode, { kind: 'on' }>).event)).toEqual(['level.started', 'staff1.noteClicked'])
    const byKind = (kind: GNode['kind']) => g.nodes.filter((n) => n.kind === kind)
    expect(byKind('branch')).toHaveLength(2)
    expect(byKind('loop')).toHaveLength(2)
    expect(byKind('wait')).toHaveLength(1)
    const emits = byKind('emit') as Extract<GNode, { kind: 'emit' }>[]
    expect(emits[0].event).toBe('app:answer')
    expect(emits[0].payload).toEqual({ ok: 'event.midi == q.data.target', n: 'v.score' })
    const assigns = byKind('assign') as Extract<GNode, { kind: 'assign' }>[]
    // v.last = staff1.getSelection() 解析为查询调用
    expect(assigns.some((a) => a.target === 'last' && 'call' in a.value && a.value.call.method === 'getSelection')).toBe(true)
    // level.finish() 解析为 call
    const calls = byKind('call') as Extract<GNode, { kind: 'call' }>[]
    expect(calls.some((c) => c.target === 'level' && c.method === 'finish')).toBe(true)
  })

  it('else 分支、单行块、分号与注释容忍', () => {
    const text = [
      '// 注释应被跳过',
      'on level.started { v.x = 1; v.y = v.x + 2 }',
      'on app:tick {',
      '  if (v.x) { v.x = 0 } else { emit "app:no" }',
      '}',
    ].join('\n')
    const g = parseScript(text)
    expect(g.nodes.filter((n) => n.kind === 'on')).toHaveLength(2)
    const emits = g.nodes.filter((n) => n.kind === 'emit') as Extract<GNode, { kind: 'emit' }>[]
    expect(emits[0].event).toBe('app:no')
    // 全局 assign：handler1 的 x/y + handler2 if 块内的 x
    const assigns = g.nodes.filter((n) => n.kind === 'assign') as Extract<GNode, { kind: 'assign' }>[]
    expect(assigns.map((a) => a.target)).toEqual(['x', 'y', 'x'])
  })

  it('语法错误带行列号', () => {
    expect(() => parseScript('on level.started {')).toThrow(ScriptError)
    try {
      parseScript('on level.started {\n  v.x = 1\n  v.y = \n}')
    } catch (e) {
      expect(e).toBeInstanceOf(ScriptError)
      expect((e as ScriptError).line).toBe(3)
    }
    expect(() => parseScript('foo.bar')).toThrow(/期望 "on"/)
    expect(() => parseScript("on level.started {\n  emit 'x\n}")).toThrow(/未闭合/)
    expect(() => parseScript('on levelx { v.a = 1 }')).toThrow(/事件名格式/)
  })
})

describe('往返恒等：generate ∘ parse ∘ generate', () => {
  it('手写文本往返', () => {
    const text = generateScript(parseScript(SAMPLE_TEXT))
    const text2 = generateScript(parseScript(text))
    expect(text2).toBe(text)
  })

  it('空图与空 handler', () => {
    const g = prog([{ id: 'a', kind: 'on', event: 'level.started' }], [])
    const text = generateScript(g)
    expect(text).toBe('on level.started {\n}\n')
    expect(generateScript(parseScript(text))).toBe(text)
  })
})

describe('golden：内置关卡迁移 → 脚本文本往返', () => {
  const SAMPLES: [string, unknown][] = [
    ['note-click', noteClickDoc],
    ['melody-dictation', melodyDictationDoc],
    ['timed-reaction', timedReactionDoc],
  ]

  for (const [name, raw] of SAMPLES) {
    it(`${name}：迁移产物文本化后往返恒等`, () => {
      const doc = raw as { content: { logic: LogicProgram } }
      const g = migrateLogicV1toV2(doc.content.logic)
      const text = generateScript(g)
      const g2 = parseScript(text, { variables: g.variables })
      // 文本级往返恒等
      expect(generateScript(g2)).toBe(text)
      // 结构规模保真（无 comment 节点时节点/边数量一致）
      expect(g.nodes.filter((n) => n.kind !== 'comment')).toHaveLength(g2.nodes.length)
      expect(g.edges).toHaveLength(g2.edges.length)
      // 事件处理器集合一致
      const events1 = g.nodes.filter((n) => n.kind === 'on').map((n) => (n as Extract<GNode, { kind: 'on' }>).event).sort()
      const events2 = g2.nodes.filter((n) => n.kind === 'on').map((n) => (n as Extract<GNode, { kind: 'on' }>).event).sort()
      expect(events2).toEqual(events1)
    })
  }
})
