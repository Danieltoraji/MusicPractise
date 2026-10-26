/**
 * behavior 层预设目录（docs/53 §14；docs/51 §3.5 表格的「题型行为」行）。
 *
 * 每个预设展开成「一个 `on <组件事件>` 入口 + 普通节点链 + comment」的印章片段：
 * 题型原有的 `on start` 不受影响（不会新增第二个 on start），插入后作者可继续改/删。
 * 需要写入的题态字段（如 `q.state.answered` / `q.state.wrong`）必须已在题型 state schema 中声明——
 * 预设无法代改 schema，画廊会预览插入后的 lint 并提示缺失字段。
 */
import { createPresetIds, exprOf, exprString, numOf, textOf } from './ids'
import { getType, isV4LocalId, type BehaviorNode, type CallNode, type GraphEdge } from '../model'
import type { PresetBuildResult, PresetCtx, PresetDef } from './types'

const COMPONENT_EVENT_RE = /^[A-Za-z_][A-Za-z0-9_-]{0,63}\.[A-Za-z_][A-Za-z0-9_-]{0,63}$/

function commentNode(id: string, text: string): BehaviorNode {
  return { id, kind: 'comment', text }
}

function assertEvent(event: string, presetName: string): void {
  if (event === 'start' || event.startsWith('internal.')) {
    throw new Error(`${presetName}：事件参数必须是「组件事件」（<surface组件>.<事件>），不能用 start / internal.*`)
  }
  if (!COMPONENT_EVENT_RE.test(event)) {
    throw new Error(`${presetName}：事件「${event}」必须是 "<surface 组件 id>.<事件名>" 形式（如 choice1.chosen）`)
  }
}

function assertStateKey(key: string, presetName: string): void {
  if (!isV4LocalId(key)) {
    throw new Error(`${presetName}：题态字段名「${key}」形态非法（字母/下划线开头，不含 .)`)
  }
}

/** 表面组件存在性校验（可选组件参数写了就必须在题型 surface 里） */
function assertSurfaceComponent(ctx: PresetCtx, componentId: string, presetName: string): void {
  if (componentId === '') return
  if (ctx.typeId === undefined) throw new Error(`${presetName}：行为预设需要题型 id（typeId）`)
  const type = getType(ctx.doc, ctx.typeId)
  if (!type) throw new Error(`${presetName}：题型「${ctx.typeId}」不存在`)
  if (!type.surface.components.some((component) => component.id === componentId)) {
    throw new Error(`${presetName}：题型「${type.id}」的 surface 里没有组件「${componentId}」`)
  }
}

/** 反馈调用节点（可选；text/tone 走 label.show 契约） */
function feedbackCall(id: string, componentId: string, text: string, tone: 'success' | 'error' | 'info'): CallNode {
  return {
    id,
    kind: 'call',
    target: componentId,
    method: 'show',
    arg: `{ text: ${exprString(text)}, tone: '${tone}' }`,
  }
}

