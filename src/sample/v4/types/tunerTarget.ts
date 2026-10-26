/**
 * 题型 · tuner-target（校音达标，docs/51 §6 tune-intro）。
 *
 * 交互：on start 启动 tuner（请求麦克风）；pitch 事件更新「是否在容差内」，
 *       连续命中次数达到 round(stableSeconds * 10)（pitch 约 10Hz）即达标 → stop tuner 并计分返回。
 * 计分：首次达标 scoreDelta = q.scoring。
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

export function buildTunerTargetType() {
  const startGuard = answeredGuard('b_start')
  const pitchGuard = answeredGuard('b_pitch')
  const nodes: BehaviorNode[] = [
    nOn('b_onStart', 'start'),
    nCall('b_startTuner', 'tuner1', 'start'),
    nCall('b_feedbackStart', 'feedback', 'show', "{ text: '对麦克风持续发目标音，保持稳定。', tone: 'info' }"),
    ...startGuard.nodes,
    nOn('b_onPitch', 'tuner1.pitch'),
    nAssign('b_countPitch', 't.pitchEvents', 't.pitchEvents + 1'),
    ...pitchGuard.nodes,
    nAssign('b_inTune', 'q.state.inTune', 'abs(cents(event.payload.freq, q.targetMidi)) <= q.tolerance'),
    nBranch('b_inside', 'q.state.inTune'),
    nAssign('b_addStable', 'q.state.stableCount', 'q.state.stableCount + 1'),
    nBranch('b_stableEnough', 'q.state.stableCount >= round(q.stableSeconds * 10)'),
    nAssign('b_markAnswered', 'q.state.answered', 'true'),
    nCall('b_stopTuner', 'tuner1', 'stop'),
    nCall('b_feedbackOk', 'feedback', 'show', "{ text: '音准稳定达标！', tone: 'success' }"),
    nReturn('b_retOk', "{ status: 'answered', correct: true, scoreDelta: q.scoring }"),
    nAssign('b_resetStable', 'q.state.stableCount', '0'),
    nCall('b_feedbackBad', 'feedback', 'show', "{ text: '再靠近一点目标音高。', tone: 'error' }"),
    nComment('b_comment', '稳定判定：连续 N 个 in-tune pitch 事件达标（stableSeconds × 10Hz 近似）'),
  ]
  const edges: GraphEdge[] = [
    edge('b_onStart', 'b_startTuner'),
    ...chain('b_startTuner', 'b_feedbackStart', startGuard.entry),
    ...startGuard.edges,
    edge('b_onPitch', 'b_countPitch'),
    edge('b_countPitch', pitchGuard.entry),
    edge(pitchGuard.entry, 'b_inTune', 'false'),
    ...pitchGuard.edges,
    edge('b_inTune', 'b_inside'),
    edge('b_inside', 'b_addStable', 'true'),
    edge('b_addStable', 'b_stableEnough'),
    edge('b_stableEnough', 'b_markAnswered', 'true'),
    ...chain('b_markAnswered', 'b_stopTuner', 'b_feedbackOk', 'b_retOk'),
    edge('b_inside', 'b_resetStable', 'false'),
    edge('b_resetStable', 'b_feedbackBad'),
  ]
  return questionType({
    id: 'tuner-target',
    name: '校音达标',
    description: '对麦克风把音高稳定在目标音附近：演示 tuner.pitch 事件、cents 计算与连续命中判定。',
    surface: [
      surfaceComponent('prompt', 'label', {
        name: '题面',
        layout: box(24, 16, 552, 32),
        bindings: { text: 'q.prompt' },
      }),
      surfaceComponent('targetLabel', 'label', {
        name: '目标音',
        layout: box(600, 16, 176, 32),
        bindings: { text: 'q.targetName' },
      }),
      surfaceComponent('tuner1', 'tuner', {
        name: '校音器',
        layout: box(24, 64, 752, 250),
      }),
      surfaceComponent('feedback', 'label', {
        name: '反馈',
        layout: box(24, 330, 752, 40),
        props: { text: '' },
      }),
    ],
    behavior: behaviorProgram(nodes, edges),
    state: [
      stateField('answered', 'boolean', false),
      stateField('inTune', 'boolean', false),
      stateField('stableCount', 'number', 0),
    ],
    typeState: [stateField('pitchEvents', 'number', 0)],
  })
}
