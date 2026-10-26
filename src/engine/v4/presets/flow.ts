/**
 * flow 层预设目录（docs/53 §14；docs/51 §3.5 表格的「流程」行）。
 *
 * 全部为**印章式节点组 + comment**：返回普通 FlowNode/FlowEdge，不写策略元数据；
 * 作者插入后可改参数、连线、删节点。节点 id 由 `createPresetIds` 程序化生成
 * （`ps_<预设>_<实例>_<角色>`），重复插入自动递增实例号，不与现有图冲突。
 *
 * 依赖约定（由模板/样例统一，插入到不含这些声明的文档时画廊会显示 lint 提示）：
 * - `v.score`：结算账本（session.finish 从 v.score 读分数，docs/53 §9 第 7 步）；
 * - `v.row`：当前进度（shell 进度绑定常用 `v.row`）；
 * - run 变量声明可用 `presetDeclarations(id, params)` 取得，`insertPresetIntoDoc` 会自动补齐。
 */
import { createPresetIds, exprOf, numOf, textOf } from './ids'
import { isV4LocalId } from '../model'
import type { FlowNode, GraphEdge } from '../model'
import type { PresetBuildResult, PresetDef } from './types'

/** 预设内部注释节点文本（同时作为 build 结果的 comment 字段） */
const SEQUENCE_COMMENT =
  '预设 · 顺序出题：foreach(run.questions) 每题 ask 一次 → v.score 累加 scoreDelta → v.row 更新进度 → 遍历结束切结算视图并 finish。数据增删/重排不需要改本图。'

const RETRY_COMMENT =
  '预设 · 答错重试：同一题最多作答「重试次数 + 1」次；答对（或次数用尽）后累加 scoreDelta、结算。注意再次 ask 同一槽位时 q.state 保留。'

const UNLOCK_COMMENT =
  '预设 · 解锁分支：按条件（v.score / 已有 stateOf 查询等）分两条路，分别 finish(true)/(false)；可选在两条路上切不同 shell 视图。'

const SETTLE_REPLAY_COMMENT =
  '预设 · 结算后展示/重玩：finish →（可选 setView 结算视图）→ waitShell 等待「重玩」按钮 → restart。注意：finish 之后只允许 shell 命令/setView/waitShell/wait/restart。'

function assertViewExists(view: string, docViews: { id: string }[], presetName: string): void {
  if (view === '') return
  if (!isV4LocalId(view)) {
    throw new Error(`${presetName}：视图 id「${view}」形态非法（字母/下划线开头，不含 .）`)
  }
  if (!docViews.some((candidate) => candidate.id === view)) {
    throw new Error(`${presetName}：文档中没有视图「${view}」`)
  }
}

const COMPONENT_EVENT_RE = /^[A-Za-z_][A-Za-z0-9_-]{0,63}\.[A-Za-z_][A-Za-z0-9_-]{0,63}$/

function commentNode(id: string, text: string): FlowNode {
  return { id, kind: 'comment', text }
}

