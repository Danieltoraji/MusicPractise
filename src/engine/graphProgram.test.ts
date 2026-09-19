import { describe, expect, it } from 'vitest'
import {
  addNode,
  blankGraphProgram,
  connect,
  disconnect,
  isGraphProgram,
  lintGraphProgram,
  lintGraphProgramDetailed,
  moveNode,
  newNodeId,
  removeGraphVariable,
  removeNode,
  renameGraphVariable,
  setGraphVariable,
  updateNode,
  type GraphProgram,
  type GNode,
} from './graphProgram'

function on(id: string, event: string): GNode {
  return { id, kind: 'on', event }
}
function call(id: string, target: string, method: string, args: string[] = []): GNode {
  return { id, kind: 'call', target, method, args }
}
function assign(id: string, target: string, expr: string): GNode {
  return { id, kind: 'assign', target, value: { expr } }
}

/** 构造：on(事件) → call → 结束 的最小程序 */
function simple(): GraphProgram {
  let prog = blankGraphProgram()
  prog = addNode(prog, on('a1', 'level.started'))
  prog = addNode(prog, call('a2', 'sound1', 'play', ['[{midi:60}]']))
  prog = connect(prog, 'a1', 'a2')
  return prog
}

describe('graphProgram 基础', () => {
  it('isGraphProgram 与 blankGraphProgram', () => {
    expect(isGraphProgram(blankGraphProgram())).toBe(true)
    expect(isGraphProgram({ logicVersion: 2, nodes: [], edges: [] })).toBe(true)
    expect(isGraphProgram({ logicVersion: 1, rules: [] })).toBe(false)
    expect(isGraphProgram(null)).toBe(false)
    expect(isGraphProgram({ logicVersion: 2, nodes: [] })).toBe(false)
  })

  it('newNodeId 去重', () => {
    const prog = simple()
    expect(newNodeId(prog)).toBe('n3')
    const withN3 = addNode(prog, { id: 'n3', kind: 'comment', text: '' })
    expect(newNodeId(withN3)).toBe('n4')
  })

  it('addNode 校验 id 与重复', () => {
    expect(() => addNode(blankGraphProgram(), on('bad-id', 'x:y'))).toThrow(/非法节点 id/)
    expect(() => addNode(simple(), on('a1', 'x:y'))).toThrow(/已存在/)
  })

  it('removeNode 级联删除关联边', () => {
    let prog = simple()
    prog = addNode(prog, assign('a3', 'score', 'v.score + 1'))
    prog = connect(prog, 'a2', 'a3')
    expect(prog.edges).toHaveLength(2)
    prog = removeNode(prog, 'a2')
    expect(prog.nodes.map((n) => n.id)).toEqual(['a1', 'a3'])
    expect(prog.edges.map((e) => e.to)).toEqual(['a2'].length ? [] : [])
    expect(prog.edges).toHaveLength(0)
  })

  it('updateNode / moveNode', () => {
    let prog = simple()
    prog = updateNode<Extract<GNode, { kind: 'call' }>>(prog, 'a2', { method: 'stop', args: [] })
    const node = prog.nodes.find((n) => n.id === 'a2')
    expect(node).toMatchObject({ kind: 'call', method: 'stop' })
    prog = moveNode(prog, 'a2', 120, 80)
    expect(prog.nodes.find((n) => n.id === 'a2')).toMatchObject({ x: 120, y: 80 })
    expect(() => updateNode<Extract<GNode, { kind: 'comment' }>>(prog, 'ghost', { text: '' })).toThrow(/不存在/)
  })
})