/** 首次答对只计一次（q.state.<stateField> 守卫；重复答对返回 0 分） */
const firstCorrectOnce: PresetDef = {
  id: 'first-correct-once',
  name: '首次答对只计一次',
  description:
    '答对时先看 q.state.<守卫字段>：已答对过 → 返回 0 分（不重复计分）；首次答对 → 置守卫字段并返回 scoreDelta。答错只给反馈、不返回，继续等待事件（可重试）。',
  layer: 'behavior',
  params: [
    { key: 'event', label: '作答事件（<组件>.<事件>）', type: 'text', default: 'choice1.chosen' },
    { key: 'correctCond', label: '答对判定表达式', type: 'expr', default: 'event.payload.index == q.answerIndex' },
    { key: 'scoreExpr', label: '答对计分表达式', type: 'expr', default: 'q.scoring' },
    { key: 'stateField', label: '守卫题态字段（q.state.*）', type: 'text', default: 'answered' },
    { key: 'feedbackOk', label: '答对反馈组件（可空）', type: 'text', default: '' },
    { key: 'feedbackBad', label: '答错反馈组件（可空）', type: 'text', default: '' },
  ],
  build(ctx, params): PresetBuildResult {
    const event = textOf(params, 'event', 'choice1.chosen') || 'choice1.chosen'
    const correctCond = exprOf(params, 'correctCond', 'event.payload.index == q.answerIndex') || 'true'
    const scoreExpr = exprOf(params, 'scoreExpr', 'q.scoring') || '0'
    const stateField = textOf(params, 'stateField', 'answered') || 'answered'
    const feedbackOk = textOf(params, 'feedbackOk', '')
    const feedbackBad = textOf(params, 'feedbackBad', '')
    assertEvent(event, '首次答对只计一次')
    assertStateKey(stateField, '首次答对只计一次')
    assertSurfaceComponent(ctx, feedbackOk, '首次答对只计一次')
    assertSurfaceComponent(ctx, feedbackBad, '首次答对只计一次')
    const ids = createPresetIds(ctx.doc, 'behavior', ctx.typeId, 'first-correct-once')
    const commentId = ids.node('comment')
    const onId = ids.node('on')
    const isCorrectId = ids.node('correct')
    const guardId = ids.node('guard')
    const duplicateRetId = ids.node('dupret')
    const markId = ids.node('mark')
    const feedbackOkId = feedbackOk === '' ? undefined : ids.node('feedbackok')
    const okRetId = ids.node('return')
    const feedbackBadId = feedbackBad === '' ? undefined : ids.node('feedbackbad')
    const nodes: BehaviorNode[] = [
      commentNode(commentId, '预设 · 首次答对只计一次：q.state.<守卫字段> 防止重复计分；答错只反馈、可重试'),
      { id: onId, kind: 'on', event },
      { id: isCorrectId, kind: 'branch', cond: correctCond },
      { id: guardId, kind: 'branch', cond: `q.state.${stateField}` },
      { id: duplicateRetId, kind: 'return', result: "{ status: 'answered', correct: true, scoreDelta: 0 }" },
      { id: markId, kind: 'assign', target: `q.state.${stateField}`, value: { expr: 'true' } },
    ]
    const edges: GraphEdge[] = [
      ids.edge(onId, isCorrectId),
      ids.edge(isCorrectId, guardId, 'true'),
      ids.edge(guardId, duplicateRetId, 'true'),
    ]
    if (feedbackOkId) {
      nodes.push(feedbackCall(feedbackOkId, feedbackOk, '答对了！', 'success'))
      nodes.push({ id: okRetId, kind: 'return', result: `{ status: 'answered', correct: true, scoreDelta: ${scoreExpr} }` })
      edges.push(ids.edge(guardId, markId, 'false'), ids.edge(markId, feedbackOkId), ids.edge(feedbackOkId, okRetId))
    } else {
      nodes.push({ id: okRetId, kind: 'return', result: `{ status: 'answered', correct: true, scoreDelta: ${scoreExpr} }` })
      edges.push(ids.edge(guardId, markId, 'false'), ids.edge(markId, okRetId))
    }
    if (feedbackBadId) {
      nodes.push(feedbackCall(feedbackBadId, feedbackBad, '再试一次。', 'error'))
      edges.push(ids.edge(isCorrectId, feedbackBadId, 'false'))
    }
    return { nodes, edges, entryId: onId, comment: '首次答对只计一次' }
  },
}

