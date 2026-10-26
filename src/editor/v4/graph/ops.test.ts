/**
 * v4 图工作台纯函数操作测试：节点增删改 / 连线校验 / 拖拽坐标 / 变量声明 / 自动布局。
 * 重点覆盖 docs/53 §6/§7 端口协议与「恒返回新对象、无变化返回原引用」纪律。
 */
import { describe, expect, it } from 'vitest'
import type { FlowProgram } from '../../../engine/v4/model'
import { LOGIC_VERSION_V4 } from '../../../engine/v4/model'
import {
  addDeclaration,
  addNode,
  arrangeProgram,
  connectNodes,
  isDualPortKind,
  moveNode,
  newNodeId,
  portFromHandle,
  programDeclarations,
  removeDeclaration,
  removeEdge,
  removeNode,
  updateDeclaration,
  updateNode,
} from './ops'

function flow(): FlowProgram {
  return {
    logicVersion: LOGIC_VERSION_V4,
    kind: 'flow',
    nodes: [
      { id: 'start_1', kind: 'start', x: 0, y: 0 },
      { id: 'branch_1', kind: 'branch', cond: 'v.a == 1', x: 240, y: 0 },
      { id: 'call_1', kind: 'call', target: 'label1', method: 'setText', x: 480, y: 0 },
      { id: 'finish_1', kind: 'finish', x: 720, y: 0 },
    ],
    edges: [
      { id: 'edge_1', from: 'start_1', to: 'branch_1' },
      { id: 'edge_2', from: 'branch_1', to: 'call_1', port: 'true' },
      { id: 'edge_3', from: 'call_1', to: 'finish_1' },
    ],
    vars: [{ key: 'a', type: 'number', init: 0 }],
  }
}

describe('v4 图工作台 ops · 节点', () => {
  it('新增节点：id 程序化生成且不重复；不改原 program', () => {
    const program = flow()
    const id = newNodeId('comment', program.nodes.map((node) => node.id))
    expect(id).toMatch(/^comment_[a-z0-9]{8}$/)
    const next = addNode(program, { id, kind: 'comment', text: '说明' })
    expect(next.nodes).toHaveLength(program.nodes.length + 1)
    expect(program.nodes).toHaveLength(4)
    expect(next.nodes.at(-1)?.id).toBe(id)
  })

  it('修改节点：无变化返回入参引用；字段变化返回新对象且原对象不变', () => {
    const program = flow()
    expect(updateNode(program, 'branch_1', { cond: 'v.a == 1' })).toBe(program)
    const next = updateNode(program, 'branch_1', { cond: 'v.a == 2' })
    expect(next).not.toBe(program)
    expect((next.nodes[1] as { cond: string }).cond).toBe('v.a == 2')
    expect((program.nodes[1] as { cond: string }).cond).toBe('v.a == 1')
    expect(updateNode(program, 'nope', { cond: 'x' })).toBe(program)
  })

  it('删除节点级联删除关联边', () => {
    const next = removeNode(flow(), 'call_1')
    expect(next.nodes.map((node) => node.id)).toEqual(['start_1', 'branch_1', 'finish_1'])
    expect(next.edges.some((edge) => edge.from === 'call_1' || edge.to === 'call_1')).toBe(false)
  })

  it('拖拽落点写回 x/y（取整，未变化不产生新对象）', () => {
    const program = flow()
    expect(moveNode(program, 'start_1', 0, 0)).toBe(program)
    const next = moveNode(program, 'start_1', 12.6, -3.2)
    expect(next.nodes[0]).toMatchObject({ x: 13, y: -3 })
  })
})

