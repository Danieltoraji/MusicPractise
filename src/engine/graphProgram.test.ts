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
    let prog = simple()
    prog = setGraphVariable(prog, 'i', 0)
    prog = addNode(prog, on('b1', 'app:tick'))
    prog = addNode(prog, { id: 'b2', kind: 'branch', cond: 'v.score >= 10' })
    prog = connect(prog, 'b1', 'b2')
    prog = addNode(prog, { id: 'w', kind: 'loop', mode: 'while', cond: 'v.i < 3' })
    prog = addNode(prog, assign('w2', 'score', 'v.score + 1'))
    prog = addNode(prog, { id: 'wt', kind: 'wait', ms: '500' })
    prog = addNode(prog, { id: 'em', kind: 'emit', event: 'app:burst', payload: { n: 'v.score' } })
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