/** 每次答对都计分（同类事件可反复触发 return，调用在首个 return 后结束） */
const everyCorrect: PresetDef = {
  id: 'every-correct',
  name: '每次答对都计分',
  description:
    '不带「只计一次」守卫：每次答对都返回 scoreDelta（适合暴露给流程反复 ask 的题型）；答错只给反馈、继续等待事件。若同一调用需要多次计分，应由流程/题型自行多次 ask。',
  layer: 'behavior',
  params: [
    { key: 'event', label: '作答事件（<组件>.<事件>）', type: 'text', default: 'choice1.chosen' },
    { key: 'correctCond', label: '答对判定表达式', type: 'expr', default: 'event.payload.index == q.answerIndex' },
    { key: 'scoreExpr', label: '答对计分表达式', type: 'expr', default: 'q.scoring' },
    { key: 'feedbackOk', label: '答对反馈组件（可空）', type: 'text', default: '' },
    { key: 'feedbackBad', label: '答错反馈组件（可空）', type: 'text', default: '' },
  ],
  build(ctx, params): PresetBuildResult {
    const event = textOf(params, 'event', 'choice1.chosen') || 'choice1.chosen'
    const correctCond = exprOf(params, 'correctCond', 'event.payload.index == q.answerIndex') || 'true'
    const scoreExpr = exprOf(params, 'scoreExpr', 'q.scoring') || '0'
    const feedbackOk = textOf(params, 'feedbackOk', '')
    const feedbackBad = textOf(params, 'feedbackBad', '')
    assertEvent(event, '每次答对都计分')
    assertSurfaceComponent(ctx, feedbackOk, '每次答对都计分')
    assertSurfaceComponent(ctx, feedbackBad, '每次答对都计分')
    const ids = createPresetIds(ctx.doc, 'behavior', ctx.typeId, 'every-correct')
    const commentId = ids.node('comment')
    const onId = ids.node('on')
    const isCorrectId = ids.node('correct')
    const feedbackOkId = feedbackOk === '' ? undefined : ids.node('feedbackok')
    const okRetId = ids.node('return')
    const feedbackBadId = feedbackBad === '' ? undefined : ids.node('feedbackbad')
    const nodes: BehaviorNode[] = [
      commentNode(commentId, '预设 · 每次答对都计分：无「只计一次」守卫，答对即返回 scoreDelta'),
      { id: onId, kind: 'on', event },
      { id: isCorrectId, kind: 'branch', cond: correctCond },
    ]
    const edges: GraphEdge[] = [ids.edge(onId, isCorrectId), ids.edge(isCorrectId, feedbackOkId ?? okRetId, 'true')]
    nodes.push({ id: okRetId, kind: 'return', result: `{ status: 'answered', correct: true, scoreDelta: ${scoreExpr} }` })
    if (feedbackOkId) {
      nodes.push(feedbackCall(feedbackOkId, feedbackOk, '答对了！', 'success'))
      edges.push(ids.edge(feedbackOkId, okRetId))
    }
    if (feedbackBadId) {
      nodes.push(feedbackCall(feedbackBadId, feedbackBad, '再想想。', 'error'))
      edges.push(ids.edge(isCorrectId, feedbackBadId, 'false'))
    }
    return { nodes, edges, entryId: onId, comment: '每次答对都计分' }
  },
}