describe('v4 图工作台 ops · 连线端口协议', () => {
  it('单出口节点：不允许指定 true/false 端口；双出口节点必须指定', () => {
    const program = flow()
    // 单出口 → 目标（正常）
    const connected = connectNodes(program, 'finish_1', 'branch_1')
    expect(connected.edges.at(-1)).toMatchObject({ from: 'finish_1', to: 'branch_1' })
    expect(connected.edges.at(-1)?.port).toBeUndefined()
    // 单出口带了端口 → 报错
    expect(() => connectNodes(program, 'finish_1', 'branch_1', 'true')).toThrow(/只有一个出口/)
    // 双出口不指定端口 → 报错
    const branchToFinish = removeEdge(connectNodes(program, 'branch_1', 'finish_1', 'false'), 'edge_2')
    expect(() => connectNodes(branchToFinish, 'branch_1', 'finish_1')).toThrow(/真\/假两个出口/)
  })

  it('拒绝自环 / 注释接线 / 入口入边 / 重复端口边', () => {
    const program = flow()
    expect(() => connectNodes(program, 'branch_1', 'branch_1', 'true')).toThrow(/自环/)
    const withComment = addNode(program, { id: 'comment_1', kind: 'comment', text: 'x' })
    expect(() => connectNodes(withComment, 'start_1', 'comment_1')).toThrow(/注释节点/)
    // 入口节点不能有入边：起点用 finish（有出边）
    expect(() => connectNodes(program, 'finish_1', 'start_1')).toThrow(/入口节点/)
    // branch 的 true 出口已有 edge_2，再连一条同端口 → 报错
    expect(() => connectNodes(program, 'branch_1', 'finish_1', 'true')).toThrow(/真（true）出口已经有一条连线/)
  })

  it('端口映射：undefined → 端口 undefined；删除边返回新对象', () => {
    expect(portFromHandle('out')).toBeUndefined()
    expect(portFromHandle(null)).toBeUndefined()
    expect(portFromHandle('true')).toBe('true')
    expect(portFromHandle('false')).toBe('false')
    const program = flow()
    expect(removeEdge(program, 'missing')).toBe(program)
    expect(removeEdge(program, 'edge_2').edges).toHaveLength(2)
    expect(isDualPortKind('foreach')).toBe(true)
    expect(isDualPortKind('ask')).toBe(false)
  })
})

describe('v4 图工作台 ops · 变量声明与布局', () => {
  it('新增变量声明：key 递增且不重复，类型/初值可改，可删除', () => {
    const program = flow()
    const added = addDeclaration(program)
    expect(added.key).toBe('var1')
    expect(programDeclarations(added.program)).toHaveLength(2)
    const typed = updateDeclaration(added.program, 'var1', { type: 'string', init: 'hi' })
    expect(programDeclarations(typed).at(-1)).toEqual({ key: 'var1', type: 'string', init: 'hi' })
    expect(updateDeclaration(typed, 'var1', { type: 'string', init: 'hi' })).toBe(typed)
    const removed = removeDeclaration(typed, 'var1')
    expect(programDeclarations(removed)).toHaveLength(1)
    expect(removeDeclaration(removed, 'missing')).toBe(removed)
  })

  it('behavior locals 走同一套声明操作', () => {
    const behavior = {
      logicVersion: LOGIC_VERSION_V4,
      kind: 'behavior' as const,
      nodes: [],
      edges: [],
      locals: [{ key: 'hits', type: 'number' as const, init: 0 }],
    }
    const added = addDeclaration(behavior)
    expect(added.key).toBe('local1')
    if (added.program.kind !== 'behavior') throw new Error('应为 behavior')
    expect(added.program.locals?.map((field) => field.key)).toEqual(['hits', 'local1'])
  })

  it('整理布局：missing 只补缺坐标节点；all 重排全部节点', () => {
    const program: FlowProgram = {
      logicVersion: LOGIC_VERSION_V4,
      kind: 'flow',
      nodes: [
        { id: 'start_1', kind: 'start', x: 10, y: 10 },
        { id: 'finish_1', kind: 'finish' },
      ],
      edges: [{ id: 'edge_1', from: 'start_1', to: 'finish_1' }],
    }
    const missing = arrangeProgram(program, 'missing')
    expect(missing.nodes[0]).toMatchObject({ x: 10, y: 10 })
    expect(missing.nodes[1].x).toBeTypeOf('number')
    expect(missing.nodes[1].y).toBeTypeOf('number')
    const all = arrangeProgram(program, 'all')
    expect(all.nodes[0].x).not.toBe(10)
    // 无坐标变化 → 返回入参引用
    expect(arrangeProgram(all, 'all')).toBe(all)
  })
})
