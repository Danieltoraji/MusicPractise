/**
 * 题型 · keyboard-melody（旋律听写，docs/51 §6 melody-dictation）。
 *
 * 交互：on start 播放 listenNotes；在 fingering 键盘上按顺序弹（keyClicked 逐音累积到 local.notes）；
 *       弹满目标长度后自动判定：正确即返回，错误清空并提示重听。
 * 计分：首次弹对 scoreDelta = q.scoring。
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

export function buildKeyboardMelodyType() {
  const startGuard = answeredGuard('b_start')
  const replayGuard = answeredGuard('b_replay')
  const resetGuard = answeredGuard('b_reset')
  const tapGuard = answeredGuard('b_key', 'q.scoring')
  const nodes: BehaviorNode[] = [
    nOn('b_onStart', 'start'),
    nAssign('b_initNotes', 'local.notes', '[]'),
    nCall('b_playListen', 'sound1', 'play', '{ notes: q.listenNotes }'),
    ...startGuard.nodes,
    nOn('b_onReplay', 'listenBtn.clicked'),
    nCall('b_playReplay', 'sound1', 'play', '{ notes: q.listenNotes }'),
    ...replayGuard.nodes,
    nOn('b_onReset', 'resetBtn.clicked'),
    nAssign('b_clearNotes', 'local.notes', '[]'),
    nCall('b_clearKeys', 'keys1', 'clear'),
    nCall('b_feedbackReset', 'feedback', 'show', "{ text: '已清空，重新弹一遍。', tone: 'info' }"),
    ...resetGuard.nodes,
    nOn('b_onKey', 'keys1.keyClicked'),
    ...tapGuard.nodes,
    nAssign('b_pushNote', 'local.notes', 'append(local.notes, event.payload.midi)'),
    nBranch('b_isDone', "join(local.notes, ',') == join(q.targetNotes, ',')"),
    nAssign('b_markAnswered', 'q.state.answered', 'true'),
    nCall('b_reward', 'sound1', 'play', '{ notes: q.rewardChord }'),
    nCall('b_feedbackOk', 'feedback', 'show', "{ text: '旋律完全正确！', tone: 'success' }"),
    nReturn('b_retOk', "{ status: 'answered', correct: true, scoreDelta: q.scoring }"),
    nBranch('b_isFull', 'len(local.notes) >= len(q.targetNotes)'),
    nAssign('b_resetNotes', 'local.notes', '[]'),
    nAssign('b_countAttempts', 't.attempts', 't.attempts + 1'),
    nCall('b_resetKeys', 'keys1', 'clear'),
    nCall('b_feedbackBad', 'feedback', 'show', "{ text: '旋律不对，重听一遍再弹。', tone: 'error' }"),
    nComment('b_comment', '逐音累积 + 弹满自动判定；答错清空重来（预设「答错可重试」）'),
  ]
  const edges: GraphEdge[] = [
    edge('b_onStart', 'b_initNotes'),
    edge('b_initNotes', 'b_playListen'),
    edge('b_playListen', startGuard.entry),
    ...startGuard.edges,
    edge('b_onReplay', 'b_playReplay'),
    edge('b_playReplay', replayGuard.entry),
    ...replayGuard.edges,
    edge('b_onReset', 'b_clearNotes'),
    ...chain('b_clearNotes', 'b_clearKeys', 'b_feedbackReset', resetGuard.entry),
    ...resetGuard.edges,
    edge('b_onKey', tapGuard.entry),
    edge(tapGuard.entry, 'b_pushNote', 'false'),
    ...tapGuard.edges,
    edge('b_pushNote', 'b_isDone'),
    edge('b_isDone', 'b_markAnswered', 'true'),
    ...chain('b_markAnswered', 'b_reward', 'b_feedbackOk', 'b_retOk'),
    edge('b_isDone', 'b_isFull', 'false'),
    edge('b_isFull', 'b_resetNotes', 'true'),
    ...chain('b_resetNotes', 'b_countAttempts', 'b_resetKeys', 'b_feedbackBad'),
  ]
  return questionType({
    id: 'keyboard-melody',
    name: '键盘旋律听写',
    description: '听旋律并在键盘上按序弹出：演示 fingering.keyClicked 事件、append 累积与数组判定。',
    surface: [
      surfaceComponent('prompt', 'label', {
        name: '题面',
        layout: box(24, 16, 552, 32),
        bindings: { text: 'q.prompt' },
      }),
      surfaceComponent('listenBtn', 'button', {
        name: '重听',
        layout: box(600, 16, 176, 36),
        props: { text: '🔊 重听' },
      }),
      surfaceComponent('feedback', 'label', {
        name: '反馈',
        layout: box(24, 60, 752, 36),
        props: { text: '' },
      }),
      surfaceComponent('keys1', 'fingering', {
        name: '键盘',
        layout: box(24, 110, 752, 190),
        props: { lowMidi: 60, highMidi: 76 },
      }),
      surfaceComponent('resetBtn', 'button', {
        name: '清空',
        layout: box(24, 320, 176, 44),
        props: { text: '↺ 清空' },
      }),
      surfaceComponent('sound1', 'sound', { name: '发声器' }),
    ],
    behavior: behaviorProgram(nodes, edges, [stateField('notes', 'json', [])]),
    state: [stateField('answered', 'boolean', false)],
    typeState: [stateField('attempts', 'number', 0)],
  })
}
