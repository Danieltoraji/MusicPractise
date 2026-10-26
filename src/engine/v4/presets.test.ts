/**
 * v4 预设目录测试（docs/52 §4 W8.1；docs/53 §14）。
 *
 * 覆盖：
 * ① 目录形状：id 全局唯一、layer/params 合法、默认参数可展开、behavior 必须给 typeId；
 * ② 展开结构：节点/边 id 唯一且合法、无悬空/自环、端口协议正确、comment 不接线、entryId 存在；
 * ③ 参数生效：表达式/文本/数字/select 参数进入对应节点字段（且留空=不设置）；
 * ④ 插入后 lint：flow/behavior 预设插入夹具文档后 validate 0 error、lint 0 error
 *    （仅允许 V4_UNREACHABLE 等 warning —— 印章片段未与 start 连通时的预期提示）；
 * ⑤ 端到端：sequence-grade-settle 插入→连接 start→headless 无头通关（计分/结算/题数）；
 * ⑥ 可改：展开结果是普通节点（无预设元数据），作者改节点后重新 lint 仍合法。
 */
import { describe, expect, it } from 'vitest'
import type { Json } from '../expr'
import { loadLevelDocV4 } from '../../library/validate'
import { allContracts } from '../../runtime/store'
import { runLevelHeadless } from '../../runtime/v4/harness'
import { minimalLevelDoc } from './fixtures'
import { getType } from './model'
import { cloneLevelDocV4, type BehaviorNode, type FlowNode, type GraphEdge, type LevelDocV4 } from './model'
import { lintLevelDocV4 } from './lint'
import { validateLevelDocV4 } from './validate'
import {
  BEHAVIOR_PRESETS,
  FLOW_PRESETS,
  PRESET_CATALOG,
  PRESET_IDS,
  applyPresetResultToDoc,
  buildPreset,
  connectProgramNodes,
  getPreset,
  insertPresetIntoDoc,
  mergePresetResult,
  normalizePresetParams,
  presetDeclarations,
  presetDefaults,
  type PresetBuildResult,
} from './presets'

const CONTRACT_BY_TYPE = new Map(allContracts().map((contract) => [contract.type, contract]))
const contractOf = (componentType: string) => CONTRACT_BY_TYPE.get(componentType)

// ---------------------------------------------------------------------------
// 夹具：可插入预设的最小文档（flow 变量 + shell 重玩按钮；behavior 侧补齐题态/surface）
// ---------------------------------------------------------------------------

/** 可插入预设的最小文档：flow 声明 v.score/v.row（shell 绑定需要），shell 带重玩按钮 */
function baseFlowDoc(): LevelDocV4 {
  const doc = bareFlowDoc()
  doc.content.flow.vars = [
    { key: 'score', type: 'number', init: 0 },
    { key: 'row', type: 'number', init: 0 },
  ]
  return doc
}

/** 未声明 run 变量的夹具（insertPresetIntoDoc 自动补声明的用例） */
function bareFlowDoc(): LevelDocV4 {
  const doc = cloneLevelDocV4(minimalLevelDoc())
  doc.content.flow = {
    logicVersion: 3,
    kind: 'flow',
    nodes: [{ id: 'f_start', kind: 'start' }],
    edges: [],
  }
  doc.content.shell.components.push({
    id: 'replayBtn',
    type: 'button',
    name: '重玩',
    view: 'main',
    layout: { x: 24, y: 400, w: 180, h: 44 },
    props: { text: '重玩' },
  })
  return doc
}

/** behavior 预设夹具：choice 题型带完整 surface（choice/next/hint/feedback/timer）+ 题态 */
function baseBehaviorDoc(): LevelDocV4 {
  const doc = baseFlowDoc()
  const choice = getType(doc, 'choice')
  if (!choice) throw new Error('夹具缺少 choice 题型')
  choice.surface.components = [
    { id: 'prompt', type: 'label', name: '题面', layout: { x: 20, y: 20, w: 720, h: 32 }, bindings: { text: 'q.prompt' } },
    { id: 'choice1', type: 'choice', name: '选项', layout: { x: 20, y: 70, w: 720, h: 220 }, bindings: { options: 'q.options' } },
    { id: 'nextBtn', type: 'button', name: '下一题', layout: { x: 600, y: 320, w: 160, h: 44 }, props: { text: '下一题' } },
    { id: 'hintBtn', type: 'button', name: '提示', layout: { x: 400, y: 320, w: 160, h: 44 }, props: { text: '提示' } },
    { id: 'feedback', type: 'label', name: '反馈', layout: { x: 20, y: 300, w: 540, h: 32 }, props: { text: '' } },
    { id: 'timer1', type: 'timer', name: '计时器', visible: false },
  ]
  choice.state = [
    { key: 'answered', type: 'boolean', init: false },
    { key: 'wrong', type: 'number', init: 0 },
  ]
  doc.content.tables.choice.columns.push({ key: 'answerIndex', label: '答案下标', type: 'number' })
  return doc
}