/** 顺序遍历题单 → ask → 应用 scoreDelta → v.row → finish */
const sequenceGradeSettle: PresetDef = {
  id: 'sequence-grade-settle',
  name: '顺序出题 · 计分结算',
  description:
    '最常用的关卡主流程：foreach 遍历题单，每题 ask 一次，把返回值里的 scoreDelta 累加到 v.score、更新 v.row 进度，遍历完切结算视图并 finish。改数据（加题/删题/草稿/排序）无需改图。',
  layer: 'flow',
  params: [
    { key: 'passExpr', label: '过关条件表达式', type: 'expr', default: 'v.score >= 60' },
    { key: 'scoreDeltaExpr', label: '每题计分增量表达式', type: 'expr', default: 'local.result.scoreDelta || 0' },
    {
      key: 'updateRow',
      label: '更新进度变量（v.row）',
      type: 'select',
      default: 'yes',
      options: [
        { value: 'yes', label: '更新（推荐）' },
        { value: 'no', label: '不更新' },
      ],
    },
  ],
  build(ctx, params): PresetBuildResult {
    const ids = createPresetIds(ctx.doc, 'flow', ctx.typeId, 'sequence-grade-settle')
    const passExpr = exprOf(params, 'passExpr', '')
    const scoreDeltaExpr = exprOf(params, 'scoreDeltaExpr', 'local.result.scoreDelta || 0') || 'local.result.scoreDelta || 0'
    const updateRow = textOf(params, 'updateRow', 'yes') !== 'no'
    const commentId = ids.node('comment')
    const foreachId = ids.node('foreach')
    const askId = ids.node('ask')
    const addScoreId = ids.node('addscore')
    const setRowId = updateRow ? ids.node('setrow') : undefined
    const finishId = ids.node('finish')
    const nodes: FlowNode[] = [
      commentNode(commentId, SEQUENCE_COMMENT),
      { id: foreachId, kind: 'foreach', items: 'run.questions', itemVar: 'slot', indexVar: 'idx' },
      { id: askId, kind: 'ask', target: 'local.slot', resultVar: 'result' },
      { id: addScoreId, kind: 'assign', target: 'v.score', value: { expr: `v.score + (${scoreDeltaExpr})` } },
    ]
    if (setRowId) nodes.push({ id: setRowId, kind: 'assign', target: 'v.row', value: { expr: 'local.idx + 1' } })
    nodes.push({ id: finishId, kind: 'finish', ...(passExpr === '' ? {} : { passed: passExpr }) })
    const edges: GraphEdge[] = [ids.edge(foreachId, askId, 'true'), ids.edge(askId, addScoreId)]
    if (setRowId) edges.push(ids.edge(addScoreId, setRowId), ids.edge(setRowId, foreachId))
    else edges.push(ids.edge(addScoreId, foreachId))
    edges.push(ids.edge(foreachId, finishId, 'false'))
    return { nodes, edges, entryId: foreachId, comment: SEQUENCE_COMMENT }
  },
}

/** 答错重试 N 次（可配置总作答次数 1–6） */
const retryN: PresetDef = {
  id: 'retry-n',
  name: '答错重试 N 次',
  description:
    '同一题最多作答「重试次数 + 1」次：每次 ask 后检查返回值，答错则再次 ask（q.state 保留），答对或次数用尽后累加 scoreDelta 并 finish。适合允许重听的听辨/选择题。',
  layer: 'flow',
  params: [
    { key: 'retries', label: '答错后可重试次数', type: 'number', default: 1 },
    { key: 'askTarget', label: '作答目标表达式', type: 'expr', default: 'run.questions[0]' },
    { key: 'passExpr', label: '过关条件表达式', type: 'expr', default: 'v.score >= 20' },
    { key: 'scoreDeltaExpr', label: '每题计分增量表达式', type: 'expr', default: 'local.result.scoreDelta || 0' },
    {
      key: 'updateRow',
      label: '更新进度变量（v.row）',
      type: 'select',
      default: 'yes',
      options: [
        { value: 'yes', label: '更新（推荐）' },
        { value: 'no', label: '不更新' },
      ],
    },
  ],
  build(ctx, params): PresetBuildResult {
    const ids = createPresetIds(ctx.doc, 'flow', ctx.typeId, 'retry-n')
    const retries = numOf(params, 'retries', 1, 0, 5)
    const askTarget = exprOf(params, 'askTarget', 'run.questions[0]') || 'run.questions[0]'
    const passExpr = exprOf(params, 'passExpr', '')
    const scoreDeltaExpr = exprOf(params, 'scoreDeltaExpr', 'local.result.scoreDelta || 0') || 'local.result.scoreDelta || 0'
    const updateRow = textOf(params, 'updateRow', 'yes') !== 'no'
    const attempts = retries + 1
    const commentId = ids.node('comment')
    const askIds: string[] = []
    const retryIds: string[] = []
    for (let index = 0; index < attempts; index += 1) askIds.push(ids.node('ask'))
    for (let index = 0; index < retries; index += 1) retryIds.push(ids.node('retry'))
    const addScoreId = ids.node('addscore')
    const setRowId = updateRow ? ids.node('setrow') : undefined
    const finishId = ids.node('finish')
    const nodes: FlowNode[] = [commentNode(commentId, RETRY_COMMENT)]
    for (const askId of askIds) nodes.push({ id: askId, kind: 'ask', target: askTarget, resultVar: 'result' })
    for (const retryId of retryIds) {
      nodes.push({ id: retryId, kind: 'branch', cond: 'local.result.correct != true' })
    }
    nodes.push({ id: addScoreId, kind: 'assign', target: 'v.score', value: { expr: `v.score + (${scoreDeltaExpr})` } })
    if (setRowId) nodes.push({ id: setRowId, kind: 'assign', target: 'v.row', value: { expr: 'v.row + 1' } })
    nodes.push({ id: finishId, kind: 'finish', ...(passExpr === '' ? {} : { passed: passExpr }) })
    const edges: GraphEdge[] = []
    for (let index = 0; index < attempts; index += 1) {
      if (index < retries) {
        edges.push(ids.edge(askIds[index], retryIds[index]))
        edges.push(ids.edge(retryIds[index], askIds[index + 1], 'true'))
        edges.push(ids.edge(retryIds[index], addScoreId, 'false'))
      } else {
        edges.push(ids.edge(askIds[index], addScoreId))
      }
    }
    if (setRowId) edges.push(ids.edge(addScoreId, setRowId), ids.edge(setRowId, finishId))
    else edges.push(ids.edge(addScoreId, finishId))
    return { nodes, edges, entryId: askIds[0], comment: RETRY_COMMENT }
  },
}

