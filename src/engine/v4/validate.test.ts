import { describe, expect, it } from 'vitest'
import { validateLevelDocV4 } from './validate'
import { emptyBehavior, minimalLevelDoc, twoTypeLevelDoc } from './fixtures'
import type { FlowNode, LevelDocV4 } from './model'

function expectError(doc: LevelDocV4, code: string, msgRe?: RegExp): void {
  const result = validateLevelDocV4(doc)
  const codes = result.errors.map((e) => e.code)
  expect(codes, JSON.stringify(result.errors, null, 2)).toContain(code)
  if (msgRe) expect(result.errors.map((e) => e.message).join('\n')).toMatch(msgRe)
}

function expectWarning(doc: LevelDocV4, code: string): void {
  const result = validateLevelDocV4(doc)
  expect(result.warnings.map((w) => w.code), JSON.stringify(result.warnings, null, 2)).toContain(code)
}

describe('v4 validate：夹具基线', () => {
  it('最小夹具与双题型夹具无错误', () => {
    for (const doc of [minimalLevelDoc(), twoTypeLevelDoc()]) {
      const result = validateLevelDocV4(doc)
      expect(result.errors, JSON.stringify(result.errors, null, 2)).toEqual([])
      expect(result.ok).toBe(true)
    }
  })
})

describe('v4 validate：身份 / shell', () => {
  it('id、版本号、标题非法', () => {
    const badId = minimalLevelDoc()
    badId.id = 'res_short'
    expectError(badId, 'V4_SCHEMA', /id/)

    const badVersion = minimalLevelDoc()
    badVersion.version = '1.0'
    expectError(badVersion, 'V4_SCHEMA', /版本号/)

    const badTitle = minimalLevelDoc()
    badTitle.meta.title = ''
    expectError(badTitle, 'V4_SCHEMA', /title/)
  })

  it('视图/组件 id 重复、保留字、悬空视图引用', () => {
    const dupView = minimalLevelDoc()
    dupView.content.shell.views.push({ id: 'main' })
    expectError(dupView, 'V4_DUPLICATE_ID', /视图/)

    const dupComp = minimalLevelDoc()
    dupComp.content.shell.components.push({ id: 'scoreLabel', type: 'label' })
    expectError(dupComp, 'V4_DUPLICATE_ID', /shell 组件/)

    const reserved = minimalLevelDoc()
    reserved.content.shell.components[0].id = 'level'
    expectError(reserved, 'V4_RESERVED', /保留字/)

    const danglingView = minimalLevelDoc()
    danglingView.content.shell.components[0].view = 'nope'
    expectError(danglingView, 'V4_REF', /不存在的视图/)

    const badInitial = minimalLevelDoc()
    badInitial.content.shell.initialView = 'nope'
    expectError(badInitial, 'V4_REF', /initialView/)
  })

  it('surface 组件 view 必须指向题型内已声明视图（v4.1）；绑定槽位/根错误被拒', () => {
    // 没声明题内视图时，组件不能带 view
    const noViews = minimalLevelDoc()
    noViews.content.types[0].surface.components[0].view = 'main'
    expectError(noViews, 'V4_REF', /指向不存在的题内视图/)

    const dangling = minimalLevelDoc()
    dangling.content.types[0].surface.views = [{ id: 'intro' }, { id: 'answer' }]
    dangling.content.types[0].surface.components[0].view = 'nope'
    expectError(dangling, 'V4_REF', /不存在的题内视图/)

    const dupView = minimalLevelDoc()
    dupView.content.types[0].surface.views = [{ id: 'intro' }, { id: 'intro' }]
    expectError(dupView, 'V4_DUPLICATE_ID', /题内视图/)

    const badInitial = minimalLevelDoc()
    badInitial.content.types[0].surface.views = [{ id: 'intro' }]
    badInitial.content.types[0].surface.initialView = 'nope'
    expectError(badInitial, 'V4_REF', /initialView/)

    const initialWithoutViews = minimalLevelDoc()
    initialWithoutViews.content.types[0].surface.initialView = 'intro'
    expectError(initialWithoutViews, 'V4_REF', /需要同时声明 surface.views/)

    const viewsOk = minimalLevelDoc()
    viewsOk.content.types[0].surface.views = [{ id: 'intro', name: '读题' }, { id: 'answer', name: '作答' }]
    viewsOk.content.types[0].surface.initialView = 'intro'
    viewsOk.content.types[0].surface.components[0].view = 'intro'
    expect(validateLevelDocV4(viewsOk).errors).toEqual([])

    const badSlot = minimalLevelDoc()
    badSlot.content.shell.components[0].bindings = { nope: "'x'" }
    expectError(badSlot, 'V4_BINDING_SLOT', /槽位/)

    const badRoot = minimalLevelDoc()
    badRoot.content.shell.components[0].bindings = { text: 'q.prompt' }
    expectError(badRoot, 'V4_EXPR_ROOT', /本层允许/)

    const surfaceOk = minimalLevelDoc()
    surfaceOk.content.types[0].surface.components[1].bindings = { options: 'q.options' }
    expect(validateLevelDocV4(surfaceOk).errors).toEqual([])
  })

  it('behavior setView 节点（v4.1）：视图存在则通过，悬空/未声明视图被拒', () => {
    const ok = minimalLevelDoc()
    ok.content.types[0].surface.views = [{ id: 'intro' }, { id: 'answer' }]
    ok.content.types[0].surface.components[0].view = 'answer'
    ok.content.types[0].behavior.nodes.push({ id: 'b_view', kind: 'setView', view: 'answer' })
    expect(validateLevelDocV4(ok).errors).toEqual([])

    const dangling = minimalLevelDoc()
    dangling.content.types[0].surface.views = [{ id: 'intro' }]
    dangling.content.types[0].behavior.nodes.push({ id: 'b_view', kind: 'setView', view: 'nope' })
    expectError(dangling, 'V4_NODE', /不存在的视图/)

    const noViews = minimalLevelDoc()
    noViews.content.types[0].behavior.nodes.push({ id: 'b_view', kind: 'setView', view: 'intro' })
    expectError(noViews, 'V4_NODE', /不存在的视图/)
  })
})