// ---------------------------------------------------------------------------
// 通用断言助手
// ---------------------------------------------------------------------------

const NODE_ID_RE = /^[A-Za-z_][A-Za-z0-9_-]{0,63}$/

/** 独立于 buildPreset 自检的结构断言（防止自检与产物同一个 bug 互相掩盖） */
function expectValidFragment(result: PresetBuildResult): void {
  expect(result.nodes.length).toBeGreaterThan(0)
  const kinds = new Map<string, string>()
  for (const node of result.nodes) {
    expect(NODE_ID_RE.test(node.id), `节点 id「${node.id}」形态非法`).toBe(true)
    expect(kinds.has(node.id), `节点 id「${node.id}」重复`).toBe(false)
    kinds.set(node.id, node.kind)
  }
  const edgeIds = new Set<string>()
  const ports = new Set<string>()
  for (const edge of result.edges) {
    expect(NODE_ID_RE.test(edge.id), `边 id「${edge.id}」形态非法`).toBe(true)
    expect(edgeIds.has(edge.id), `边 id「${edge.id}」重复`).toBe(false)
    edgeIds.add(edge.id)
    const fromKind = kinds.get(edge.from)
    const toKind = kinds.get(edge.to)
    expect(fromKind, `边「${edge.id}」起点悬空`).toBeTruthy()
    expect(toKind, `边「${edge.id}」终点悬空`).toBeTruthy()
    expect(edge.from).not.toBe(edge.to)
    expect(fromKind).not.toBe('comment')
    expect(toKind).not.toBe('comment')
    const dual = fromKind === 'branch' || fromKind === 'loop' || fromKind === 'foreach'
    if (dual) {
      expect(edge.port, `双出口节点「${edge.from}」出边缺端口`).toBeTruthy()
      const key = `${edge.from}:${edge.port}`
      expect(ports.has(key), `节点「${edge.from}」的 ${edge.port} 端口有多条出边`).toBe(false)
      ports.add(key)
    } else {
      expect(edge.port, `单出口节点「${edge.from}」不应有端口`).toBeUndefined()
    }
    expect(fromKind === 'return' || fromKind === 'restart', `结束点「${edge.from}」不应有出边`).toBe(false)
  }
  if (result.entryId !== undefined) {
    expect(kinds.has(result.entryId), `entryId「${result.entryId}」不在产物内`).toBe(true)
  }
}

/** 只断言 error 级（warning 允许：印章片段未连通时会出现 V4_UNREACHABLE） */
function lintErrorsOf(doc: LevelDocV4): string[] {
  return lintLevelDocV4(doc, { contractOf }).filter((issue) => issue.level === 'error').map((issue) => issue.message)
}

function expectLoadable(doc: LevelDocV4): LevelDocV4 {
  const validation = validateLevelDocV4(doc)
  expect(validation.errors.map((issue) => issue.message)).toEqual([])
  const loaded = loadLevelDocV4(doc)
  expect(loaded.ok, loaded.ok ? '' : loaded.errors.join(' / ')).toBe(true)
  return doc
}

function nodesOfKind(result: PresetBuildResult, kind: string): (FlowNode | BehaviorNode)[] {
  return result.nodes.filter((node) => node.kind === kind)
}

// ---------------------------------------------------------------------------
// ① 目录形状
// ---------------------------------------------------------------------------

