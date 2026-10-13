import { beforeEach, describe, expect, it } from 'vitest'
import { blankLevelDoc, setTable } from '../editor/docState'
import type { LevelDoc } from '../engine/level'
import { clearCheckpoint, getCheckpoint, saveCheckpoint } from './checkpoint'

beforeEach(() => {
  clearCheckpoint('res_cp')
})

describe('AI 修改检查点', () => {
  it('保存→读取返回深拷贝；外部修改不影响快照', () => {
    const doc = blankLevelDoc()
    saveCheckpoint('res_cp', doc)
    doc.content.components.push({ id: 'x1', type: 'button' } as never)
    const cp = getCheckpoint('res_cp')!
    expect(cp.doc.content.components).toHaveLength(0)
    expect(cp.at).toBeGreaterThan(0)
  })

  it('按 doc.id 隔离；未保存返回 null；清除后返回 null', () => {
    expect(getCheckpoint('res_cp')).toBeNull()
    saveCheckpoint('res_cp', blankLevelDoc())
    expect(getCheckpoint('res_other')).toBeNull()
    clearCheckpoint('res_cp')
    expect(getCheckpoint('res_cp')).toBeNull()
  })

  it('重复保存覆盖（单级撤销语义）', () => {
    saveCheckpoint('res_cp', blankLevelDoc())
    const doc2 = blankLevelDoc()
    doc2.meta.title = '第二版'
    saveCheckpoint('res_cp', doc2)
    expect(getCheckpoint('res_cp')!.doc.meta.title).toBe('第二版')
  })
})

/** tools-write 的通用夹具：可变 doc 宿主 + 记录 applyDoc 调用 */
function harness(doc: LevelDoc) {
  const applied: LevelDoc[] = []
  const ctx = {
    getDoc: () => doc,
    applyDoc: (next: LevelDoc) => {
      doc = next
      applied.push(next)
    },
    levelId: doc.id,
  }
  return { ctx, current: () => doc, applied }
}

async function run(name: string, args: Record<string, unknown>, doc: LevelDoc) {
  const { WRITE_TOOLS } = await import('./tools-write')
  const tool = WRITE_TOOLS.find((t) => t.name === name)!
  if (!tool) throw new Error(`没有工具 ${name}`)
  const h = harness(doc)
  const result = (await tool.exec(args, h.ctx)) as string
  return { result, h }
}