/** 答错重试（题态计错次数；超过上限返回 skipped） */
const wrongRetry: PresetDef = {
  id: 'wrong-retry',
  name: '答错重试（含次数上限）',
  description:
    '答对 → 计分返回；答错 → q.state.<计错字段> +1 并给反馈，未超过次数上限时保留调用继续等待；达到上限 → 返回 skipped（流程可照常推进）。',
  layer: 'behavior',
  params: [
    { key: 'event', label: '作答事件（<组件>.<事件>）', type: 'text', default: 'choice1.chosen' },
    { key: 'correctCond', label: '答对判定表达式', type: 'expr', default: 'event.payload.index == q.answerIndex' },
    { key: 'scoreExpr', label: '答对计分表达式', type: 'expr', default: 'q.scoring' },
    { key: 'wrongKey', label: '计错题态字段（q.state.*）', type: 'text', default: 'wrong' },
    { key: 'maxAttempts', label: '最多答错次数', type: 'number', default: 3 },
    { key: 'feedbackOk', label: '答对反馈组件（可空）', type: 'text', default: '' },
    { key: 'feedbackBad', label: '答错反馈组件（可空）', type: 'text', default: '' },
  ],
  build(ctx, params): PresetBuildResult {
    const event = textOf(params, 'event', 'choice1.chosen') || 'choice1.chosen'
    const correctCond = exprOf(params, 'correctCond', 'event.payload.index == q.answerIndex') || 'true'
    const scoreExpr = exprOf(params, 'scoreExpr', 'q.scoring') || '0'
    const wrongKey = textOf(params, 'wrongKey', 'wrong') || 'wrong'
    const maxAttempts = numOf(params, 'maxAttempts', 3, 1, 10)
    const feedbackOk = textOf(params, 'feedbackOk', '')
    const feedbackBad = textOf(params, 'feedbackBad', '')
    assertEvent(event, '答错重试')
    assertStateKey(wrongKey, '答错重试')
    assertSurfaceComponent(ctx, feedbackOk, '答错重试')
    assertSurfaceComponent(ctx, feedbackBad, '答错重试')
    const ids = createPresetIds(ctx.doc, 'behavior', ctx.typeId, 'wrong-retry')
    const commentId = ids.node('comment')
    const onId = ids.node('on')
    const isCorrectId = ids.node('correct')
    const okRetId = ids.node('return')
    const feedbackOkId = feedbackOk === '' ? undefined : ids.node('feedbackok')
    const markWrongId = ids.node('markwrong')
    const feedbackBadId = feedbackBad === '' ? undefined : ids.node('feedbackbad')
    const limitId = ids.node('limit')
    const skippedRetId = ids.node('skipret')
    const markWrong: BehaviorNode = {
      id: markWrongId,
      kind: 'assign',
      target: `q.state.${wrongKey}`,
      value: { expr: `q.state.${wrongKey} + 1` },
    }
    const nodes: BehaviorNode[] = [
      commentNode(
        commentId,
        `预设 · 答错重试：q.state.${wrongKey} 计错；答错未超上限继续等待，超上限返回 skipped`,
      ),
      { id: onId, kind: 'on', event },
      { id: isCorrectId, kind: 'branch', cond: correctCond },
      { id: okRetId, kind: 'return', result: `{ status: 'answered', correct: true, scoreDelta: ${scoreExpr} }` },
      markWrong,
      { id: limitId, kind: 'branch', cond: `q.state.${wrongKey} >= ${maxAttempts}` },
      { id: skippedRetId, kind: 'return', result: "{ status: 'skipped', correct: false, scoreDelta: 0 }" },
    ]
    const edges: GraphEdge[] = [ids.edge(onId, isCorrectId), ids.edge(isCorrectId, feedbackOkId ?? okRetId, 'true')]
    if (feedbackOkId) {
      nodes.push(feedbackCall(feedbackOkId, feedbackOk, '答对了！', 'success'))
      edges.push(ids.edge(feedbackOkId, okRetId))
    }
    edges.push(ids.edge(isCorrectId, markWrongId, 'false'), ids.edge(markWrongId, feedbackBadId ?? limitId))
    if (feedbackBadId) {
      nodes.push(feedbackCall(feedbackBadId, feedbackBad, '再试一次。', 'error'))
      edges.push(ids.edge(feedbackBadId, limitId))
    }
    edges.push(ids.edge(limitId, skippedRetId, 'true'))
    return { nodes, edges, entryId: onId, comment: '答错重试（含次数上限）' }
  },
}

/** 手动下一题（按钮收题：已答对计分，否则按 skipped 推进） */
const manualNext: PresetDef = {
  id: 'manual-next',
  name: '手动下一题（按钮收题）',
  description:
    '由「下一题」按钮事件决定何时结束本题：q.state.<守卫字段> 为真 → 计分返回 answered；否则返回 skipped（流程照常推进、不计分）。适合先看反馈再收题的题型。',
  layer: 'behavior',
  params: [
    { key: 'event', label: '收题事件（<按钮组件>.<事件>）', type: 'text', default: 'nextBtn.clicked' },
    { key: 'stateField', label: '守卫题态字段（q.state.*）', type: 'text', default: 'answered' },
    { key: 'scoreExpr', label: '答对计分表达式', type: 'expr', default: 'q.scoring' },
  ],
  build(ctx, params): PresetBuildResult {
    const event = textOf(params, 'event', 'nextBtn.clicked') || 'nextBtn.clicked'
    const stateField = textOf(params, 'stateField', 'answered') || 'answered'
    const scoreExpr = exprOf(params, 'scoreExpr', 'q.scoring') || '0'
    assertEvent(event, '手动下一题')
    assertStateKey(stateField, '手动下一题')
    const ids = createPresetIds(ctx.doc, 'behavior', ctx.typeId, 'manual-next')
    const commentId = ids.node('comment')
    const onId = ids.node('on')
    const gateId = ids.node('gate')
    const scoredRetId = ids.node('scoredret')
    const skippedRetId = ids.node('skipret')
    const nodes: BehaviorNode[] = [
      commentNode(commentId, '预设 · 手动下一题：按钮收题，已答对计分、否则 skipped 推进'),
      { id: onId, kind: 'on', event },
      { id: gateId, kind: 'branch', cond: `q.state.${stateField}` },
      { id: scoredRetId, kind: 'return', result: `{ status: 'answered', correct: true, scoreDelta: ${scoreExpr} }` },
      { id: skippedRetId, kind: 'return', result: "{ status: 'skipped', correct: false, scoreDelta: 0 }" },
    ]
    const edges: GraphEdge[] = [
      ids.edge(onId, gateId),
      ids.edge(gateId, scoredRetId, 'true'),
      ids.edge(gateId, skippedRetId, 'false'),
    ]
    return { nodes, edges, entryId: onId, comment: '手动下一题（按钮收题）' }
  },
}