describe('graphProgram connect 校验', () => {
  it('branch/loop 必须带端口，其它节点禁止端口', () => {
    let prog = blankGraphProgram()
    prog = addNode(prog, on('e', 'level.started'))
    prog = addNode(prog, { id: 'b', kind: 'branch', cond: 'v.x > 0' })
    prog = addNode(prog, call('c1', 'label1', 'show', ['"a"']))
    prog = addNode(prog, call('c2', 'label1', 'show', ['"b"']))
    expect(() => connect(prog, 'b', 'c1')).toThrow(/端口/)
    prog = connect(prog, 'b', 'c1', 'true')
    prog = connect(prog, 'b', 'c2', 'false')
    expect(prog.edges).toHaveLength(2)
    expect(() => connect(prog, 'e', 'c1', 'true')).toThrow(/不接受端口/)
  })

  it('on 不能有入边；comment 作为直通节点可参与连线', () => {
    let prog = blankGraphProgram()
    prog = addNode(prog, on('e1', 'level.started'))
    prog = addNode(prog, on('e2', 'level.finished'))
    prog = addNode(prog, { id: 'cm', kind: 'comment', text: 'note' })
    prog = addNode(prog, call('c', 'label1', 'show'))
    expect(() => connect(prog, 'c', 'e2')).toThrow(/入边/)
    prog = connect(prog, 'e1', 'cm')
    prog = connect(prog, 'cm', 'c')
    expect(prog.edges).toHaveLength(2)
  })

  it('同一 (from, port) 重复连接替换旧边；非 on 节点允许自环', () => {
    let prog = blankGraphProgram()
    prog = addNode(prog, on('e', 'level.started'))
    prog = addNode(prog, call('c1', 'label1', 'show'))
    prog = addNode(prog, call('c2', 'label1', 'show'))
    prog = connect(prog, 'e', 'c1')
    prog = connect(prog, 'e', 'c2')
    expect(prog.edges).toHaveLength(1)
    expect(prog.edges[0].to).toBe('c2')
    const looped = connect(prog, 'c1', 'c1')
    expect(looped.edges.some((x) => x.from === 'c1' && x.to === 'c1')).toBe(true)
    // on 自环同样被「无入边」规则拦截
    expect(() => connect(prog, 'e', 'e')).toThrow(/入边/)
  })

  it('disconnect', () => {
    const prog = simple()
    const edgeId = prog.edges[0].id
    expect(disconnect(prog, edgeId).edges).toHaveLength(0)
  })
})

describe('graphProgram 变量操作', () => {
  it('set / rename（assign.target 同步）/ remove', () => {
    let prog = blankGraphProgram()
    prog = setGraphVariable(prog, 'score', 0)
    prog = addNode(prog, assign('s', 'score', 'v.score + 1'))
    prog = renameGraphVariable(prog, 'score', 'total')
    expect(prog.variables).toEqual({ total: 0 })
    expect((prog.nodes[0] as Extract<GNode, { kind: 'assign' }>).target).toBe('total')
    prog = removeGraphVariable(prog, 'total')
    expect(prog.variables).toEqual({})
    expect(() => setGraphVariable(prog, 'bad name', 1)).toThrow(/非法变量名/)
    expect(() => renameGraphVariable(prog, 'total', '9x')).toThrow(/非法变量名/)
  })

  it('rename 保留其它键与顺序；撞新名抛错', () => {
    let prog = blankGraphProgram()
    prog = setGraphVariable(prog, 'a', 1)
    prog = setGraphVariable(prog, 'b', 2)
    prog = renameGraphVariable(prog, 'a', 'c')
    expect(prog.variables).toEqual({ score: 0, c: 1, b: 2 })
    expect(() => renameGraphVariable(prog, 'b', 'c')).toThrow(/已存在/)
  })
})