/** 按 score / stateOf 分支解锁（可选切不同视图） */
const unlockBranch: PresetDef = {
  id: 'unlock-branch',
  name: '按条件解锁分支',
  description:
    '按表达式分两条路：通过 finish(true) / 未通过 finish(false)，两条路可各自切一个 shell 视图。条件可写 v.score、run.*，或用 stateOf("题型","行","字段") 读某题实例态（如是否答对过）。',
  layer: 'flow',
  params: [
    { key: 'unlockCond', label: '解锁条件表达式', type: 'expr', default: 'v.score >= 30' },
    { key: 'extraCond', label: '附加条件（可空，如 stateOf(...) == true）', type: 'expr', default: '' },
    { key: 'unlockedView', label: '解锁后切换的视图（可空）', type: 'text', default: '' },
    { key: 'lockedView', label: '未解锁时切换的视图（可空）', type: 'text', default: '' },
  ],
  build(ctx, params): PresetBuildResult {
    const ids = createPresetIds(ctx.doc, 'flow', ctx.typeId, 'unlock-branch')
    const unlockCond = exprOf(params, 'unlockCond', 'v.score >= 30') || 'v.score >= 30'
    const extraCond = exprOf(params, 'extraCond', '')
    const cond = extraCond === '' ? unlockCond : `(${unlockCond}) && (${extraCond})`
    const unlockedView = textOf(params, 'unlockedView', '')
    const lockedView = textOf(params, 'lockedView', '')
    assertViewExists(unlockedView, ctx.doc.content.shell.views, '按条件解锁分支')
    assertViewExists(lockedView, ctx.doc.content.shell.views, '按条件解锁分支')
    const commentId = ids.node('comment')
    const branchId = ids.node('branch')
    const unlockedSetViewId = unlockedView === '' ? undefined : ids.node('unlockedview')
    const passedFinishId = ids.node('finish')
    const lockedSetViewId = lockedView === '' ? undefined : ids.node('lockedview')
    const failedFinishId = ids.node('finishfail')
    const nodes: FlowNode[] = [commentNode(commentId, UNLOCK_COMMENT), { id: branchId, kind: 'branch', cond }]
    if (unlockedSetViewId) nodes.push({ id: unlockedSetViewId, kind: 'setView', view: unlockedView })
    nodes.push({ id: passedFinishId, kind: 'finish', passed: 'true' })
    if (lockedSetViewId) nodes.push({ id: lockedSetViewId, kind: 'setView', view: lockedView })
    nodes.push({ id: failedFinishId, kind: 'finish', passed: 'false' })
    const edges: GraphEdge[] = []
    if (unlockedSetViewId) {
      edges.push(ids.edge(branchId, unlockedSetViewId, 'true'), ids.edge(unlockedSetViewId, passedFinishId))
    } else {
      edges.push(ids.edge(branchId, passedFinishId, 'true'))
    }
    if (lockedSetViewId) {
      edges.push(ids.edge(branchId, lockedSetViewId, 'false'), ids.edge(lockedSetViewId, failedFinishId))
    } else {
      edges.push(ids.edge(branchId, failedFinishId, 'false'))
    }
    return { nodes, edges, entryId: branchId, comment: UNLOCK_COMMENT }
  },
}