describe('v4 validate：题型实例表', () => {
  it('题型与实例表必须一一对应', () => {
    const missing = minimalLevelDoc()
    delete missing.content.tables.choice
    expectError(missing, 'V4_REF', /缺少实例表/)

    const extra = minimalLevelDoc()
    extra.content.tables.orphan = { columns: [], rows: [] }
    expectError(extra, 'V4_REF', /没有对应的题型/)
  })

  it('重复题型/列/行 id，保留列名被拒', () => {
    const dupType = minimalLevelDoc()
    dupType.content.types.push({ ...dupType.content.types[0] })
    expectError(dupType, 'V4_DUPLICATE_ID', /题型/)

    const dupColumn = minimalLevelDoc()
    dupColumn.content.tables.choice.columns.push({ key: 'prompt' })
    expectError(dupColumn, 'V4_DUPLICATE_ID', /列/)

    const reservedColumn = minimalLevelDoc()
    reservedColumn.content.tables.choice.columns.push({ key: 'state' })
    expectError(reservedColumn, 'V4_RESERVED', /保留字段/)

    const dupRow = minimalLevelDoc()
    dupRow.content.tables.choice.rows.push({ id: 'row_01' })
    expectError(dupRow, 'V4_DUPLICATE_ID', /行/)
  })

  it('行内容列未声明 / 保留键 / 状态初值类型不符', () => {
    const unknownCol = minimalLevelDoc()
    ;(unknownCol.content.tables.choice.rows[0] as Record<string, unknown>).mystery = 1
    expectError(unknownCol, 'V4_REF', /未在表格列中声明/)

    const reservedKey = minimalLevelDoc()
    ;(reservedKey.content.tables.choice.rows[0] as Record<string, unknown>).state = {}
    expectError(reservedKey, 'V4_RESERVED', /保留字段/)

    const badInit = minimalLevelDoc()
    badInit.content.types[0].state = [{ key: 'answered', type: 'number', init: false }]
    expectError(badInit, 'V4_SCHEMA', /初值类型/)
  })

  it('全关行数超上限', () => {
    const doc = twoTypeLevelDoc()
    const mkRows = (n: number, prefix: string) => Array.from({ length: n }, (_, i) => ({ id: `${prefix}_${i}` }))
    doc.content.tables.choice.rows = mkRows(512, 'ra')
    doc.content.tables.listen.rows = mkRows(513, 'rb')
    expectError(doc, 'V4_LIMIT', /全关行数/)
  })
})