/** 答对自动返回（答对即 end 本题，答错继续等） */
const autoNext: PresetDef = {
  id: 'auto-next',
  name: '答对自动进入下一题',
  description:
    '答对即置 q.state.<守卫字段> 并立即返回 answered（流程自动推进到下一题）；答错只给反馈、保留本题继续作答。适合不需要「下一题」按钮的轻量题型。',
  layer: 'behavior',
  params: [
    { key: 'event', label: '作答事件（<组件>.<事件>）', type: 'text', default: 'choice1.chosen' },
    { key: 'correctCond', label: '答对判定表达式', type: 'expr', default: 'event.payload.index == q.answerIndex' },
    { key: 'scoreExpr', label: '答对计分表达式', type: 'expr', default: 'q.scoring' },
    { key: 'stateField', label: '守卫题态字段（q.state.*）', type: 'text', default: 'answered' },
    { key: 'feedbackOk', label: '答对反馈组件（可空）', type: 'text', default: '' },
    { key: 'feedbackBad', label: '答错反馈组件（可空）', type: 'text', default: '' },
  ],
  build(ctx, params): PresetBuildResult {
    const event = textOf(params, 'event', 'choice1.chosen') || 'choice1.chosen'
    const correctCond = exprOf(params, 'correctCond', 'event.payload.index == q.answerIndex') || 'true'
    const scoreExpr = exprOf(params, 'scoreExpr', 'q.scoring') || '0'
    const stateField = textOf(params, 'stateField', 'answered') || 'answered'
    const feedbackOk = textOf(params, 'feedbackOk', '')
    const feedbackBad = textOf(params, 'feedbackBad', '')
    assertEvent(event, '答对自动进入下一题')
    assertStateKey(stateField, '答对自动进入下一题')
    assertSurfaceComponent(ctx, feedbackOk, '答对自动进入下一题')
    assertSurfaceComponent(ctx, feedbackBad, '答对自动进入下一题')
    const ids = createPresetIds(ctx.doc, 'behavior', ctx.typeId, 'auto-next')
    const commentId = ids.node('comment')
    const onId = ids.node('on')
    const isCorrectId = ids.node('correct')
    const markId = ids.node('mark')
    const feedbackOkId = feedbackOk === '' ? undefined : ids.node('feedbackok')
    const okRetId = ids.node('return')
    const feedbackBadId = feedbackBad === '' ? undefined : ids.node('feedbackbad')
    const nodes: BehaviorNode[] = [
      commentNode(commentId, '预设 · 答对自动进入下一题：答对即返回、答错继续等待'),
      { id: onId, kind: 'on', event },
      { id: isCorrectId, kind: 'branch', cond: correctCond },
      { id: markId, kind: 'assign', target: `q.state.${stateField}`, value: { expr: 'true' } },
      { id: okRetId, kind: 'return', result: `{ status: 'answered', correct: true, scoreDelta: ${scoreExpr} }` },
    ]
    const edges: GraphEdge[] = [
      ids.edge(onId, isCorrectId),
      ids.edge(isCorrectId, markId, 'true'),
      ids.edge(markId, feedbackOkId ?? okRetId),
    ]
    if (feedbackOkId) {
      nodes.push(feedbackCall(feedbackOkId, feedbackOk, '答对了！', 'success'))
      edges.push(ids.edge(feedbackOkId, okRetId))
    }
    if (feedbackBadId) {
      nodes.push(feedbackCall(feedbackBadId, feedbackBad, '再试一次。', 'error'))
      edges.push(ids.edge(isCorrectId, feedbackBadId, 'false'))
    }
    return { nodes, edges, entryId: onId, comment: '答对自动进入下一题' }
  },
}

