/**
 * docStateV4 纯函数族测试（docs/53 §13.2 / docs/52 §4 W5.2）：
 * - 结构共享：未变更分支保持引用（改数据表不修改 flow、不改 types/shell）；
 * - round-trip：增删互逆后与原文档深等；
 * - 不原地 mutation：deep-freeze 输入后执行全族变换不得抛错；
 * - id 程序化生成：行/组件/题型 id 合法且查重；
 * - 所有变换结果仍可通过 loadLevelDocV4（schema + 结构校验 + lint 装载管线）。
 */
import { describe, expect, it } from 'vitest'
import { minimalLevelDoc } from '../../engine/v4/fixtures'
import { isV4LocalId, type LevelDocV4 } from '../../engine/v4/model'
import { loadLevelDocV4 } from '../../library/validate'
import {
  V4_TAGS,
  addColumn,
  addComponent,
  addRow,
  addSurfaceView,
  addType,
  addView,
  blankLevelDocV4,
  bumpVersionV4,
  copyForEditingV4,
  defaultBehavior,
  isRowIdTaken,
  moveRow,
  remapHistoryForCopyV4,
  removeColumn,
  removeComponent,
  removeRow,
  removeSurfaceView,
  removeType,
  removeView,
  renameColumn,
  setManifest,
  setRunConfig,
  setSurfaceInitialView,
  setTypeArgs,
  setTypeState,
  SHELL_LAYER,
  updateBehavior,
  updateColumn,
  updateComponent,
  updateFlow,
  updateRowMeta,
  updateShell,
  updateSurfaceView,
  updateTableCell,
  updateType,
  updateView,
  withMeta,
  type EditorHistoryV4,
} from './docStateV4'

/** 深冻结：任何原地 mutation 在严格模式下会抛 TypeError，比快照比对更早暴露问题 */
function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const key of Object.keys(value as Record<string, unknown>)) {
      deepFreeze((value as Record<string, unknown>)[key])
    }
    Object.freeze(value)
  }
  return value
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

/** 一个含 1 题型 3 行的最小文档（fixtures.minimalLevelDoc） */
function sampleDoc(): LevelDocV4 {
  return minimalLevelDoc()
}

describe('docStateV4 · 默认文档与装载', () => {
  it('blankLevelDocV4 结构完整并通过 loadLevelDocV4', () => {
    const doc = blankLevelDocV4()
    expect(doc.schemaVersion).toBe(4)
    expect(isV4LocalId(doc.content.shell.views[0].id)).toBe(true)
    const result = loadLevelDocV4(doc)
    expect(result.ok).toBe(true)
  })

  it('blank → 加题型/加行/改单元格/显式题单后仍通过 loadLevelDocV4', () => {
    let doc = blankLevelDocV4()
    const added = addType(doc, { name: '选择题', table: { columns: [{ key: 'prompt', type: 'text' }] } })
    doc = added.doc
    const row = addRow(doc, added.id)
    doc = updateTableCell(row.doc, added.id, row.rowId, 'prompt', '第一题')
    doc = setManifest(doc, { entries: [{ type: added.id, row: row.rowId }] })
    const result = loadLevelDocV4(doc)
    expect(result.ok).toBe(true)
  })

  it('defaultBehavior 行为图可通过装载校验（on start → return）', () => {
    const doc = blankLevelDocV4()
    const added = addType(doc, { name: 't', behavior: defaultBehavior() })
    const result = loadLevelDocV4(added.doc)
    expect(result.ok).toBe(true)
  })
})