describe('v4 validate：题单', () => {
  it('悬空引用是错误，草稿/重复是警告', () => {
    const danglingType = minimalLevelDoc()
    danglingType.content.manifest = { entries: [{ type: 'nope', row: 'row_01' }] }
    expectError(danglingType, 'V4_REF', /不存在的题型/)

    const danglingRow = minimalLevelDoc()
    danglingRow.content.manifest = { entries: [{ type: 'choice', row: 'nope' }] }
    expectError(danglingRow, 'V4_REF', /不存在的行/)

    const draft = minimalLevelDoc()
    draft.content.manifest = { entries: [{ type: 'choice', row: 'row_03' }] }
    expectWarning(draft, 'V4_MANIFEST_DRAFT')

    const dup = minimalLevelDoc()
    dup.content.manifest = { entries: [{ type: 'choice', row: 'row_01' }, { type: 'choice', row: 'row_01' }] }
    expectWarning(dup, 'V4_MANIFEST_DUP')

    const badArgs = minimalLevelDoc()
    badArgs.content.manifest = { entries: [{ type: 'choice', row: 'row_01', args: 'x' as never }] }
    expectError(badArgs, 'V4_SCHEMA', /args/)
  })
})

describe('v4 validate：Flow 图结构', () => {
  it('start 数量/入边', () => {
    const noStart = minimalLevelDoc()
    noStart.content.flow.nodes = noStart.content.flow.nodes.filter((n) => n.kind !== 'start')
    expectError(noStart, 'V4_START_COUNT', /一个 start/)

    const twoStart = minimalLevelDoc()
    twoStart.content.flow.nodes.push({ id: 'f_start2', kind: 'start' })
    expectError(twoStart, 'V4_START_COUNT')

    const startIncoming = minimalLevelDoc()
    startIncoming.content.flow.edges.push({ id: 'fe_in', from: 'f_init', to: 'f_start' })
    expectError(startIncoming, 'V4_EDGE', /不能有入边/)
  })

  it('悬空边/自环/端口协议/comment 边均被拒', () => {
    const dangling = minimalLevelDoc()
    dangling.content.flow.edges.push({ id: 'fe_x', from: 'f_init', to: 'nope' })
    expectError(dangling, 'V4_EDGE', /终点/)

    const selfLoop = minimalLevelDoc()
    selfLoop.content.flow.edges.push({ id: 'fe_x', from: 'f_init', to: 'f_init' })
    expectError(selfLoop, 'V4_EDGE', /自环/)

    const branch = minimalLevelDoc()
    branch.content.flow.nodes.push({ id: 'f_branch', kind: 'branch', cond: 'v.score > 0' })
    branch.content.flow.edges.push({ id: 'fe_b1', from: 'f_branch', to: 'f_finish' })
    expectError(branch, 'V4_EDGE', /必须指定 port/)

    const extraPort = minimalLevelDoc()
    extraPort.content.flow.edges.push({ id: 'fe_x', from: 'f_init', to: 'f_finish', port: 'true' })
    expectError(extraPort, 'V4_EDGE', /单出口节点/)

    const dupPort = minimalLevelDoc()
    dupPort.content.flow.nodes.push({ id: 'f_branch', kind: 'branch', cond: 'true' })
    dupPort.content.flow.edges.push(
      { id: 'fe_b1', from: 'f_branch', to: 'f_finish', port: 'true' },
      { id: 'fe_b2', from: 'f_branch', to: 'f_init', port: 'true' },
    )
    expectError(dupPort, 'V4_EDGE', /每端口最多一条/)

    const commentEdge = minimalLevelDoc()
    commentEdge.content.flow.nodes.push({ id: 'f_comment', kind: 'comment', text: '说明' })
    commentEdge.content.flow.edges.push({ id: 'fe_x', from: 'f_init', to: 'f_comment' })
    expectError(commentEdge, 'V4_EDGE', /comment/)
  })

  it('节点必填字段 / 未知 kind / 未知目标组件', () => {
    const badAssign = minimalLevelDoc()
    badAssign.content.flow.nodes.push({ id: 'f_bad', kind: 'assign', value: { expr: '1' } } as unknown as FlowNode)
    expectError(badAssign, 'V4_NODE', /缺少必填字符串字段 target/)

    const badAsk = minimalLevelDoc()
    badAsk.content.flow.nodes.push({ id: 'f_ask', kind: 'ask', target: 'run.questions[0]', resultVar: 'bad.id' } as unknown as FlowNode)
    expectError(badAsk, 'V4_NODE', /resultVar/)

    const unknownKind = minimalLevelDoc()
    unknownKind.content.flow.nodes.push({ id: 'f_x', kind: 'teleport' } as unknown as FlowNode)
    expectError(unknownKind, 'V4_NODE', /不是合法节点类型/)

    const waitShell = minimalLevelDoc()
    waitShell.content.flow.nodes.push({ id: 'f_wait', kind: 'waitShell', event: 'nope.clicked' })
    expectError(waitShell, 'V4_NODE', /不存在的 shell 组件/)

    const setView = minimalLevelDoc()
    setView.content.flow.nodes.push({ id: 'f_view', kind: 'setView', view: 'nope' })
    expectError(setView, 'V4_NODE', /不存在的视图/)

    const callUnknown = minimalLevelDoc()
    callUnknown.content.flow.nodes.push({ id: 'f_call', kind: 'call', target: 'ghost', method: 'setText' })
    expectError(callUnknown, 'V4_NODE', /不存在于 shell/)

    const queryUnknown = minimalLevelDoc()
    queryUnknown.content.flow.nodes.push({
      id: 'f_query',
      kind: 'assign',
      target: 'v.score',
      value: { query: { target: 'ghost', method: 'getValue' } },
    })
    expectError(queryUnknown, 'V4_NODE', /查询目标组件/)
  })

  it('restart 终止节点不能有出边', () => {
    const restart = minimalLevelDoc()
    restart.content.flow.nodes.push({ id: 'f_restart', kind: 'restart' })
    restart.content.flow.edges.push({ id: 'fe_r', from: 'f_restart', to: 'f_finish' })
    expectError(restart, 'V4_EDGE', /终止节点/)
  })
})

