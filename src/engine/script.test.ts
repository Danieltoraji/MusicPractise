import { describe, expect, it } from 'vitest'
import { connect, type GEdge, type GNode, type GraphProgram } from './graphProgram'
import { migrateLogicV1toV2 } from './migrate'
import { generateScript, mergeScriptAnchors, parseScript, ScriptError } from './script'
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

  it('结构化汇合：两分支汇到公共后继 = if/else 后顺序语句；循环体掉出抛错', () => {
    // 菱形汇合（c1/c2 都连 t）= if/else 之后的顺序语句，合法
    const g = linked(
      [
        { id: 'a', kind: 'on', event: 'level.started' },
        { id: 'br', kind: 'branch', cond: 'v.x' },
        { id: 'c1', kind: 'call', target: 'l', method: 'show', args: [] },
        { id: 'c2', kind: 'call', target: 'l', method: 'hide', args: [] },
        { id: 't', kind: 'call', target: 'l', method: 'off', args: [] },
      ],
      [['a', 'br'], ['br', 'c1', 'true'], ['br', 'c2', 'false'], ['c1', 't'], ['c2', 't']],
    )
    expect(generateScript(g)).toBe(
      ['on level.started {', '  if (v.x) {', '    l.show()', '  } else {', '    l.hide()', '  }', '  l.off()', '}', ''].join('\n'),
    )

    // 循环体末尾连到循环后继（跳出）——伪代码无法表达
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

    // 非结构化汇合：两分支各自跳回分支前已渲染的节点
    const g3 = linked(
      [
        { id: 'a', kind: 'on', event: 'level.started' },
        { id: 'p', kind: 'call', target: 'l', method: 'show', args: [] },
        { id: 'br', kind: 'branch', cond: 'v.x' },
        { id: 'c1', kind: 'call', target: 'l', method: 'hide', args: [] },
        { id: 'c2', kind: 'call', target: 'l', method: 'off', args: [] },
      ],
      [['a', 'p'], ['p', 'br'], ['br', 'c1', 'true'], ['br', 'c2', 'false'], ['c1', 'p'], ['c2', 'p']],
    )
    expect(() => generateScript(g3)).toThrow(/汇入|汇合/)
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

describe('P0 回归：块内 if/loop 的顺序后继（端口协议）', () => {
  it('if（无 else）后的语句挂在 branch 的 false 出口', () => {
    const g = parseScript('on app:e {\n  if (v.c) {\n    v.a = 1\n  }\n  v.b = 2\n}')
    const branch = g.nodes.find((n) => n.kind === 'branch') as Extract<GNode, { kind: 'branch' }>
    const assignB = g.nodes.find((n) => n.kind === 'assign' && (n as Extract<GNode, { kind: 'assign' }>).target === 'b')!
    expect(g.edges).toContainEqual(expect.objectContaining({ from: branch.id, to: assignB.id, port: 'false' }))
    // 文本往返
    const text = generateScript(g)
    expect(generateScript(parseScript(text, { variables: g.variables }))).toBe(text)
    expect(text).toContain('v.b = 2')
  })

  it('while 后的语句挂在 loop 的 false 出口；嵌套循环往返', () => {
    const text = ['on app:e {', '  while (v.a) {', '    while (v.b) {', '      v.j = v.j + 1', '    }', '  }', '  v.k = 2', '}'].join('\n')
    const g = parseScript(text)
    const loops = g.nodes.filter((n) => n.kind === 'loop')
    expect(loops).toHaveLength(2)
    // 外层 loop 的 false 出口连到 v.k 赋值
    const assignK = g.nodes.find((n) => n.kind === 'assign' && (n as Extract<GNode, { kind: 'assign' }>).target === 'k')!
    const outer = loops.find((l) => (l as Extract<GNode, { kind: 'loop' }>).cond === 'v.a')!
    expect(g.edges).toContainEqual(expect.objectContaining({ from: outer.id, to: assignK.id, port: 'false' }))
    // 往返恒等（嵌套循环 + 循环后语句）
    expect(generateScript(parseScript(text, { variables: g.variables }))).toBe(generateScript(g))
  })

  it('对象字面量赋值（含嵌套）解析与往返', () => {
    const text = 'on app:e {\n  v.o = {a: 1, b: {c: 2}}\n  v.n = len(v.o)\n}'
    const g = parseScript(text, { variables: { o: {}, n: 0 } })
    const assign = g.nodes.find((n) => n.kind === 'assign') as Extract<GNode, { kind: 'assign' }>
    expect(assign.value).toEqual({ expr: '{a: 1, b: {c: 2}}' })
    expect(generateScript(parseScript(text, { variables: g.variables }))).toBe(generateScript(g))
  })

  it('行首注释提升为 comment 节点并参与往返', () => {
    const text = 'on app:e {\n  // 递增计数\n  v.i = v.i + 1\n}'
    const g = parseScript(text, { variables: { i: 0 } })
    const comments = g.nodes.filter((n) => n.kind === 'comment')
    expect(comments).toHaveLength(1)
    expect((comments[0] as Extract<GNode, { kind: 'comment' }>).text).toBe('递增计数')
    // comment 节点在链上：往返后注释仍在
    const text2 = generateScript(g)
    expect(text2).toContain('// 递增计数')
    expect(generateScript(parseScript(text2, { variables: g.variables }))).toBe(text2)
  })

  it('多段事件名（a.b.c）与空参数报错', () => {
    const g = parseScript('on a.b.c {\n  v.i = 1\n}')
    const on = g.nodes.find((n) => n.kind === 'on') as Extract<GNode, { kind: 'on' }>
    expect(on.event).toBe('a.b.c')
    expect(() => parseScript('on app:e {\n  label1.show(, 1)\n}')).toThrow(/空参数/)
  })
})

describe('mergeScriptAnchors（docs/40 E1 + docs/42 返工：安全锚点合并）', () => {
  const baseProg = () => ({
    logicVersion: 2 as const,
    variables: { score: 0 } as Record<string, unknown>,
    nodes: [
      { id: 'on1', kind: 'on', event: 'level.started', x: 40, y: 80 },
      { id: 'c1', kind: 'call', target: 'sound1', method: 'play', args: ["'x'"], x: 200, y: 80 },
      { id: 'a1', kind: 'assign', target: 'score', value: { expr: 'v.score + 1' }, x: 360, y: 80 },
    ],
    edges: [
      { id: 'e1', from: 'on1', to: 'c1' },
      { id: 'e2', from: 'c1', to: 'a1' },
    ],
  }) as never as Parameters<typeof mergeScriptAnchors>[1]

  /** 合并结果自洽：id 唯一、无悬空边/自环、无 undefined 自有属性（JSON 往返严格相等） */
  function assertSane(prog: GraphProgram): void {
    const ids = prog.nodes.map((n) => n.id)
    expect(new Set(ids).size).toBe(ids.length)
    const idSet = new Set(ids)
    for (const e of prog.edges) {
      expect(idSet.has(e.from)).toBe(true)
      expect(idSet.has(e.to)).toBe(true)
      expect(e.from).not.toBe(e.to)
    }
    expect(JSON.parse(JSON.stringify(prog))).toStrictEqual(prog)
  }

  it('未改动往返：全部节点保 id/x/y，unmatched=0', () => {
    const prev = baseProg()
    const text = generateScript(prev)
    const next = parseScript(text, { variables: prev.variables })
    const { prog, kept, unmatched, dropped } = mergeScriptAnchors(next, prev)
    expect(kept).toBe(3)
    expect(unmatched).toBe(0)
    expect(dropped).toBe(0)
    expect(prog.nodes.map((n) => n.id)).toEqual(['on1', 'c1', 'a1'])
    expect(prog.nodes.find((n) => n.id === 'c1')?.x).toBe(200)
    expect(prog.nodes.find((n) => n.id === 'a1')?.y).toBe(80)
    assertSane(prog)
  })

  it('E1-a：旧节点无坐标时不写 x/y 自有属性（否则 cfworker 校验抛 undefined）', () => {
    // 迁移旧关/组件库新建的图没有 x/y：脚本原样应用也必须可保存
    const prev = parseScript('on level.started {\n  v.score = 1\n}', { variables: { score: 0 } })
    expect(prev.nodes.every((n) => !('x' in n) && !('y' in n))).toBe(true)
    const next = parseScript(generateScript(prev), { variables: prev.variables })
    const { prog, kept, unmatched, dropped } = mergeScriptAnchors(next, prev)
    expect(kept).toBe(prev.nodes.length)
    expect(unmatched).toBe(0)
    expect(dropped).toBe(0)
    for (const n of prog.nodes) {
      expect(Object.prototype.hasOwnProperty.call(n, 'x')).toBe(false)
      expect(Object.prototype.hasOwnProperty.call(n, 'y')).toBe(false)
    }
    // JSON 往返严格相等 = 没有任何 undefined 自有属性（JSON.stringify 会丢弃它们）
    assertSane(prog)
  })

  it('E1-b：s 前缀旧图二次应用（重排+插入+删除）→ id 唯一、无自环/悬空边', () => {
    const text1 = ['on level.started {', '  v.a = 1', '  v.b = 2', '  v.c = 3', '}'].join('\n')
    const p1 = parseScript(text1, { variables: { a: 0, b: 0, c: 0 } })
    const prev = { ...p1, nodes: p1.nodes.map((n, i) => ({ ...n, x: 40 + i * 120, y: 60 })) }
    // 第二次编辑：重排 + 插入 v.x = 9 + 删除 v.c = 3。parse id 是 s1..s4，与旧图 s 前缀 id 撞车
    const text2 = ['on level.started {', '  v.b = 2', '  v.x = 9', '  v.a = 1', '}'].join('\n')
    const p2 = parseScript(text2, { variables: prev.variables })
    const { prog, unmatched, dropped } = mergeScriptAnchors(p2, prev)
    expect(unmatched).toBe(1)
    expect(dropped).toBe(0)
    // 撞车的改写节点必须改用唯一 id（s3 已被映射给 v.b = 2）
    expect(prog.nodes.map((n) => n.id)).toContain('s3_2')
    const xAssign = prog.nodes.find((n) => n.kind === 'assign' && n.target === 'x')!
    expect(xAssign.id).toBe('s3_2')
    expect(Object.prototype.hasOwnProperty.call(xAssign, 'x')).toBe(false)
    // 配对成功的节点仍继承旧坐标
    const bPrev = prev.nodes.find((n) => n.kind === 'assign' && n.target === 'b')!
    const bAssign = prog.nodes.find((n) => n.kind === 'assign' && n.target === 'b')!
    expect(bAssign.x).toBe(bPrev.x)
    expect(bAssign.y).toBe(bPrev.y)
    // 边端点同步改写：b→x 的边终点是 s3_2，不再指向被映射的 s3
    const bToX = prog.edges.find((e) => e.from === bAssign.id && e.to === xAssign.id)
    expect(bToX).toBeTruthy()
    assertSane(prog)
  })

  it('重复语句/多入口：同特征按出现序配对，不共享 id；改写只影响对应语句', () => {
    const text = ['on level.started {', '  v.score = 1', '  v.score = 1', '}', 'on app:tick {', '  v.score = 2', '}'].join('\n')
    const p1 = parseScript(text, { variables: { score: 0 } })
    const prev = { ...p1, nodes: p1.nodes.map((n, i) => ({ ...n, x: 40 + i * 100, y: 20 })) }
    const p2 = parseScript(generateScript(prev), { variables: prev.variables })
    const same = mergeScriptAnchors(p2, prev)
    expect(same.kept).toBe(prev.nodes.length)
    expect(same.unmatched).toBe(0)
    expect(same.dropped).toBe(0)
    expect([...same.prog.nodes.map((n) => n.id)].sort()).toEqual([...prev.nodes.map((n) => n.id)].sort())
    assertSane(same.prog)

    // 只改第二个入口的表达式：其余节点（含重复语句）仍配对，唯一改写语句拿新 id
    const p3 = parseScript(generateScript(prev).replace('v.score = 2', 'v.score = 3'), { variables: prev.variables })
    const changed = mergeScriptAnchors(p3, prev)
    expect(changed.unmatched).toBe(1)
    expect(changed.prog.nodes.filter((n) => n.id === 's2')).toHaveLength(1)
    assertSane(changed.prog)
  })

  it('改一行表达式：其余节点保 id/x/y，被改写节点拿新 id；id 替换同步边端点', () => {
    const prev = baseProg()
    // 改 a1 的表达式 → 其特征串变化 → 新 id；on1/c1 保留
    const text = generateScript(prev).replace('v.score + 1', 'v.score + 5')
    const next = parseScript(text, { variables: prev.variables })
    const { prog, kept, unmatched } = mergeScriptAnchors(next, prev)
    expect(kept).toBe(2)
    expect(prog.nodes.find((n) => n.id === 'on1')).toBeTruthy()
    expect(prog.nodes.find((n) => n.id === 'c1')?.x).toBe(200)
    const assign = prog.nodes.find((n) => n.kind === 'assign')!
    expect(assign.id).not.toBe('a1') // 语义变了：新 id（旧 id 不再悬挂在新语句上）
    expect(assign.value).toEqual({ expr: 'v.score + 5' })
    expect(unmatched).toBe(1)
    // 边端点已映射回旧 id
    expect(prog.edges.some((e) => e.from === 'c1' && e.to === assign.id)).toBe(true)
    assertSane(prog)
  })

  it('不可达节点计入 dropped；边与坐标不影响特征匹配', () => {
    const prev = baseProg()
    const withDangling = {
      ...prev,
      nodes: [...prev.nodes, { id: 'orphan', kind: 'wait', ms: '500' }],
    } as never as Parameters<typeof mergeScriptAnchors>[1]
    const text = generateScript(prev)
    const next = parseScript(text, { variables: prev.variables })
    const { prog, dropped } = mergeScriptAnchors(next, withDangling)
    expect(dropped).toBe(1)
    expect(prog.nodes.some((n) => n.id === 'orphan')).toBe(false)
    assertSane(prog)
  })

  it('防御性自检：已损坏的输入（重复 id / 悬空边 / 自环）合并时抛错而非静默入库', () => {
    const empty = prog([], [])
    const dupIds = prog(
      [
        { id: 'x', kind: 'on', event: 'level.started' },
        { id: 'x', kind: 'assign', target: 'score', value: { expr: '1' } },
      ],
      [],
    )
    expect(() => mergeScriptAnchors(dupIds, empty)).toThrow(/结构自检失败.*重复/)

    const dangling = prog([{ id: 'a', kind: 'on', event: 'level.started' }], [{ id: 'e1', from: 'a', to: 'ghost' }])
    expect(() => mergeScriptAnchors(dangling, empty)).toThrow(/结构自检失败.*端点不存在/)

    const selfLoop = prog([{ id: 'a', kind: 'on', event: 'level.started' }], [{ id: 'e1', from: 'a', to: 'a' }])
    expect(() => mergeScriptAnchors(selfLoop, empty)).toThrow(/结构自检失败.*自环/)
  })

  it('prev 也是脚本产物（s 前缀同 id 场景）往返安全', () => {
    const text1 = 'on level.started {\n  v.score = 1\n  v.score = 2\n}'
    const p1 = parseScript(text1, { variables: { score: 0 } })
    const p1x = { ...p1, nodes: p1.nodes.map((n, i) => ({ ...n, x: i * 100, y: 50 })) }
    const text2 = generateScript(p1x).replace('v.score = 2', 'v.score = 3')
    const p2 = parseScript(text2, { variables: p1x.variables })
    const { prog } = mergeScriptAnchors(p2, p1x)
    // 未改动的第一个语句节点保 id+坐标（值是 p2 重新解析的新对象，按 id 断言）；改动的第二个节点新 id
    const assigns = prog.nodes.filter((n) => n.kind === 'assign')
    expect(assigns).toHaveLength(2)
    expect(assigns[0].id).toBe(p1x.nodes[1].id)
    expect(assigns[0].x).toBe(p1x.nodes[1].x)
    expect(assigns[0].value).toEqual({ expr: '1' })
    // 改动的语句 unmatched：不继承坐标（走 dagre 兜底布局）
    expect(assigns[1].x).toBeUndefined()
    expect(Object.prototype.hasOwnProperty.call(assigns[1], 'x')).toBe(false)
    expect(assigns[1].value).toEqual({ expr: '3' })
    assertSane(prog)
  })
})