describe('docStateV4 · 结构共享（未变更分支保持引用）', () => {
  it('withMeta 只复制 doc 与 meta，content 引用不变', () => {
    const doc = sampleDoc()
    const next = withMeta(doc, { title: '改标题' })
    expect(next).not.toBe(doc)
    expect(next.content).toBe(doc.content)
    expect(next.meta).not.toBe(doc.meta)
    expect(next.meta.title).toBe('改标题')
  })

  it('数据表变换不修改 flow / shell / types（引用相等）', () => {
    const doc = sampleDoc()
    const typeId = 'choice'
    const rowId = 'row_01'
    const variants: LevelDocV4[] = [
      addRow(doc, typeId).doc,
      updateTableCell(doc, typeId, rowId, 'prompt', '新题面'),
      updateRowMeta(doc, typeId, rowId, { draft: true }),
      addColumn(doc, typeId, { key: 'hint', type: 'text' }),
      removeRow(doc, typeId, 'row_02'),
      moveRow(doc, typeId, 'row_02', 0),
      removeColumn(doc, typeId, 'scoring'),
      renameColumn(doc, typeId, 'scoring', 'score'),
      updateColumn(doc, typeId, 'scoring', { label: '分值2' }),
    ]
    for (const next of variants) {
      expect(next, '数据表变换不应修改 flow').not.toBe(doc)
      expect(next.content.flow).toBe(doc.content.flow)
      expect(next.content.shell).toBe(doc.content.shell)
      expect(next.content.types).toBe(doc.content.types)
    }
  })

  it('行变换只复制目标题型表，其它题型表保持引用', () => {
    const doc = sampleDoc()
    doc.content.types.push({
      id: 'other',
      name: '其它',
      surface: { components: [] },
      behavior: defaultBehavior(),
    })
    doc.content.tables.other = { columns: [{ key: 'prompt', type: 'text' }], rows: [] }
    const next = addRow(doc, 'choice').doc
    expect(next.content.tables.other).toBe(doc.content.tables.other)
    expect(next.content.tables.choice).not.toBe(doc.content.tables.choice)
    expect(next.content.tables.choice.columns).toBe(doc.content.tables.choice.columns)
  })

  it('shell 组件变换只复制 shell/target 题型，不触碰 flow 与题单', () => {
    const doc = sampleDoc()
    const added = addComponent(doc, SHELL_LAYER, 'label')
    expect(added.doc.content.shell).not.toBe(doc.content.shell)
    expect(added.doc.content.flow).toBe(doc.content.flow)
    expect(added.doc.content.types).toBe(doc.content.types)
    const surface = addComponent(added.doc, { kind: 'surface', typeId: 'choice' }, 'button')
    expect(surface.doc.content.shell).toBe(added.doc.content.shell)
    expect(surface.doc.content.flow).toBe(added.doc.content.flow)
    expect(surface.doc.content.types).not.toBe(added.doc.content.types)
    // 其它题型的 surface 引用保持
    expect(surface.doc.content.tables).toBe(added.doc.content.tables)
  })

  it('no-op 变换返回入参引用（编辑器 update 据此短路，不污染撤销栈）', () => {
    const doc = sampleDoc()
    expect(updateTableCell(doc, 'choice', 'row_01', 'missing', 1)).toBe(doc)
    expect(updateTableCell(doc, 'choice', 'nope', 'prompt', 'x')).toBe(doc)
    expect(updateColumn(doc, 'choice', 'scoring', { type: 'number' })).toBe(doc)
    expect(updateRowMeta(doc, 'choice', 'row_01', {})).toBe(doc)
    expect(setRunConfig(doc, {})).toBe(doc)
    expect(updateFlow(doc, (flow) => flow)).toBe(doc)
    expect(updateShell(doc, (shell) => shell)).toBe(doc)
    expect(updateBehavior(doc, 'choice', (behavior) => behavior)).toBe(doc)
    expect(removeType(doc, 'nope')).toBe(doc)
    expect(removeRow(doc, 'choice', 'nope')).toBe(doc)
  })
})