describe('预设目录（PRESET_CATALOG）', () => {
  it('内置 4 个 flow + 7 个 behavior 预设，id 全局唯一且 docs/53 §14 要求的清单齐全', () => {
    expect(FLOW_PRESETS.map((preset) => preset.id)).toEqual([
      'sequence-grade-settle',
      'retry-n',
      'unlock-branch',
      'settle-then-replay',
    ])
    expect(BEHAVIOR_PRESETS.map((preset) => preset.id)).toEqual([
      'first-correct-once',
      'every-correct',
      'wrong-retry',
      'manual-next',
      'auto-next',
      'timed-return',
      'feedback-hint',
    ])
    expect(PRESET_CATALOG.length).toBe(11)
    expect(new Set(PRESET_IDS).size).toBe(PRESET_IDS.length)
    for (const preset of PRESET_CATALOG) {
      expect(preset.name.trim()).not.toBe('')
      expect(preset.description.trim()).not.toBe('')
      expect(['flow', 'behavior']).toContain(preset.layer)
      for (const param of preset.params) {
        expect(param.key).toMatch(NODE_ID_RE)
        expect(param.label.trim()).not.toBe('')
        expect(['expr', 'text', 'number', 'select']).toContain(param.type)
        if (param.type === 'select') expect(param.options?.length ?? 0).toBeGreaterThan(0)
      }
      expect(getPreset(preset.id)).toBe(preset)
    }
    expect(getPreset('nope')).toBeUndefined()
  })

  it('参数默认值可归一化：number 钳到数字、select 只接受 options、未知参数被丢弃', () => {
    const retry = getPreset('retry-n')
    expect(retry).toBeTruthy()
    const defaults = presetDefaults(retry!)
    expect(defaults.attempts ?? defaults.retries).toBe(1)
    const normalized = normalizePresetParams(retry!, {
      retries: '3' as unknown as Json,
      askTarget: 'local.slot',
      updateRow: 'nope' as Json,
      unknownKey: 'x' as Json,
    })
    expect(normalized.retries).toBe(3)
    expect(normalized.askTarget).toBe('local.slot')
    expect(normalized.updateRow).toBe('yes')
    expect('unknownKey' in normalized).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// ② 展开结构 + ③ 参数生效
// ---------------------------------------------------------------------------

describe('flow 预设展开', () => {
  it('默认参数展开结构合法（id 唯一/无悬空/端口协议/comment 不接线）', () => {
    const doc = baseFlowDoc()
    for (const preset of FLOW_PRESETS) {
      expectValidFragment(buildPreset(preset.id, { doc }, {}))
    }
  })

  it('sequence-grade-settle：写入 score/row 的目标与 passExpr 参数生效；updateRow=no 时去掉 v.row 节点', () => {
    const doc = baseFlowDoc()
    const result = buildPreset('sequence-grade-settle', { doc }, {
      passExpr: 'v.score >= 5',
      scoreDeltaExpr: 'local.result.scoreDelta + 1',
    })
    expectValidFragment(result)
    const assigns = nodesOfKind(result, 'assign')
    const scoreAssign = assigns.find((node) => (node as { target?: string }).target === 'v.score')
    expect(scoreAssign).toBeTruthy()
    expect(JSON.stringify(scoreAssign)).toContain('local.result.scoreDelta + 1')
    const finish = nodesOfKind(result, 'finish')[0] as { passed?: string }
    expect(finish.passed).toBe('v.score >= 5')
    expect(assigns.some((node) => (node as { target?: string }).target === 'v.row')).toBe(true)
    // 留空 passExpr = 不写 passed（缺省运行时视为 true）
    const noPass = buildPreset('sequence-grade-settle', { doc }, { passExpr: '' })
    const noPassFinish = nodesOfKind(noPass, 'finish')[0] as { passed?: string }
    expect(noPassFinish.passed).toBeUndefined()
    // 不需要进度变量：不生成 v.row 赋值节点
    const noRow = buildPreset('sequence-grade-settle', { doc }, { updateRow: 'no' })
    expect(nodesOfKind(noRow, 'assign').some((node) => (node as { target?: string }).target === 'v.row')).toBe(false)
  })

  it('retry-n：retries 参数决定 ask/branch 数量，钳制到 0–5，答错条件写在 branch', () => {
    const doc = baseFlowDoc()
    for (const [retries, attempts, branches] of [
      [0, 1, 0],
      [2, 3, 2],
      [9, 6, 5],
    ] as const) {
      const result = buildPreset('retry-n', { doc }, { retries, askTarget: 'local.slot' })
      expectValidFragment(result)
      expect(nodesOfKind(result, 'ask')).toHaveLength(attempts)
      expect(nodesOfKind(result, 'branch')).toHaveLength(branches)
      for (const ask of nodesOfKind(result, 'ask')) expect((ask as { target?: string }).target).toBe('local.slot')
      for (const branch of nodesOfKind(result, 'branch')) {
        expect((branch as { cond?: string }).cond).toBe('local.result.correct != true')
      }
    }
  })

  it('unlock-branch：附加条件合并、视图参数生成 setView、不存在的视图直接报中文错误', () => {
    const doc = baseFlowDoc()
    const result = buildPreset('unlock-branch', { doc }, {
      unlockCond: 'v.score >= 3',
      extraCond: "stateOf('choice', 'row_01', 'answered') == true",
      unlockedView: 'main',
    })
    expectValidFragment(result)
    const branch = nodesOfKind(result, 'branch')[0] as { cond: string }
    expect(branch.cond).toBe("(v.score >= 3) && (stateOf('choice', 'row_01', 'answered') == true)")
    expect(nodesOfKind(result, 'setView')).toHaveLength(1)
    expect(() => buildPreset('unlock-branch', { doc }, { lockedView: 'no-such-view' })).toThrow(/没有视图/)
  })

  it('settle-then-replay：finish 之后的链为 setView→waitShell→restart，重玩事件参数生效', () => {
    const doc = baseFlowDoc()
    const result = buildPreset('settle-then-replay', { doc }, { settledView: 'main', replayEvent: 'replayBtn.clicked' })
    expectValidFragment(result)
    const waitShell = nodesOfKind(result, 'waitShell')[0] as { event?: string }
    expect(waitShell.event).toBe('replayBtn.clicked')
    expect(nodesOfKind(result, 'restart')).toHaveLength(1)
    expect(nodesOfKind(result, 'setView')).toHaveLength(1)
    expect(() => buildPreset('settle-then-replay', { doc }, { replayEvent: 'not-an-event' })).toThrow(/必须是/)
  })
})

describe('behavior 预设展开', () => {
  it('默认参数展开结构合法；behavior 缺 typeId / 未知题型 / 未知组件会报中文错误', () => {
    const doc = baseBehaviorDoc()
    for (const preset of BEHAVIOR_PRESETS) {
      const result = buildPreset(preset.id, { doc, typeId: 'choice' }, {})
      expectValidFragment(result)
      expect(result.entryId).toBeTruthy()
      const entry = result.nodes.find((node) => node.id === result.entryId)
      expect(entry?.kind).toBe('on')
    }
    expect(() => buildPreset('first-correct-once', { doc }, {})).toThrow(/题型 id/)
    expect(() => buildPreset('first-correct-once', { doc, typeId: 'nope' }, {})).toThrow(/不存在/)
    expect(() =>
      buildPreset('first-correct-once', { doc, typeId: 'choice' }, { feedbackOk: 'not-there' }),
    ).toThrow(/没有组件/)
  })

  it('first-correct-once：事件/守卫字段/计分表达式参数生效，反馈组件生成 label.show 调用', () => {
    const doc = baseBehaviorDoc()
    const result = buildPreset('first-correct-once', { doc, typeId: 'choice' }, {
      event: 'choice1.chosen',
      stateField: 'answered',
      scoreExpr: 'q.scoring * 2',
      feedbackOk: 'feedback',
    })
    expectValidFragment(result)
    const on = nodesOfKind(result, 'on')[0] as { event?: string }
    expect(on.event).toBe('choice1.chosen')
    const branchConds = nodesOfKind(result, 'branch').map((node) => (node as { cond?: string }).cond)
    expect(branchConds).toContain('q.state.answered')
    const returns = nodesOfKind(result, 'return').map((node) => (node as { result?: string }).result)
    expect(returns).toContain("{ status: 'answered', correct: true, scoreDelta: q.scoring * 2 }")
    const calls = nodesOfKind(result, 'call') as { target?: string; method?: string; arg?: string }[]
    expect(calls.some((call) => call.target === 'feedback' && call.method === 'show')).toBe(true)
    // 非法事件形态（start / 缺 .）直接拒绝
    expect(() => buildPreset('first-correct-once', { doc, typeId: 'choice' }, { event: 'start' })).toThrow(/组件事件/)
    expect(() => buildPreset('first-correct-once', { doc, typeId: 'choice' }, { event: 'clicked' })).toThrow(/形式/)
  })

  it('wrong-retry：计错字段/次数上限进入 assign 与 branch；manual-next/auto-next 的返回时机不同', () => {
    const doc = baseBehaviorDoc()
    const retry = buildPreset('wrong-retry', { doc, typeId: 'choice' }, { wrongKey: 'wrong', maxAttempts: 2 })
    expectValidFragment(retry)
    const assign = nodesOfKind(retry, 'assign')[0] as { target?: string; value?: { expr?: string } }
    expect(assign.target).toBe('q.state.wrong')
    expect(assign.value?.expr).toBe('q.state.wrong + 1')
    const limit = nodesOfKind(retry, 'branch').find(
      (node) => (node as { cond?: string }).cond === 'q.state.wrong >= 2',
    )
    expect(limit).toBeTruthy()

    const manual = buildPreset('manual-next', { doc, typeId: 'choice' }, { event: 'nextBtn.clicked' })
    expectValidFragment(manual)
    expect((nodesOfKind(manual, 'on')[0] as { event?: string }).event).toBe('nextBtn.clicked')
    expect(nodesOfKind(manual, 'return')).toHaveLength(2)

    const auto = buildPreset('auto-next', { doc, typeId: 'choice' }, { scoreExpr: 'q.scoring + 1' })
    expectValidFragment(auto)
    expect(nodesOfKind(auto, 'return')).toHaveLength(1)
    expect((nodesOfKind(auto, 'assign')[0] as { target?: string }).target).toBe('q.state.answered')
  })

  it('timed-return：超时分支返回 timeout，答对分支停表；feedback-hint 的提示文案被安全转义', () => {
    const doc = baseBehaviorDoc()
    const timed = buildPreset('timed-return', { doc, typeId: 'choice' }, { timeoutEvent: 'timer1.tick' })
    expectValidFragment(timed)
    const timeoutReturn = nodesOfKind(timed, 'return').find((node) =>
      String((node as { result?: string }).result).includes("status: 'timeout'"),
    )
    expect(timeoutReturn).toBeTruthy()
    expect(nodesOfKind(timed, 'call').some((node) => (node as { method?: string }).method === 'stop')).toBe(true)
    expect(nodesOfKind(timed, 'on').map((node) => (node as { event?: string }).event)).toContain('timer1.tick')

    const hint = buildPreset('feedback-hint', { doc, typeId: 'choice' }, {
      hintText: "它说：'再听'\\一遍",
      feedbackTarget: 'feedback',
    })
    expectValidFragment(hint)
    const call = nodesOfKind(hint, 'call')[0] as { arg?: string }
    expect(call.arg).toContain("\\'再听\\'")
    expect(call.arg).toContain('\\\\一遍')
  })
})

// ---------------------------------------------------------------------------
// ④ 插入夹具文档后 lint 0 error
// ---------------------------------------------------------------------------

describe('插入文档后校验', () => {
  it('全部 flow 预设插入后 validate 0 error、lint 0 error（仅允许 unreachable 警告）', () => {
    for (const preset of FLOW_PRESETS) {
      const doc = baseFlowDoc()
      const built = buildPreset(preset.id, { doc }, {})
      const next: LevelDocV4 = {
        ...doc,
        content: { ...doc.content, flow: mergePresetResult(doc.content.flow, built) },
      }
      expectLoadable(next)
      expect(lintErrorsOf(next), `预设 ${preset.id} 插入后产生 lint error`).toEqual([])
    }
  })

  it('全部 behavior 预设插入后 validate 0 error、lint 0 error', () => {
    for (const preset of BEHAVIOR_PRESETS) {
      const doc = baseBehaviorDoc()
      const built = buildPreset(preset.id, { doc, typeId: 'choice' }, {})
      const next = applyPresetResultToDoc(doc, 'behavior', 'choice', built)
      expectLoadable(next)
      expect(lintErrorsOf(next), `预设 ${preset.id} 插入后产生 lint error`).toEqual([])
      // 只断言「由本次展开节点引入」的 warning（夹具 flow 自身未结算等基线与预设无关）
      const presetNodeIds = new Set(built.nodes.map((node) => node.id))
      const introduced = lintLevelDocV4(next, { contractOf }).filter(
        (issue) => issue.level === 'warning' && issue.nodeId !== undefined && presetNodeIds.has(issue.nodeId),
      )
      expect(introduced.map((issue) => `${issue.code}:${issue.message}`)).toEqual([])
    }
  })

  it('insertPresetIntoDoc 自动补齐 flow 变量声明；重复插入产生新实例 id 且不冲突', () => {
    const doc = bareFlowDoc()
    expect(doc.content.flow.vars ?? []).toEqual([])
    const first = insertPresetIntoDoc(doc, 'sequence-grade-settle', { params: { passExpr: 'v.score >= 10' } })
    expect(first.declarations.map((field) => field.key)).toEqual(['score', 'row'])
    expect(first.doc.content.flow.vars?.map((field) => field.key)).toEqual(['score', 'row'])
    expectLoadable(first.doc)
    expect(lintErrorsOf(first.doc)).toEqual([])

    const second = insertPresetIntoDoc(first.doc, 'sequence-grade-settle', { params: { passExpr: 'v.score >= 10' } })
    expect(second.declarations).toEqual([])
    const firstIds = new Set(first.result.nodes.map((node) => node.id))
    for (const node of second.result.nodes) expect(firstIds.has(node.id)).toBe(false)
    expectValidFragment(second.result)
    expectLoadable(second.doc)
    expect(lintErrorsOf(second.doc)).toEqual([])
    // 预设依赖的声明表与展开一致
    expect(presetDeclarations('sequence-grade-settle').map((field) => field.key)).toEqual(['score', 'row'])
    expect(presetDeclarations('sequence-grade-settle', { updateRow: 'no' }).map((field) => field.key)).toEqual(['score'])
    expect(presetDeclarations('settle-then-replay').map((field) => field.key)).toEqual(['score'])
    expect(presetDeclarations('first-correct-once')).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// ⑤ 插入 → 连接 → 无头跑通
// ---------------------------------------------------------------------------

describe('预设端到端（插入 → 连接 → headless）', () => {
  it('sequence-grade-settle 插入后接上 start 即可无头通关（每题 scoreDelta 累加、finish 读取 v.score）', async () => {
    const doc = baseFlowDoc()
    const choice = getType(doc, 'choice')
    if (!choice) throw new Error('夹具缺少 choice 题型')
    // 让每题立刻返回（模拟自动判定的题型行为），scoreDelta 取行内 scoring
    choice.behavior = {
      logicVersion: 3,
      kind: 'behavior',
      nodes: [
        { id: 'b_start', kind: 'on', event: 'start' },
        { id: 'b_ret', kind: 'return', result: "{ status: 'answered', correct: true, scoreDelta: q.scoring }" },
      ],
      edges: [{ id: 'be_1', from: 'b_start', to: 'b_ret' }],
    }
    const inserted = insertPresetIntoDoc(doc, 'sequence-grade-settle', {
      params: { passExpr: 'v.score >= 20' },
    })
    const entryId = inserted.result.entryId
    expect(entryId).toBeTruthy()
    const flow = connectProgramNodes(inserted.doc.content.flow, 'f_start', entryId as string)
    const connected: LevelDocV4 = { ...inserted.doc, content: { ...inserted.doc.content, flow } }
    expectLoadable(connected)
    expect(lintErrorsOf(connected)).toEqual([])

    const report = await runLevelHeadless(connected, { timeoutMs: 5000 })
    expect(report.error).toBeUndefined()
    expect(report.finished).toBe(true)
    expect(report.deck).toHaveLength(2) // 夹具第 3 行是草稿，自动题单排除
    expect(report.questions).toHaveLength(2)
    expect(report.result).toEqual({ score: 20, passed: true })
    expect(report.passed).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// ⑥ 展开即普通节点（可改）
// ---------------------------------------------------------------------------

describe('预设产物是普通节点（无隐藏策略）', () => {
  it('节点/边不含预设元数据，作者改节点字段后仍可装载（无运行期隐藏策略）', () => {
    const doc = baseFlowDoc()
    const result = buildPreset('sequence-grade-settle', { doc }, { passExpr: 'v.score >= 10' })
    for (const node of result.nodes) {
      expect(Object.keys(node)).not.toContain('preset')
      expect(Object.keys(node)).not.toContain('policy')
      expect(JSON.stringify(node)).not.toContain('"preset"')
    }
    const finish = nodesOfKind(result, 'finish')[0] as { id: string; passed?: string }
    const edited = result.nodes.map((node) => (node.id === finish.id ? { ...node, passed: 'v.score >= 0' } : node))
    const next: LevelDocV4 = {
      ...doc,
      content: { ...doc.content, flow: mergePresetResult(doc.content.flow, { ...result, nodes: edited }) },
    }
    expectLoadable(next)
    expect(lintErrorsOf(next)).toEqual([])
    const flow = next.content.flow.edges.find((edge) => edge.from === finish.id) as GraphEdge | undefined
    expect(flow).toBeUndefined() // finish 是结束点，被修改的是 passed 不是接线
  })
})