/** 限时返回（答对停表计分；计时器 tick 超时返回 timeout） */
const timedReturn: PresetDef = {
  id: 'timed-return',
  name: '限时作答与超时返回',
  description:
    '配一个隐藏 timer 组件：答对 → 置守卫字段、停表、返回 answered；timer.tick 且未答对 → 返回 status:"timeout"（流程照常推进）。计时器用 timer.start 在 on start 里启动（本预设不含 start 入口）。',
  layer: 'behavior',
  params: [
    { key: 'answerEvent', label: '作答事件（<组件>.<事件>）', type: 'text', default: 'choice1.chosen' },
    { key: 'timeoutEvent', label: '计时器事件（<timer组件>.tick）', type: 'text', default: 'timer1.tick' },
    { key: 'correctCond', label: '答对判定表达式', type: 'expr', default: 'event.payload.index == q.answerIndex' },
    { key: 'scoreExpr', label: '答对计分表达式', type: 'expr', default: 'q.scoring' },
    { key: 'stateField', label: '守卫题态字段（q.state.*）', type: 'text', default: 'answered' },
    { key: 'timerTarget', label: '计时器组件 id（可空 = 不停表）', type: 'text', default: 'timer1' },
    { key: 'feedbackTimeout', label: '超时反馈组件（可空）', type: 'text', default: '' },
  ],
  build(ctx, params): PresetBuildResult {
    const answerEvent = textOf(params, 'answerEvent', 'choice1.chosen') || 'choice1.chosen'
    const timeoutEvent = textOf(params, 'timeoutEvent', 'timer1.tick') || 'timer1.tick'
    const correctCond = exprOf(params, 'correctCond', 'event.payload.index == q.answerIndex') || 'true'
    const scoreExpr = exprOf(params, 'scoreExpr', 'q.scoring') || '0'
    const stateField = textOf(params, 'stateField', 'answered') || 'answered'
    const timerTarget = textOf(params, 'timerTarget', 'timer1')
    const feedbackTimeout = textOf(params, 'feedbackTimeout', '')
    assertEvent(answerEvent, '限时作答与超时返回')
    assertEvent(timeoutEvent, '限时作答与超时返回')
    assertStateKey(stateField, '限时作答与超时返回')
    assertSurfaceComponent(ctx, timerTarget, '限时作答与超时返回')
    assertSurfaceComponent(ctx, feedbackTimeout, '限时作答与超时返回')
    const ids = createPresetIds(ctx.doc, 'behavior', ctx.typeId, 'timed-return')
    const commentId = ids.node('comment')
    const onAnswerId = ids.node('onanswer')
    const isCorrectId = ids.node('correct')
    const markId = ids.node('mark')
    const stopTimerId = timerTarget === '' ? undefined : ids.node('stoptimer')
    const okRetId = ids.node('okret')
    const onTimeoutId = ids.node('ontimeout')
    const timeoutGuardId = ids.node('timeguard')
    const feedbackTimeoutId = feedbackTimeout === '' ? undefined : ids.node('feedbacktimeout')
    const timeoutRetId = ids.node('timeoutret')
    const nodes: BehaviorNode[] = [
      commentNode(
        commentId,
        '预设 · 限时返回：答对停表计分；timer.tick 未答对时返回 status:"timeout"（需在 on start 启动 timer）',
      ),
      { id: onAnswerId, kind: 'on', event: answerEvent },
      { id: isCorrectId, kind: 'branch', cond: correctCond },
      { id: markId, kind: 'assign', target: `q.state.${stateField}`, value: { expr: 'true' } },
      { id: okRetId, kind: 'return', result: `{ status: 'answered', correct: true, scoreDelta: ${scoreExpr} }` },
      { id: onTimeoutId, kind: 'on', event: timeoutEvent },
      { id: timeoutGuardId, kind: 'branch', cond: `q.state.${stateField}` },
      { id: timeoutRetId, kind: 'return', result: "{ status: 'timeout', correct: false, scoreDelta: 0 }" },
    ]
    const edges: GraphEdge[] = [ids.edge(onAnswerId, isCorrectId), ids.edge(isCorrectId, markId, 'true')]
    if (stopTimerId) {
      nodes.push({ id: stopTimerId, kind: 'call', target: timerTarget, method: 'stop' })
      edges.push(ids.edge(markId, stopTimerId), ids.edge(stopTimerId, okRetId))
    } else {
      edges.push(ids.edge(markId, okRetId))
    }
    edges.push(ids.edge(onTimeoutId, timeoutGuardId))
    if (feedbackTimeoutId) {
      nodes.push(feedbackCall(feedbackTimeoutId, feedbackTimeout, '时间到！', 'error'))
      edges.push(ids.edge(timeoutGuardId, feedbackTimeoutId, 'false'), ids.edge(feedbackTimeoutId, timeoutRetId))
    } else {
      edges.push(ids.edge(timeoutGuardId, timeoutRetId, 'false'))
    }
    return { nodes, edges, entryId: onAnswerId, comment: '限时作答与超时返回' }
  },
}