describe('docStateV4 · 不原地 mutation', () => {
  it('deep-freeze 输入文档后执行全族变换不抛错，且入参内容不变', () => {
    const doc = deepFreeze(sampleDoc())
    const snapshot = clone(doc)
    const typeId = 'choice'
    let next: LevelDocV4 = doc
    next = withMeta(next, { title: '冻结测试' })
    next = updateType(next, typeId, { description: '说明' })
    next = setTypeState(next, typeId, [{ key: 'answered', type: 'boolean', init: false }], 'state')
    next = setTypeState(next, typeId, [{ key: 'count', type: 'number', init: 0 }], 'typeState')
    next = setTypeState(next, typeId, [{ key: 'attempt', type: 'number', init: 0 }], 'locals')
    next = setTypeArgs(next, typeId, [{ key: 'level', type: 'number' }])
    next = addColumn(next, typeId, { key: 'hint', type: 'text' })
    next = renameColumn(next, typeId, 'hint', 'hint2')
    next = updateColumn(next, typeId, 'hint2', { label: '提示' })
    next = addRow(next, typeId).doc
    next = updateRowMeta(next, typeId, 'row_01', { draft: true, phase: 2, order: 5 })
    next = updateTableCell(next, typeId, 'row_01', 'prompt', '改了')
    next = moveRow(next, typeId, 'row_03', 0)
    next = removeRow(next, typeId, 'row_02')
    next = addType(next, { name: '新题型' }).doc
    next = setManifest(next, { entries: [{ type: typeId, row: 'row_01' }] })
    next = setRunConfig(next, { order: 'shuffle', count: 2, seed: 'abc' })
    next = updateFlow(next, (flow) => ({ ...flow, vars: [{ key: 'score', type: 'number', init: 0 }] }))
    next = addView(next, '第二视图').doc
    next = updateView(next, 'main', { name: '主视图2' })
    next = addComponent(next, SHELL_LAYER, 'label').doc
    next = addComponent(next, { kind: 'surface', typeId }, 'label').doc
    next = removeColumn(next, typeId, 'hint2')
    expect(next).not.toBe(doc)
    // 入参（冻结的）内容完全未变：快照相同即未原地改
    expect(clone(doc)).toEqual(snapshot)
  })
})

describe('docStateV4 · 题型', () => {
  it('addType 生成合法 id、同步建表、返回结构共享的新文档', () => {
    const doc = sampleDoc()
    const { doc: next, id } = addType(doc, {
      name: '填空',
      table: { columns: [{ key: 'answer', type: 'text' }] },
    })
    expect(isV4LocalId(id)).toBe(true)
    expect(next.content.types.map((t) => t.id)).toContain(id)
    expect(next.content.tables[id]).toEqual({ columns: [{ key: 'answer', type: 'text' }], rows: [] })
    expect(doc.content.tables[id]).toBeUndefined() // 入参未被改
    expect(next.content.flow).toBe(doc.content.flow)
    expect(next.content.shell).toBe(doc.content.shell)
  })

  it('addType 达到上限时抛可读错误', () => {
    let doc = blankLevelDocV4()
    for (let i = 0; i < 12; i++) doc = addType(doc, { name: `t${i}` }).doc
    expect(() => addType(doc, { name: 't12' })).toThrow(/上限 12/)
  })

  it('removeType 级联删实例表与显式题单条目', () => {
    const doc = sampleDoc()
    const withManifest = setManifest(doc, {
      entries: [
        { type: 'choice', row: 'row_01' },
        { type: 'choice', row: 'row_02' },
      ],
    })
    const next = removeType(withManifest, 'choice')
    expect(next.content.types.some((t) => t.id === 'choice')).toBe(false)
    expect(next.content.tables.choice).toBeUndefined()
    expect(next.content.manifest?.entries).toEqual([])
  })

  it('updateType 不修改 id；undefined 值删除可选字段', () => {
    const doc = sampleDoc()
    const renamed = updateType(doc, 'choice', { name: '听音选择2', description: '新说明', id: 'hacked' })
    expect(renamed.content.types[0].id).toBe('choice')
    expect(renamed.content.types[0].name).toBe('听音选择2')
    expect(renamed.content.types[0].description).toBe('新说明')
    const cleared = updateType(renamed, 'choice', { description: undefined })
    expect(cleared.content.types[0].description).toBeUndefined()
  })

  it('setTypeState 三种目标分别落到 state/typeState/behavior.locals', () => {
    const doc = sampleDoc()
    const state = setTypeState(doc, 'choice', [{ key: 'a', type: 'number', init: 1 }], 'state')
    expect(state.content.types[0].state).toEqual([{ key: 'a', type: 'number', init: 1 }])
    const typeState = setTypeState(state, 'choice', [{ key: 'b', type: 'string', init: '' }], 'typeState')
    expect(typeState.content.types[0].typeState).toEqual([{ key: 'b', type: 'string', init: '' }])
    const locals = setTypeState(typeState, 'choice', [{ key: 'c', type: 'json', init: null }], 'locals')
    expect(locals.content.types[0].behavior.locals).toEqual([{ key: 'c', type: 'json', init: null }])
    // 行为图其它部分保持引用
    expect(locals.content.types[0].behavior.nodes).toBe(doc.content.types[0].behavior.nodes)
  })

  it('updateBehavior / updateFlow 支持纯函数变换与 no-op 短路', () => {
    const doc = sampleDoc()
    const next = updateBehavior(doc, 'choice', (behavior) => ({ ...behavior, locals: [] }))
    expect(next.content.types[0].behavior.locals).toEqual([])
    expect(next.content.types[0].behavior.nodes).toBe(doc.content.types[0].behavior.nodes)
    const flow = updateFlow(doc, (p) => ({ ...p, vars: [] }))
    expect(flow.content.flow.vars).toEqual([])
    expect(flow.content.flow.nodes).toBe(doc.content.flow.nodes)
  })
})