describe('lintGraphProgram', () => {
  it('合法程序零错误', () => {
    let prog = simple() // a1(on level.started) -> a2(call sound1.play)
    prog = setGraphVariable(prog, 'i', 0)
    prog = addNode(prog, { id: 'w', kind: 'loop', mode: 'while', cond: 'v.i < 3' })
    prog = addNode(prog, assign('w2', 'score', 'v.score + 1'))
    prog = addNode(prog, { id: 'wt', kind: 'wait', ms: '500' })
    prog = addNode(prog, { id: 'em', kind: 'emit', event: 'app:burst', payload: { n: 'v.score' } })
    prog = addNode(prog, { id: 'cm', kind: 'comment', text: '链上注释' })
    prog = connect(prog, 'a2', 'cm')
    prog = connect(prog, 'cm', 'w')
    prog = connect(prog, 'w', 'w2', 'true')
    prog = connect(prog, 'w2', 'w') // 循环体回边
    prog = connect(prog, 'w', 'wt', 'false')
    prog = connect(prog, 'wt', 'em')
    expect(lintGraphProgram(prog, { componentIds: ['sound1'] })).toEqual([])
  })

  it('孤儿节点：非 on 且无入边报 structure（拖放引导）', () => {
    let prog = simple()
    prog = addNode(prog, call('lonely', 'label1', 'show'))
    const errors = lintGraphProgram(prog)
    expect(errors.some((x) => x.includes('没有任何入边') && x.includes('lonely'))).toBe(true)
  })

  it('孤儿链只报链头：A→B→C 均不可达时只报 A（防刷屏）', () => {
    let prog = simple()
    prog = addNode(prog, call('A', 'label1', 'show'))
    prog = addNode(prog, call('B', 'label1', 'show'))
    prog = addNode(prog, call('C', 'label1', 'show'))
    prog = connect(prog, 'A', 'B')
    prog = connect(prog, 'B', 'C')
    const orphanErrors = lintGraphProgram(prog).filter((x) => x.includes('没有任何入边') || x.includes('孤岛'))
    expect(orphanErrors).toHaveLength(1)
    expect(orphanErrors[0]).toContain('A')
    expect(orphanErrors[0]).not.toContain('B')
  })

  it('互连成环的孤岛合并为一条，自环单节点同样合并', () => {
    let prog = simple()
    prog = addNode(prog, call('X', 'label1', 'show'))
    prog = addNode(prog, call('Y', 'label1', 'show'))
    prog = connect(prog, 'X', 'Y')
    prog = connect(prog, 'Y', 'X') // X↔Y：都有入边但不可达 → 一个孤岛
    prog = addNode(prog, { id: 'S', kind: 'branch', cond: 'true' })
    prog = connect(prog, 'S', 'S', 'true') // 自环 → 另一个孤岛
    const islandErrors = lintGraphProgram(prog).filter((x) => x.includes('孤岛'))
    expect(islandErrors).toHaveLength(2)
    expect(islandErrors[0]).toContain('X')
    expect(islandErrors[0]).toContain('Y')
    expect(islandErrors[1]).toContain('S')
  })

  it('从 on 可达的链不报孤儿', () => {
    let prog = simple()
    prog = addNode(prog, { id: 'w', kind: 'wait', ms: '100' })
    prog = connect(prog, 'a2', 'w')
    expect(lintGraphProgram(prog, { componentIds: ['sound1'] })).toEqual([])
  })

  it('表达式语法错误 / 未声明变量 / while 缺 cond', () => {
    let prog = blankGraphProgram()
    prog = setGraphVariable(prog, 'score', 0)
    prog = addNode(prog, on('e', 'level.started'))
    prog = addNode(prog, assign('a', 'score', '1 +'))
    prog = addNode(prog, assign('a2', 'ghost', 'v.ghost + 1'))
    prog = addNode(prog, { id: 'w', kind: 'loop', mode: 'while' })
    const errors = lintGraphProgram(prog)
    expect(errors.some((x) => x.includes('节点 a(assign) value.expr:'))).toBe(true)
    expect(errors.some((x) => x.includes('赋值未声明变量 "ghost"'))).toBe(true)
    expect(errors.some((x) => x.includes('表达式引用未声明变量 "ghost"'))).toBe(true)
    expect(errors.some((x) => x.includes('cond 缺失（while 需要 cond）'))).toBe(true)
  })

  it('结构化 lint：端口协议 / 重复出边 / 未知类型 / 边字段定位', () => {
    // branch 带无端口出边 + 同端口重复出边
    const prog: GraphProgram = {
      logicVersion: 2,
      variables: {},
      nodes: [
        { id: 'e', kind: 'on', event: 'level.started' },
        { id: 'b', kind: 'branch', cond: 'true' },
        { id: 'c', kind: 'call', target: 'level', method: 'next', args: [] },
      ],
      edges: [
        { id: 'e1', from: 'e', to: 'b' },
        { id: 'e2', from: 'b', to: 'c' }, // branch 无端口出边 → port 错误
        { id: 'e3', from: 'b', to: 'c', port: 'true' },
        { id: 'e4', from: 'b', to: 'c', port: 'true' }, // 重复
      ],
    }
    const issues = lintGraphProgramDetailed(prog)
    expect(issues.some((x) => x.code === 'port' && x.edgeId === 'e2')).toBe(true)
    expect(issues.some((x) => x.code === 'duplicate-edge' && x.edgeId === 'e4')).toBe(true)
    expect(issues.every((x) => x.nodeId !== undefined || x.edgeId !== undefined)).toBe(true)

    // 未知类型节点
    const bad: GraphProgram = {
      logicVersion: 2,
      nodes: [{ id: 'x', kind: 'bogus' } as unknown as GNode],
      edges: [],
    }
    const badIssues = lintGraphProgramDetailed(bad)
    expect(badIssues.some((x) => x.code === 'unknown-kind' && x.nodeId === 'x')).toBe(true)
  })

  it('on 入边 / 非法事件名 / emit 格式 / level 方法白名单 / 悬空实例', () => {
    // on 被连入的情况绕过 connect 直接构造（模拟导入/手写 JSON）
    const prog: GraphProgram = {
      ...simple(),
      nodes: [
        ...simple().nodes,
        on('bad', 'noDot'),
        { id: 'em', kind: 'emit', event: 'level.started' },
        call('lv', 'level', 'explode'),
        call('ghost', 'nosuch', 'show'),
      ],
      edges: [...simple().edges, { id: 'eX', from: 'a2', to: 'a1' }],
    }
    const errors = lintGraphProgram(prog, { componentIds: ['sound1'] })
    expect(errors.some((x) => x.includes('入边'))).toBe(true)
    expect(errors.some((x) => x.includes('非法事件名 "noDot"'))).toBe(true)
    expect(errors.some((x) => x.includes('emit 只能触发内部事件'))).toBe(true)
    expect(errors.some((x) => x.includes('level 没有 "explode"'))).toBe(true)
    expect(errors.some((x) => x.includes('不存在的实例 "nosuch"'))).toBe(true)
  })

  it('emit 触发环检测', () => {
    let prog = blankGraphProgram()
    prog = addNode(prog, on('e1', 'app:a'))
    prog = addNode(prog, { id: 'm1', kind: 'emit', event: 'app:b' })
    prog = connect(prog, 'e1', 'm1')
    prog = addNode(prog, on('e2', 'app:b'))
    prog = addNode(prog, { id: 'm2', kind: 'emit', event: 'app:a' })
    prog = connect(prog, 'e2', 'm2')
    const errors = lintGraphProgram(prog)
    expect(errors.some((x) => x.startsWith('emit 触发环'))).toBe(true)
  })

  it('边悬挂与节点 id 重复', () => {
    const prog: GraphProgram = {
      logicVersion: 2,
      variables: {},
      nodes: [on('x1', 'app:loop'), on('x1', 'app:loop2')],
      edges: [{ id: 'e1', from: 'ghost', to: 'x1' }],
    }
    const errors = lintGraphProgram(prog)
    expect(errors.some((x) => x.includes('id 重复'))).toBe(true)
    expect(errors.some((x) => x.includes('起点节点不存在'))).toBe(true)
  })
})

