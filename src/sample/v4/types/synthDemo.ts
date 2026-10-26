/**
 * 题型 · synth-demo（合成器演示，docs/51 §6 synth-lab）。
 *
 * 交互：on start 应用音色（synth.setWave）；「▶ 播放」用当前音色演奏该行 notes；
 *       「下一音色」收题返回（本题不计分）。
 * 计分：scoreDelta = 0（音色实验室无分数，finish(passed: true)）。
 */
import type { BehaviorNode, GraphEdge } from '../../../engine/v4/model'
import {
  answeredGuard,
  behaviorProgram,
  box,
  chain,
  edge,
  nAssign,
  nCall,
  nComment,
  nOn,
  nReturn,
  questionType,
  stateField,
  surfaceComponent,
} from '../lib'

export function buildSynthDemoType() {
  const startGuard = answeredGuard('b_start')
  const playGuard = answeredGuard('b_play')
  const nodes: BehaviorNode[] = [
    nOn('b_onStart', 'start'),
    nCall('b_setWave', 'synth1', 'setWave', '{ wave: q.wave }'),
    nAssign('b_countHeard', 't.heard', 't.heard + 1'),
    ...startGuard.nodes,
    nOn('b_onPlay', 'playBtn.clicked'),
    nCall('b_playNotes', 'synth1', 'play', '{ notes: q.notes, wave: q.wave }'),
    nAssign('b_countPlay', 'q.state.played', 'q.state.played + 1'),
    ...playGuard.nodes,
    nOn('b_onNext', 'nextBtn.clicked'),
    nReturn('b_ret', "{ status: 'answered', correct: true, scoreDelta: 0 }"),
    nComment('b_comment', '音色实验室：播放命令带 wave/notes；下一音色手动收题'),
  ]
  const edges: GraphEdge[] = [
    edge('b_onStart', 'b_setWave'),
    ...chain('b_setWave', 'b_countHeard', startGuard.entry),
    ...startGuard.edges,
    edge('b_onPlay', 'b_playNotes'),
    ...chain('b_playNotes', 'b_countPlay', playGuard.entry),
    ...playGuard.edges,
    edge('b_onNext', 'b_ret'),
  ]
  return questionType({
    id: 'synth-demo',
    name: '合成器演示',
    description: '一行数据 = 一种音色：点击播放试听，下一音色继续；演示 synth 组件的命令参数。',
    surface: [
      surfaceComponent('waveLabel', 'label', {
        name: '音色',
        layout: box(24, 16, 260, 32),
        bindings: { text: 'q.wave' },
      }),
      surfaceComponent('titleLabel', 'label', {
        name: '音色名',
        layout: box(300, 16, 476, 32),
        bindings: { text: 'q.title' },
      }),
      surfaceComponent('descLabel', 'label', {
        name: '说明',
        layout: box(24, 60, 752, 56),
        bindings: { text: 'q.desc' },
      }),
      surfaceComponent('playBtn', 'button', {
        name: '播放',
        layout: box(24, 140, 240, 48),
        props: { text: '▶ 播放示例' },
      }),
      surfaceComponent('nextBtn', 'button', {
        name: '下一音色',
        layout: box(536, 140, 240, 48),
        props: { text: '下一音色 ▶' },
      }),
      surfaceComponent('synth1', 'synth', {
        name: '合成器',
        layout: box(24, 210, 360, 96),
        props: { wave: 'sawtooth', gain: 0.35 },
      }),
    ],
    behavior: behaviorProgram(nodes, edges),
    state: [stateField('answered', 'boolean', false), stateField('played', 'number', 0)],
    typeState: [stateField('heard', 'number', 0)],
  })
}