describe('docStateV4 · 列', () => {
  it('addColumn 补 null 单元格；非法/重复/保留名抛错；上限拦截', () => {
    const doc = sampleDoc()
    const next = addColumn(doc, 'choice', { key: 'hint', label: '提示', type: 'text' })
    expect(next.content.tables.choice.columns.map((c) => c.key)).toContain('hint')
    for (const row of next.content.tables.choice.rows) expect(row.hint).toBeNull()
    expect(() => addColumn(next, 'choice', 'hint')).toThrow(/已存在/)
    expect(() => addColumn(next, 'choice', '1bad')).toThrow(/非法列名/)
    expect(() => addColumn(next, 'choice', 'phase')).toThrow(/保留字段/)
    let many = next
    for (let i = 0; i < 28; i++) many = addColumn(many, 'choice', `c${i}`)
    expect(many.content.tables.choice.columns.length).toBe(32)
    expect(() => addColumn(many, 'choice', 'overflow')).toThrow(/上限 32/)
  })

  it('renameColumn 重写各行单元格键；updateColumn 改显示名与类型', () => {
    const doc = sampleDoc()
    const renamed = renameColumn(doc, 'choice', 'scoring', 'score')
    expect(renamed.content.tables.choice.columns.find((c) => c.key === 'score')).toBeTruthy()
    expect(renamed.content.tables.choice.rows[0].score).toBe(10)
    expect('scoring' in renamed.content.tables.choice.rows[0]).toBe(false)
    const retyped = updateColumn(renamed, 'choice', 'score', { label: '得分', type: 'number' })
    expect(retyped.content.tables.choice.columns.find((c) => c.key === 'score')).toEqual({
      key: 'score',
      label: '得分',
      type: 'number',
    })
  })

  it('removeColumn 删除各行对应单元格', () => {
    const doc = sampleDoc()
    const next = removeColumn(doc, 'choice', 'scoring')
    expect(next.content.tables.choice.columns.some((c) => c.key === 'scoring')).toBe(false)
    for (const row of next.content.tables.choice.rows) expect('scoring' in row).toBe(false)
  })
})