describe('AI 写入工具（批次2a）', () => {
  let doc: LevelDoc
  beforeEach(() => {
    doc = setTable(blankLevelDoc(), {
      columns: [
        { key: 'title', label: '题面', type: 'text' },
        { key: 'scoring', label: '分值', type: 'number' },
      ],
      rows: [{ title: '第1题', scoring: 10 }],
    })
    doc.content.components.push({ id: 'b1', type: 'button', view: 'main' } as never)
  })

  it('write_script：合法伪代码全文替换逻辑（变量保留、节点重建）', async () => {
    const { result, h } = await run('write_script', { script: 'on b1.clicked {\n  v.score = v.score + 5\n}' }, doc)
    expect(result).toContain('✓')
    expect(h.applied).toHaveLength(1)
    expect(h.current().content.logic.nodes.some((n) => n.kind === 'on' && n.event === 'b1.clicked')).toBe(true)
    expect(h.current().content.logic.variables).toEqual({ score: 0 })
  })

  it('write_script：事件名非法/语法错误回喂行列号且不应用', async () => {
    const badEvent = await run('write_script', { script: 'on bad {\n  v.x = 1\n}' }, doc)
    expect(badEvent.result).toContain('解析失败')
    expect(badEvent.result).toMatch(/第 1 行/)
    expect(badEvent.h.applied).toHaveLength(0)

    const badExpr = await run('write_script', { script: 'on b1.clicked {\n  v.x = \n}' }, doc)
    expect(badExpr.result).toContain('解析失败')
    expect(badExpr.result).toMatch(/第 2 行/)
    expect(badExpr.h.current().content.logic).toBe(doc.content.logic)
  })

  it('edit_table：add_rows 校验未知列并回喂合法列；合法行追加成功', async () => {
    const bad = await run('edit_table', { op: 'add_rows', rows: [{ nosuch: 1 }] }, doc)
    expect(bad.result).toContain('不存在的列')
    expect(bad.result).toContain('title')
    expect(bad.h.applied).toHaveLength(0)

    const ok = await run('edit_table', { op: 'add_rows', rows: [{ title: '第2题', scoring: 5 }, { title: '第3题', scoring: 8 }] }, doc)
    expect(ok.result).toContain('✓')
    expect(ok.h.current().content.table.rows).toHaveLength(3)
    expect(ok.h.current().content.table.rows[1]).toEqual({ title: '第2题', scoring: 5 })
  })

  it('edit_table：update_cell / set_column_type / add_column', async () => {
    const up = await run('edit_table', { op: 'update_cell', row: 0, patch: { scoring: 20 } }, doc)
    expect(up.result).toContain('✓')
    expect(up.h.current().content.table.rows[0].scoring).toBe(20)

    const badType = await run('edit_table', { op: 'set_column_type', key: 'scoring', type: 'weird' }, doc)
    expect(badType.result).toContain('未知列类型')

    const col = await run('edit_table', { op: 'add_column', key: 'hints', label: '提示', type: 'list' }, doc)
    expect(col.result).toContain('✓')
    const cols = col.h.current().content.table.columns
    expect(cols.find((c) => c.key === 'hints')).toMatchObject({ type: 'list', label: '提示' })
    // 新列在既有行中补 null
    expect(col.h.current().content.table.rows[0]!.hints).toBeNull()
  })

  it('edit_components：add 自动命名并回传新 id；未知类型拒绝', async () => {
    const bad = await run('edit_components', { op: 'add', type: 'robot' }, doc)
    expect(bad.result).toContain('未知组件类型')
    expect(bad.result).toContain('button')

    const ok = await run('edit_components', { op: 'add', type: 'button', name: '确认', props: { text: '确定' } }, doc)
    expect(ok.result).toMatch(/组件已添加：button\d/)
    expect(ok.h.current().content.components.some((c) => c.name === '确认')).toBe(true)
  })

  it('edit_components：update/remove 校验实例存在', async () => {
    const ghost = await run('edit_components', { op: 'remove', id: 'ghost1' }, doc)
    expect(ghost.result).toContain('不存在')
    const ok = await run('edit_components', { op: 'update', id: 'b1', patch: { visible: false } }, doc)
    expect(ok.result).toContain('✓')
    expect(ok.h.current().content.components.find((c) => c.id === 'b1')?.visible).toBe(false)
  })

  it('set_variable：set/rename/remove；系统变量与非法名拒绝', async () => {
    const set = await run('set_variable', { op: 'set', name: 'lives', value: 3 }, doc)
    expect(set.result).toContain('lives')
    expect(set.h.current().content.logic.variables?.lives).toBe(3)

    const sys = await run('set_variable', { op: 'set', name: '__row', value: 0 }, doc)
    expect(sys.result).toContain('系统变量')

    // 链式：在 set 之后的状态上 rename（harness 的 doc 已随 applyDoc 前进）
    const ren = await run('set_variable', { op: 'rename', name: 'lives', newName: 'hp' }, set.h.current())
    expect(ren.result).toContain('✓')
    expect(ren.h.current().content.logic.variables?.hp).toBe(3)
    expect(ren.h.current().content.logic.variables?.lives).toBeUndefined()

    const miss = await run('set_variable', { op: 'remove', name: 'nope' }, doc)
    expect(miss.result).toContain('不存在')
  })

  it('edit_flow / edit_views / edit_meta', async () => {
    const flow = await run('edit_flow', { order: 'shuffle', count: 5, pass: 'v.score >= 60' }, doc)
    expect(flow.result).toContain('✓')
    expect(flow.h.current().content.flow).toMatchObject({ order: 'shuffle', count: 5, pass: { expr: 'v.score >= 60' } })

    const view = await run('edit_views', { op: 'add', name: '结算页' }, doc)
    expect(view.result).toMatch(/新视图 id=view\d/)
    expect(view.h.current().content.views).toHaveLength(2)

    // 单视图关卡：删除被守卫拒绝
    const lastView = await run('edit_views', { op: 'remove', id: 'main' }, doc)
    expect(lastView.result).toContain('至少保留一个视图')

    // 清除过关条件（空串语义）：flow.pass 键被删除而非存 null（null 过不了 Ajv，曾致无法保存）
    const cleared = await run('edit_flow', { pass: '' }, doc)
    expect(cleared.result).toContain('✓')
    expect('pass' in (cleared.h.current().content.flow ?? {})).toBe(false)

    const meta = await run('edit_meta', { patch: { title: '新标题', difficulty: 9 } }, doc)
    expect(meta.h.current().meta.title).toBe('新标题')
    expect(meta.h.current().meta.difficulty).toBe(5) // 钳制到 1–5
  })

  it('edit_table：remove_column 后引用它的逻辑由 lint 警告（校验警告透出）', async () => {
    // 逻辑里引用 q.title（write_script 造一个），然后删列 → 应应用成功但带警告
    const withRef = await run('write_script', { script: 'on b1.clicked {\n  v.title = q.title\n}' }, doc)
    expect(withRef.result).toContain('✓')
    const del = await run('edit_table', { op: 'remove_column', key: 'title' }, withRef.h.current())
    expect(del.result).toContain('✓')
    expect(del.result).toContain('校验警告')
  })
})