/** 提示 / 反馈（点击提示按钮给文案；已答对时静默返回 0 分守卫） */
const feedbackHint: PresetDef = {
  id: 'feedback-hint',
  name: '提示 / 反馈文案',
  description:
    '点击「提示」按钮时用 label.show 显示一条提示文案；若本题已答对（q.state.<守卫字段> 为真）则静默返回 0 分，不再提示。文案是文本参数，可随时改。',
  layer: 'behavior',
  params: [
    { key: 'event', label: '提示触发事件（<按钮组件>.<事件>）', type: 'text', default: 'hintBtn.clicked' },
    { key: 'stateField', label: '守卫题态字段（q.state.*）', type: 'text', default: 'answered' },
    { key: 'feedbackTarget', label: '反馈组件 id', type: 'text', default: 'feedback' },
    { key: 'hintText', label: '提示文案', type: 'text', default: '再听一遍，注意最后一个音。' },
  ],
  build(ctx, params): PresetBuildResult {
    const event = textOf(params, 'event', 'hintBtn.clicked') || 'hintBtn.clicked'
    const stateField = textOf(params, 'stateField', 'answered') || 'answered'
    const feedbackTarget = textOf(params, 'feedbackTarget', 'feedback') || 'feedback'
    const hintText = textOf(params, 'hintText', '再听一遍，注意最后一个音。')
    assertEvent(event, '提示 / 反馈文案')
    assertStateKey(stateField, '提示 / 反馈文案')
    assertSurfaceComponent(ctx, feedbackTarget, '提示 / 反馈文案')
    const ids = createPresetIds(ctx.doc, 'behavior', ctx.typeId, 'feedback-hint')
    const commentId = ids.node('comment')
    const onId = ids.node('on')
    const guardId = ids.node('guard')
    const duplicateRetId = ids.node('dupret')
    const hintId = ids.node('hint')
    const nodes: BehaviorNode[] = [
      commentNode(commentId, '预设 · 提示/反馈：提示按钮显示文案；已答对时静默返回 0 分'),
      { id: onId, kind: 'on', event },
      { id: guardId, kind: 'branch', cond: `q.state.${stateField}` },
      { id: duplicateRetId, kind: 'return', result: "{ status: 'answered', correct: true, scoreDelta: 0 }" },
      feedbackCall(hintId, feedbackTarget, hintText, 'info'),
    ]
    const edges: GraphEdge[] = [
      ids.edge(onId, guardId),
      ids.edge(guardId, duplicateRetId, 'true'),
      ids.edge(guardId, hintId, 'false'),
    ]
    return { nodes, edges, entryId: onId, comment: '提示 / 反馈文案' }
  },
}

/** behavior 层内置预设（顺序即画廊展示顺序） */
export const BEHAVIOR_PRESETS: PresetDef[] = [
  firstCorrectOnce,
  everyCorrect,
  wrongRetry,
  manualNext,
  autoNext,
  timedReturn,
  feedbackHint,
]