describe('docStateV4 · 行', () => {
  it('addRow 返回程序化生成的唯一 rowId 并初始化列单元格', () => {
    const doc = sampleDoc()
    const first = addRow(doc, 'choice')
    expect(isV4LocalId(first.rowId)).toBe(true)
    expect(isRowIdTaken(first.doc, 'choice', first.rowId)).toBe(true)
    const row = first.doc.content.tables.choice.rows.find((r) => r.id === first.rowId)!
    expect(row.prompt).toBeNull()
    expect(row.options).toBeNull()
    const second = addRow(first.doc, 'choice')
    expect(second.rowId).not.toBe(first.rowId)
    // 插入到指定行之后
    const after = addRow(doc, 'choice', 'row_01')
    expect(after.doc.content.tables.choice.rows.map((r) => r.id).slice(0, 2)).toEqual(['row_01', after.rowId])
  })

  it('addRow 在题型行上限/全关行上限时抛错', () => {
    let doc = blankLevelDocV4()
    const added = addType(doc, { name: 't', table: { columns: [{ key: 'prompt', type: 'text' }] } })
    doc = added.doc
    for (let i = 0; i < 512; i++) doc = addRow(doc, added.id).doc
    expect(() => addRow(doc, added.id)).toThrow(/上限 512/)
  })

  it('removeRow 级联删显式题单条目；moveRow 重排并 clamp 越界', () => {
    const doc = sampleDoc()
    const withManifest = setManifest(doc, {
      entries: [
        { type: 'choice', row: 'row_01' },
        { type: 'choice', row: 'row_02' },
      ],
    })
    const removed = removeRow(withManifest, 'choice', 'row_02')
    expect(removed.content.manifest?.entries).toEqual([{ type: 'choice', row: 'row_01' }])
    expect(removed.content.tables.choice.rows.map((r) => r.id)).toEqual(['row_01', 'row_03'])
    const moved = moveRow(doc, 'choice', 'row_03', 0)
    expect(moved.content.tables.choice.rows.map((r) => r.id)).toEqual(['row_03', 'row_01', 'row_02'])
    expect(moveRow(doc, 'choice', 'row_03', 99).content.tables.choice.rows.at(-1)!.id).toBe('row_03')
    expect(moveRow(doc, 'choice', 'row_03', -5).content.tables.choice.rows[0].id).toBe('row_03')
  })

  it('updateRowMeta 设置/删除 draft/phase/order（null = 删键回缺省）', () => {
    const doc = sampleDoc()
    const next = updateRowMeta(doc, 'choice', 'row_01', { draft: true, phase: 3, order: 7 })
    const row = next.content.tables.choice.rows.find((r) => r.id === 'row_01')!
    expect(row.draft).toBe(true)
    expect(row.phase).toBe(3)
    expect(row.order).toBe(7)
    const cleared = updateRowMeta(next, 'choice', 'row_01', { draft: null, phase: null, order: null })
    const clearedRow = cleared.content.tables.choice.rows.find((r) => r.id === 'row_01')!
    expect('draft' in clearedRow).toBe(false)
    expect('phase' in clearedRow).toBe(false)
    expect('order' in clearedRow).toBe(false)
    // phase 下限 1
    expect(updateRowMeta(doc, 'choice', 'row_01', { phase: 0 }).content.tables.choice.rows[0].phase).toBe(1)
  })
})