describe('AI 写入工具批量参数（工具粒度治理：一次调用做多件事）', () => {
  let doc: LevelDoc
  beforeEach(() => {
    doc = setTable(blankLevelDoc(), {
      columns: [
        { key: 'title', label: '题面', type: 'text' },
        { key: 'scoring', label: '分值', type: 'number' },
      ],
      rows: [{ title: '第1题', scoring: 10 }],
    })
    doc.content.components.push({ id: 'b1', type: 'button', view: 'main' } as never)
  })

  it('set_variable.vars：一次声明多个变量（单次管线应用）；非法名整批拒绝', async () => {
    const ok = await run('set_variable', { op: 'set', vars: { score: 0, lives: 3, label: 'hi' } }, doc)
    expect(ok.result).toContain('✓')
    expect(ok.h.current().content.logic.variables).toMatchObject({ score: 0, lives: 3, label: 'hi' })
    expect(ok.h.applied).toHaveLength(1)

    const bad = await run('set_variable', { op: 'set', vars: { good: 1, __row: 0 } }, doc)
    expect(bad.result).toContain('系统保留字')
    expect(bad.h.applied).toHaveLength(0)
    expect(bad.h.current().content.logic.variables?.good).toBeUndefined()
  })

  it('edit_components.items：一次批量添加多个组件并回传全部新 id；坏类型整批不应用', async () => {
    const ok = await run(
      'edit_components',
      { op: 'add', items: [{ type: 'button', name: 'A' }, { type: 'label', name: 'B' }] },
      doc,
    )
    expect(ok.result).toContain('✓')
    expect(ok.result).toMatch(/已添加 2 个组件/)
    expect(ok.h.current().content.components).toHaveLength(3)
    expect(ok.h.current().content.components.map((c) => c.name)).toEqual(expect.arrayContaining(['A', 'B']))

    const bad = await run('edit_components', { op: 'add', items: [{ type: 'button' }, { type: 'robot' }] }, doc)
    expect(bad.result).toContain('未知组件类型')
    expect(bad.h.applied).toHaveLength(0)
    expect(bad.h.current().content.components).toHaveLength(1)
  })

  it('edit_components.updates/ids：批量改与批量删；坏项整批不应用', async () => {
    doc.content.components.push({ id: 'l1', type: 'label', view: 'main' } as never)
    const ok = await run(
      'edit_components',
      {
        op: 'update',
        updates: [
          { id: 'b1', patch: { visible: false } },
          { id: 'l1', patch: { name: '标签' } },
        ],
      },
      doc,
    )
    expect(ok.result).toContain('✓')
    expect(ok.h.current().content.components.find((c) => c.id === 'b1')?.visible).toBe(false)
    expect(ok.h.current().content.components.find((c) => c.id === 'l1')?.name).toBe('标签')

    const bad = await run(
      'edit_components',
      { op: 'update', updates: [{ id: 'b1', patch: { visible: true } }, { id: 'ghost', patch: { name: 'x' } }] },
      ok.h.current(),
    )
    expect(bad.result).toContain('不存在')
    expect(bad.h.applied).toHaveLength(0)
    expect(bad.h.current().content.components.find((c) => c.id === 'b1')?.visible).toBe(false)

    const del = await run('edit_components', { op: 'remove', ids: ['b1', 'l1'] }, bad.h.current())
    expect(del.result).toContain('✓')
    expect(del.h.current().content.components).toHaveLength(0)
  })

  it('edit_views.ops：一次建多视图+改名；保底与越界校验整批拒绝', async () => {
    const ok = await run(
      'edit_views',
      { ops: [{ op: 'add', name: 'A' }, { op: 'add', name: 'B' }, { op: 'rename', id: 'main', name: '主页' }] },
      doc,
    )
    expect(ok.result).toContain('✓')
    expect(ok.h.current().content.views).toHaveLength(3)
    expect(ok.h.current().content.views.find((v) => v.id === 'main')?.name).toBe('主页')

    const guard = await run('edit_views', { ops: [{ op: 'remove', id: 'main' }] }, doc)
    expect(guard.result).toContain('至少保留一个视图')
    expect(guard.h.applied).toHaveLength(0)

    doc.content.views.push({ id: 'v9', name: 'x' } as never)
    const bad = await run('edit_views', { ops: [{ op: 'remove', id: 'v9' }, { op: 'remove', id: 'ghost' }] }, doc)
    expect(bad.result).toContain('不存在')
    expect(bad.h.applied).toHaveLength(0)
  })
})
