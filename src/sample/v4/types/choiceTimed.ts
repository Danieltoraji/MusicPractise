/**
 * 题型 · choice-timed（限时选择，docs/51 §6 timed-reaction）。
 *
 * 交互：on start 应用选项、播放听音并启动 timer（q.timeMs 毫秒，单次 tick 即超时）；
 *       timer tick → 超时返回 status:'timeout'；答对 → stop timer 并立即计分返回；答错 → reset 可重选。
 * 计分：答对 scoreDelta = q.scoring；超时无分（流程照常推进）。
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

export function buildChoiceTimedType() {
  const startGuard = answeredGuard('b_start')
  const replayGuard = answeredGuard('b_replay')
  const chosenGuard = answeredGuard('b_chosen')
  const nodes: BehaviorNode[] = [
    nOn('b_onStart', 'start'),
    nCall('b_setOptions', 'choice1', 'setOptions', '{ options: q.options }'),
    nCall('b_playListen', 'sound1', 'play', '{ notes: q.listenNotes }'),
    nCall('b_startTimer', 'timer1', 'start', '{ ms: q.timeMs }'),
    ...startGuard.nodes,
    nOn('b_onReplay', 'listenBtn.clicked'),
    nCall('b_playReplay', 'sound1', 'play', '{ notes: q.listenNotes }'),
    ...replayGuard.nodes,
    nOn('b_onChosen', 'choice1.chosen'),
    ...chosenGuard.nodes,
    nBranch('b_isCorrect', 'event.payload.index == q.answerIndex'),
    nAssign('b_markAnswered', 'q.state.answered', 'true'),
    nCall('b_stopTimer', 'timer1', 'stop'),
    nCall('b_reveal', 'choice1', 'reveal', '{ correctIndex: q.answerIndex }'),
    nCall('b_feedbackOk', 'feedback', 'show', "{ text: '答对了！', tone: 'success' }"),
    nReturn('b_retOk', "{ status: 'answered', correct: true, scoreDelta: q.scoring }"),
    nAssign('b_countWrong', 'q.state.attempts', 'q.state.attempts + 1'),
    nCall('b_resetChoice', 'choice1', 'reset'),
    nCall('b_feedbackBad', 'feedback', 'show', "{ text: '不对，快再选！', tone: 'error' }"),
    nOn('b_onTick', 'timer1.tick'),
    nBranch('b_isAnswered', 'q.state.answered'),
    nAssign('b_countTimeout', 't.timeouts', 't.timeouts + 1'),
    nCall('b_feedbackTimeout', 'feedback', 'show', "{ text: '时间到！', tone: 'error' }"),
    nReturn('b_retTimeout', "{ status: 'timeout', correct: false, scoreDelta: 0 }"),
    nComment('b_comment', '限时返回预设：timer.tick → status:timeout；答对先 stop timer 再 return'),
  ]
  const edges: GraphEdge[] = [
    edge('b_onStart', 'b_setOptions'),
    ...chain('b_setOptions', 'b_playListen', 'b_startTimer', startGuard.entry),
    ...startGuard.edges,
    edge('b_onReplay', 'b_playReplay'),
    edge('b_playReplay', replayGuard.entry),
    ...replayGuard.edges,
    edge('b_onChosen', chosenGuard.entry),
    edge(chosenGuard.entry, 'b_isCorrect', 'false'),
    ...chosenGuard.edges,
    edge('b_isCorrect', 'b_markAnswered', 'true'),
    ...chain('b_markAnswered', 'b_stopTimer', 'b_reveal', 'b_feedbackOk', 'b_retOk'),
    edge('b_isCorrect', 'b_countWrong', 'false'),
    ...chain('b_countWrong', 'b_resetChoice', 'b_feedbackBad'),
    edge('b_onTick', 'b_isAnswered'),
    edge('b_isAnswered', 'b_countTimeout', 'false'),
    ...chain('b_countTimeout', 'b_feedbackTimeout', 'b_retTimeout'),
  ]
  return questionType({
    id: 'choice-timed',
    name: '限时选择',
    description: '倒计时内选出正确答案：演示 timer 组件的 start/stop 与 tick 超时返回。',
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
      surfaceComponent('timerLabel', 'label', {
        name: '限时提示',
        layout: box(24, 56, 240, 24),
        props: { text: '⏱ 限时作答' },
      }),
      surfaceComponent('choice1', 'choice', {
        name: '选项',
        layout: box(24, 88, 752, 220),
      }),
      surfaceComponent('feedback', 'label', {
        name: '反馈',
        layout: box(24, 320, 752, 40),
        props: { text: '' },
      }),
      surfaceComponent('timer1', 'timer', { name: '计时器', visible: false }),
      surfaceComponent('sound1', 'sound', { name: '发声器' }),
    ],
    behavior: behaviorProgram(nodes, edges),
    state: [stateField('answered', 'boolean', false), stateField('attempts', 'number', 0)],
    typeState: [stateField('timeouts', 'number', 0)],
  })
}