describe('docStateV4 · 画布（视图/组件）', () => {
  it('addView/updateView/removeView：id 去重、级联删组件、悬空组件归首视图、至少保留一个', () => {
    const doc = sampleDoc()
    const added = addView(doc, '第二视图')
    expect(added.id).toBe('view2')
    expect(added.doc.content.shell.views.map((v) => v.id)).toEqual(['main', 'view2'])
    const withComp = addComponent(added.doc, SHELL_LAYER, 'label', { view: 'view2' }).doc
    const removed = removeView(withComp, 'view2')
    expect(removed.content.shell.views.map((v) => v.id)).toEqual(['main'])
    // 仅删除归属 view2 的组件；首视图的 fixture 组件保留
    expect(removed.content.shell.components.every((c) => c.view === 'main')).toBe(true)
    expect(removed.content.shell.components.some((c) => c.id === 'scoreLabel')).toBe(true)
    // 悬空组件归首视图（直接构造 dangling 视图再删另一视图）
    const dangling = {
      ...removed,
      content: {
        ...removed.content,
        shell: {
          ...removed.content.shell,
          views: [
            { id: 'main' },
            { id: 'view2' },
          ],
          components: [{ id: 'ghost', type: 'label', view: 'ghostView' }],
        },
      },
    }
    const fixed = removeView(dangling, 'view2')
    expect(fixed.content.shell.components[0].view).toBe('main')
    // 单视图时删除是 no-op
    expect(removeView(fixed, 'main')).toBe(fixed)
  })

  it('addComponent 在 shell/surface 层各自查重生成 id；surface 无视图时丢弃 view', () => {
    const doc = sampleDoc()
    const shell1 = addComponent(doc, SHELL_LAYER, 'label')
    const shell2 = addComponent(shell1.doc, SHELL_LAYER, 'label')
    expect(shell1.id).not.toBe(shell2.id)
    expect(isV4LocalId(shell1.id)).toBe(true)
    const shellComp = shell2.doc.content.shell.components.find((c) => c.id === shell1.id)!
    expect(shellComp.view).toBe('main')
    expect(shellComp.layout).toBeTruthy()
    // surface：同 id 可以出现在不同题型（命名空间隔离），但本层内查重
    const surface1 = addComponent(doc, { kind: 'surface', typeId: 'choice' }, 'choice', { view: 'main' })
    const surfaceComp = surface1.doc.content.types[0].surface.components.find((c) => c.id === surface1.id)!
    expect(surfaceComp.view).toBeUndefined()
    expect(surface1.doc.content.tables).toBe(doc.content.tables)
    expect(surface1.doc.content.shell).toBe(doc.content.shell)
  })

  it('updateComponent 浅合并、id 不可改、undefined 删字段；removeComponent 删除', () => {
    const doc = sampleDoc()
    const added = addComponent(doc, SHELL_LAYER, 'label')
    const updated = updateComponent(added.doc, SHELL_LAYER, added.id, {
      layout: { x: 1, y: 2, w: 3, h: 4 },
      name: '标签',
      id: 'hacked',
      visible: undefined,
    })
    const comp = updated.content.shell.components.find((c) => c.id === added.id)!
    expect(comp.layout).toEqual({ x: 1, y: 2, w: 3, h: 4 })
    expect(comp.name).toBe('标签')
    expect(comp.visible).toBeUndefined()
    expect(updated.content.shell.components.some((c) => c.id === 'hacked')).toBe(false)
    const removed = removeComponent(updated, SHELL_LAYER, added.id)
    expect(removed.content.shell.components.some((c) => c.id === added.id)).toBe(false)
  })

  it('题型内视图：add/update/remove/initial 与组件 view 归属（v4.1）', () => {
    const doc = sampleDoc()
    const added = addSurfaceView(doc, 'choice', '读题')
    expect(added.id).toBe('view1')
    expect(added.doc.content.types[0].surface.views?.map((v) => v.id)).toEqual(['view1'])
    expect(added.doc.content.types[0].surface.views?.[0].name).toBe('读题')

    const renamed = updateSurfaceView(added.doc, 'choice', 'view1', { name: '作答' })
    expect(renamed.content.types[0].surface.views?.[0].name).toBe('作答')

    const withInitial = setSurfaceInitialView(renamed, 'choice', 'view1')
    expect(withInitial.content.types[0].surface.initialView).toBe('view1')
    expect(setSurfaceInitialView(withInitial, 'choice', 'nope')).toBe(withInitial)

    // 声明视图后，surface 组件可以带合法 view；非法 view 仍被丢弃
    const comp = addComponent(withInitial, { kind: 'surface', typeId: 'choice' }, 'label', { view: 'view1' })
    expect(comp.doc.content.types[0].surface.components.at(-1)!.view).toBe('view1')
    const badComp = addComponent(withInitial, { kind: 'surface', typeId: 'choice' }, 'label', { view: 'ghost' })
    expect(badComp.doc.content.types[0].surface.components.at(-1)!.view).toBeUndefined()

    // 删除视图：组件不删，归属改为全部视图可见；initialView 清理
    const removed = removeSurfaceView(comp.doc, 'choice', 'view1')
    const surface = removed.content.types[0].surface
    expect(surface.views).toBeUndefined()
    expect(surface.initialView).toBeUndefined()
    expect(surface.components.at(-1)!.id).toBe(comp.id)
    expect(surface.components.at(-1)!.view).toBeUndefined()
    // 结构共享：其它分支未变
    expect(removed.content.flow).toBe(doc.content.flow)
    expect(removed.content.shell).toBe(doc.content.shell)
    // 结果仍可装载
    const loaded = loadLevelDocV4(removed)
    expect(loaded.ok, loaded.ok ? '' : loaded.errors.join(' / ')).toBe(true)
  })
})

describe('docStateV4 · 题单 / 运行配置', () => {
  it('setManifest(null) 删除 manifest 并回落自动题单；setManifest 深拷贝 entries', () => {
    const doc = sampleDoc()
    const entries = [{ type: 'choice', row: 'row_01', args: { difficulty: 2 } }]
    const withManifest = setManifest(doc, { entries })
    expect(withManifest.content.manifest?.entries).toEqual(entries)
    expect(withManifest.content.manifest?.entries).not.toBe(entries)
    const cleared = setManifest(withManifest, null)
    expect('manifest' in cleared.content).toBe(false)
    expect(cleared.content.flow).toBe(doc.content.flow)
  })

  it('setRunConfig 只覆盖给出的键并归一化 count/seed', () => {
    const doc = sampleDoc()
    const shuffled = setRunConfig(doc, { order: 'shuffle', count: 3.9, seed: 'seed-a' })
    expect(shuffled.content.run).toEqual({
      order: 'shuffle',
      count: 3,
      seed: 'seed-a',
      shuffleWithinPhase: true,
    })
    const cleared = setRunConfig(shuffled, { count: null, seed: null })
    expect(cleared.content.run.count).toBeNull()
    expect(cleared.content.run.seed).toBeNull()
    expect(cleared.content.run.order).toBe('shuffle')
    const nan = setRunConfig(doc, { count: Number.NaN, seed: Number.NaN })
    expect(nan.content.run.count).toBeNull()
    expect(nan.content.run.seed).toBeNull()
  })
})

