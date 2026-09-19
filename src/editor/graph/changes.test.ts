import { describe, expect, it } from 'vitest'
import { applyNodeChangesToProgram, portFromHandle } from './changes'
import { addNode, blankGraphProgram, connect, type GraphProgram } from '../../engine/graphProgram'
import { moveNode as gMove, removeNode as gRemove } from '../../engine/graphProgram'

const ops = { moveNode: gMove, removeNode: gRemove }

function fixture(): GraphProgram {
  let prog = blankGraphProgram()
  prog = addNode(prog, { id: 'a', kind: 'on', event: 'level.started' })
  prog = addNode(prog, { id: 'b', kind: 'comment', text: 'x' })
  prog = addNode(prog, { id: 'c', kind: 'comment', text: 'y' })
  prog = connect(prog, 'a', 'b')
  prog = connect(prog, 'b', 'c')
  return prog
}

describe('portFromHandle', () => {
  it('真/假出口映射端口，其余（out/空）无端口', () => {
    expect(portFromHandle('true')).toBe('true')
    expect(portFromHandle('false')).toBe('false')
    expect(portFromHandle('out')).toBeUndefined()
    expect(portFromHandle(null)).toBeUndefined()
    expect(portFromHandle(undefined)).toBeUndefined()
  })
})

describe('applyNodeChangesToProgram（变更 reducer）', () => {
  it('拖动中间帧（dragging:true）忽略；落点（dragging:false）写回位置', () => {
    const prog = fixture()
    const afterDragFrame = applyNodeChangesToProgram(
      prog,
      [{ type: 'position', id: 'a', dragging: true, position: { x: 999, y: 999 } }],
      ops,
    )
    expect(afterDragFrame.nodes.find((n) => n.id === 'a')?.x).toBeUndefined()

    const settled = applyNodeChangesToProgram(
      afterDragFrame,
      [{ type: 'position', id: 'a', dragging: false, position: { x: 120, y: 80 } }],
      ops,
    )
    expect(settled.nodes.find((n) => n.id === 'a')).toMatchObject({ x: 120, y: 80 })
  })

  it('remove 级联删除关联边', () => {
    const prog = fixture()
    const next = applyNodeChangesToProgram(prog, [{ type: 'remove', id: 'b' }], ops)
    expect(next.nodes.map((n) => n.id)).toEqual(['a', 'c'])
    expect(next.edges).toHaveLength(0)
  })

  it('批量 change 单基线累积（评审 P1-2 回归锚）', () => {
    const prog = fixture()
    // 一批：两个删除——若每条独立应用（以过期基线起点），第二条会静默丢失
    const next = applyNodeChangesToProgram(
      prog,
      [
        { type: 'remove', id: 'b' },
        { type: 'remove', id: 'c' },
      ],
      ops,
    )
    expect(next.nodes.map((n) => n.id)).toEqual(['a'])
    expect(next.edges).toHaveLength(0)
  })

  it('dimensions/select/add 变更安全忽略', () => {
    const prog = fixture()
    const next = applyNodeChangesToProgram(
      prog,
      [
        { type: 'dimensions', id: 'a' },
        { type: 'select', id: 'b' },
        { type: 'add', id: 'zz' },
      ],
      ops,
    )
    expect(next).toBe(prog)
  })
})