describe('views.goto lint（docs/24）', () => {
  const base = (): GraphProgram => {
    let prog = blankGraphProgram()
    prog = addNode(prog, on('e', 'level.started'))
    return prog
  }

  it('字符串字面量：存在性校验（dangling-ref）', () => {
    let prog = base()
    prog = addNode(prog, call('g1', 'views', 'goto', ['"main"']))
    prog = connect(prog, 'e', 'g1') // 连线避免孤儿告警干扰断言
    expect(lintGraphProgram(prog, { viewIds: ['main'] })).toEqual([])
    const bad = addNode(prog, call('g2', 'views', 'goto', ['"ghost"']))
    const issues = lintGraphProgramDetailed(bad, { viewIds: ['main'] })
    expect(issues.some((i) => i.code === 'dangling-ref' && i.message.includes('ghost'))).toBe(true)
  })

  it('对象字面量 {id: "…"}：合法并同样校验存在性', () => {
    let prog = base()
    prog = addNode(prog, call('g1', 'views', 'goto', ["{id: 'step1'}"]))
    prog = connect(prog, 'e', 'g1')
    expect(lintGraphProgram(prog, { viewIds: ['step1'] })).toEqual([])
    expect(lintGraphProgramDetailed(prog, { viewIds: ['other'] }).some((i) => i.code === 'dangling-ref')).toBe(true)
  })

  it('缺参/动态表达式：structure 提示（运行时合法性不保证，注释见实现）', () => {
    let prog = base()
    prog = addNode(prog, call('g1', 'views', 'goto', ['v.target']))
    prog = addNode(prog, call('g2', 'views', 'goto', []))
    const issues = lintGraphProgramDetailed(prog, { viewIds: ['main'] })
    expect(issues.filter((i) => i.code === 'structure').length).toBeGreaterThanOrEqual(2)
  })

  it('views 伪实例方法白名单：goto 之外拒绝', () => {
    let prog = base()
    prog = addNode(prog, call('g1', 'views', 'back', []))
    const issues = lintGraphProgramDetailed(prog, { viewIds: ['main'] })
    expect(issues.some((i) => i.code === 'dangling-ref' && i.message.includes('views 没有 "back"'))).toBe(true)
  })
})