describe('docStateV4 · round-trip（增删互逆深等）', () => {
  it('addType → removeType、addRow → removeRow、addColumn → removeColumn、addView → removeView', () => {
    const doc = deepFreeze(sampleDoc())
    const original = clone(doc)
    const typeAdded = addType(doc, { name: '临时题型', table: { columns: [{ key: 'prompt', type: 'text' }] } })
    expect(clone(removeType(typeAdded.doc, typeAdded.id))).toEqual(original)
    const rowAdded = addRow(doc, 'choice')
    expect(clone(removeRow(rowAdded.doc, 'choice', rowAdded.rowId))).toEqual(original)
    const colAdded = addColumn(doc, 'choice', { key: 'tmp', type: 'text' })
    expect(clone(removeColumn(colAdded, 'choice', 'tmp'))).toEqual(original)
    const viewAdded = addView(doc, '临时视图')
    expect(clone(removeView(viewAdded.doc, viewAdded.id))).toEqual(original)
  })

  it('单元格/行元数据/组件/题单变换结果仍可装载', () => {
    let doc: LevelDocV4 = sampleDoc()
    doc = updateTableCell(doc, 'choice', 'row_01', 'prompt', '改')
    doc = updateRowMeta(doc, 'choice', 'row_01', { phase: 2, order: 1, draft: false })
    doc = addComponent(doc, SHELL_LAYER, 'label').doc
    doc = addView(doc, '第二视图').doc
    doc = setManifest(doc, { entries: [{ type: 'choice', row: 'row_02' }] })
    doc = setRunConfig(doc, { order: 'shuffle', count: 1, seed: 42 })
    const result = loadLevelDocV4(doc)
    expect(result.ok).toBe(true)
  })
})

describe('docStateV4 · 副本 / 版本 / 历史重映射', () => {
  it('copyForEditingV4 换 id、版本归零、标题加副本后缀且不重复', () => {
    const doc = sampleDoc()
    const copy = copyForEditingV4(doc)
    expect(copy.id).not.toBe(doc.id)
    expect(copy.version).toBe('0.1.0')
    expect(copy.meta.title).toBe('v4 测试关卡（副本）')
    const copy2 = copyForEditingV4(copy)
    expect(copy2.meta.title).toBe('v4 测试关卡（副本）')
    // 入参未被改
    expect(doc.meta.title).toBe('v4 测试关卡')
  })

  it('bumpVersionV4 递增修订号；非法版本保留原值', () => {
    const doc = sampleDoc()
    expect(bumpVersionV4(doc).version).toBe('1.0.1')
    expect(bumpVersionV4({ ...doc, version: 'bad' }).version).toBe('bad')
  })

  it('remapHistoryForCopyV4 重映射 id/version/标题且不改写原历史条目', () => {
    const doc = sampleDoc()
    const history: EditorHistoryV4 = { past: [doc], future: [withMeta(doc, { title: '旧' })] }
    const saved = { id: 'res_01J9A0A0A0A0A0A0A0A0A0A0A8', version: '2.0.0' }
    const remapped = remapHistoryForCopyV4(history, saved)
    expect(remapped.past[0].id).toBe(saved.id)
    expect(remapped.past[0].version).toBe('2.0.0')
    expect(remapped.past[0].meta.title).toBe('v4 测试关卡（副本）')
    expect(remapped.future[0].meta.title).toBe('旧（副本）')
    expect(history.past[0].id).toBe(doc.id)
    expect(history.past[0].meta.title).toBe('v4 测试关卡')
  })
})

describe('docStateV4 · tag 常量', () => {
  it('V4_TAGS 覆盖编辑器连续性 tag 体系', () => {
    expect(V4_TAGS.cell).toBe('cell')
    expect(V4_TAGS.title).toBe('title')
    expect(Object.values(V4_TAGS).includes('json')).toBe(true)
  })
})