describe('v4 validate：Behavior 图结构', () => {
  it('on start 必须恰有一个且无入边；return 终止', () => {
    const noStart = minimalLevelDoc()
    noStart.content.types[0].behavior.nodes = noStart.content.types[0].behavior.nodes.filter(
      (n) => !(n.kind === 'on' && n.event === 'start'),
    )
    expectError(noStart, 'V4_START_COUNT', /一个 on start/)

    const onIncoming = minimalLevelDoc()
    onIncoming.content.types[0].behavior.edges.push({ id: 'be_in', from: 'b_return', to: 'b_start' })
    expectError(onIncoming, 'V4_EDGE', /不能有入边|终止节点/)

    const returnOutgoing = minimalLevelDoc()
    returnOutgoing.content.types[0].behavior.edges.push({ id: 'be_out', from: 'b_return', to: 'b_start' })
    expectError(returnOutgoing, 'V4_EDGE', /终止节点|不能有入边/)
  })

  it('on 事件引用未知 surface 组件 / emit 事件格式非法', () => {
    const unknownComp = minimalLevelDoc()
    unknownComp.content.types[0].behavior.nodes.push({ id: 'b_on', kind: 'on', event: 'ghost.clicked' })
    expectError(unknownComp, 'V4_NODE', /不存在的 surface 组件/)

    const badEmit = minimalLevelDoc()
    badEmit.content.types[0].behavior.nodes.push({ id: 'b_emit', kind: 'emit', event: 'judged' })
    expectError(badEmit, 'V4_NODE', /internal\./)
  })

  it('behavior 局部变量重复 / 初值类型不符', () => {
    const dup = minimalLevelDoc()
    dup.content.types[0].behavior.locals = [
      { key: 'tmp', type: 'number', init: 0 },
      { key: 'tmp', type: 'number', init: 1 },
    ]
    expectError(dup, 'V4_DUPLICATE_ID', /局部变量/)

    const badInit = minimalLevelDoc()
    badInit.content.types[0].behavior.locals = [{ key: 'tmp', type: 'boolean', init: 0 }]
    expectError(badInit, 'V4_SCHEMA', /初值类型/)
  })
})

describe('v4 validate：限额', () => {
  it('题型数超过上限', () => {
    const doc = minimalLevelDoc()
    for (let i = 1; i <= 12; i++) {
      const id = `type_${i}`
      doc.content.types.push({
        id,
        name: `题型 ${i}`,
        surface: { components: [] },
        behavior: emptyBehavior(),
      })
      doc.content.tables[id] = { columns: [], rows: [] }
    }
    expectError(doc, 'V4_LIMIT', /题型数|上限/)
  })
})
