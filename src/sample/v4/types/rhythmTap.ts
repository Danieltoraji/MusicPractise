/**
 * 题型 · rhythm-tap（节奏跟拍，docs/51 §6 rhythm-follow）。
 *
 * 交互：on start 启动 rhythm（bpm/beats 来自数据行）；tap 事件把相对起拍时间累积到 local.taps；
 *       一轮结束（roundDone）用 rhythmScore(taps, grid, tolerance) 判定：
 *       达标 → 按比例计分并返回；未达标 → 清空 taps 并重开一轮（可重试）。
 * 计分：scoreDelta = q.state.pendingScore（round(ratio * scoring) 累加）。
 */
import type { BehaviorNode, GraphEdge } from '../../../engine/v4/model'
import {
  answeredGuard,
  behaviorProgram,
  box,
  chain,
  edge,
  nAssign,
  nBranch,
  nCall,
  nComment,
  nOn,
  nReturn,
  questionType,
  stateField,
  surfaceComponent,
} from '../lib'

const startRhythm = (id: string) => nCall(id, 'rhythm1', 'start', '{ bpm: q.bpm, beats: q.beats, countInBeats: 4 }')

export function buildRhythmTapType() {
  const startGuard = answeredGuard('b_start')
  const tapGuard = answeredGuard('b_tap', 'q.state.pendingScore')
  const nodes: BehaviorNode[] = [
    nOn('b_onStart', 'start'),
    nAssign('b_initTaps', 'local.taps', '[]'),
    startRhythm('b_startRhythm'),
    nCall('b_feedbackReady', 'feedback', 'show', "{ text: '听 4 拍预备，跟着圆盘打拍。', tone: 'info' }"),
    ...startGuard.nodes,
    nOn('b_onTap', 'rhythm1.tap'),
    ...tapGuard.nodes,
    nAssign('b_pushTap', 'local.taps', 'append(local.taps, event.payload.t)'),
    nOn('b_onRound', 'rhythm1.roundDone'),
    nAssign('b_ratio', 'local.ratio', 'rhythmScore(local.taps, q.grid, q.tolerance)'),
    nAssign('b_countRound', 't.rounds', 't.rounds + 1'),
    nBranch('b_passed', 'local.ratio >= q.passRatio'),
    nAssign('b_markAnswered', 'q.state.answered', 'true'),
    nAssign(
      'b_addPending',
      'q.state.pendingScore',
      'q.state.pendingScore + round(local.ratio * q.scoring)',
    ),
    nCall('b_feedbackOk', 'feedback', 'show', "{ text: '节奏跟上了！', tone: 'success' }"),
    nReturn('b_retOk', "{ status: 'answered', correct: true, scoreDelta: q.state.pendingScore }"),
    nAssign('b_clearTaps', 'local.taps', '[]'),
    nCall('b_feedbackBad', 'feedback', 'show', "{ text: '没跟上，再来一轮。', tone: 'error' }"),
    startRhythm('b_restartRhythm'),
    nComment('b_comment', '多轮判定预设：一轮判定 → 达标计分返回 / 未达标清空重开（上限靠 finish 阈值控制）'),
  ]
  const edges: GraphEdge[] = [
    edge('b_onStart', 'b_initTaps'),
    edge('b_initTaps', 'b_startRhythm'),
    ...chain('b_startRhythm', 'b_feedbackReady', startGuard.entry),
    ...startGuard.edges,
    edge('b_onTap', tapGuard.entry),
    edge(tapGuard.entry, 'b_pushTap', 'false'),
    ...tapGuard.edges,
    edge('b_onRound', 'b_ratio'),
    ...chain('b_ratio', 'b_countRound', 'b_passed'),
    edge('b_passed', 'b_markAnswered', 'true'),
    ...chain('b_markAnswered', 'b_addPending', 'b_feedbackOk', 'b_retOk'),
    edge('b_passed', 'b_clearTaps', 'false'),
    ...chain('b_clearTaps', 'b_feedbackBad', 'b_restartRhythm'),
  ]
  return questionType({
    id: 'rhythm-tap',
    name: '节奏跟拍',
    description: '跟着节拍在圆盘打拍：演示 rhythm.tap/roundDone 事件、rhythmScore 判定与多轮重试。',
    surface: [
      surfaceComponent('prompt', 'label', {
        name: '题面',
        layout: box(24, 16, 752, 32),
        bindings: { text: 'q.prompt' },
      }),
      surfaceComponent('rhythm1', 'rhythm', {
        name: '节奏盘',
        layout: box(180, 80, 440, 240),
        props: { countInBeats: 4 },
      }),
      surfaceComponent('feedback', 'label', {
        name: '反馈',
        layout: box(24, 340, 752, 40),
        props: { text: '' },
      }),
    ],
    behavior: behaviorProgram(nodes, edges, [stateField('taps', 'json', []), stateField('ratio', 'number', 0)]),
    state: [stateField('answered', 'boolean', false), stateField('pendingScore', 'number', 0)],
    typeState: [stateField('rounds', 'number', 0)],
  })
}