/** 结算后展示 → 等按钮 → 重开 */
const settleThenReplay: PresetDef = {
  id: 'settle-then-replay',
  name: '结算后展示与重玩',
  description:
    'finish 记录结算 →（可选切到结算视图）→ waitShell 等待「重玩」按钮事件 → restart 重开本关。演示 finish 之后仍允许的节点（call/setView/waitShell/wait/restart）。',
  layer: 'flow',
  params: [
    { key: 'passExpr', label: '过关条件表达式（可空 = 恒通过）', type: 'expr', default: 'v.score >= 30' },
    { key: 'settledView', label: '结算后切换的视图（可空）', type: 'text', default: '' },
    { key: 'replayEvent', label: '重玩按钮事件（<shell组件>.<事件>）', type: 'text', default: 'replayBtn.clicked' },
  ],
  build(ctx, params): PresetBuildResult {
    const ids = createPresetIds(ctx.doc, 'flow', ctx.typeId, 'settle-then-replay')
    const passExpr = exprOf(params, 'passExpr', '')
    const settledView = textOf(params, 'settledView', '')
    const replayEvent = textOf(params, 'replayEvent', 'replayBtn.clicked') || 'replayBtn.clicked'
    assertViewExists(settledView, ctx.doc.content.shell.views, '结算后展示与重玩')
    if (!COMPONENT_EVENT_RE.test(replayEvent)) {
      throw new Error(
        `结算后展示与重玩：重玩事件「${replayEvent}」必须是 "<shell 组件 id>.<事件名>" 形式（如 replayBtn.clicked）`,
      )
    }
    const commentId = ids.node('comment')
    const finishId = ids.node('finish')
    const setViewId = settledView === '' ? undefined : ids.node('settledview')
    const waitShellId = ids.node('waitshell')
    const restartId = ids.node('restart')
    const nodes: FlowNode[] = [
      commentNode(commentId, SETTLE_REPLAY_COMMENT),
      { id: finishId, kind: 'finish', ...(passExpr === '' ? {} : { passed: passExpr }) },
    ]
    if (setViewId) nodes.push({ id: setViewId, kind: 'setView', view: settledView })
    nodes.push({ id: waitShellId, kind: 'waitShell', event: replayEvent }, { id: restartId, kind: 'restart' })
    const edges: GraphEdge[] = [ids.edge(finishId, setViewId ?? waitShellId)]
    if (setViewId) edges.push(ids.edge(setViewId, waitShellId))
    edges.push(ids.edge(waitShellId, restartId))
    return { nodes, edges, entryId: finishId, comment: SETTLE_REPLAY_COMMENT }
  },
}

/** flow 层内置预设（顺序即画廊展示顺序） */
export const FLOW_PRESETS: PresetDef[] = [sequenceGradeSettle, retryN, unlockBranch, settleThenReplay]
