/**
 * 题型 · choice-listen（听音选择，docs/51 §6 theory-choice / 教程第 3 步）。
 *
 * 交互：on start 应用选项 + 自动播放 listenNotes；点选项判分并 reveal；
 *       「下一题」手动收题（答对计分，未答对按 skipped 返回，流程照常推进）。
 * 计分：首次答对 scoreDelta = q.scoring + args.bonus（args.bonus 默认 0，显式题单可覆盖）。
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
  nextGate,
  paramField,
  questionType,
  stateField,
  surfaceComponent,
} from '../lib'

export function buildChoiceListenType() {
  const startGuard = answeredGuard('b_start', 'q.scoring + args.bonus')
  const replayGuard = answeredGuard('b_replay', 'q.scoring + args.bonus')
  const chosenGuard = answeredGuard('b_chosen', 'q.scoring + args.bonus')
  const gate = nextGate('b_next', 'q.scoring + args.bonus')
  const nodes: BehaviorNode[] = [
    nOn('b_onStart', 'start'),
    nCall('b_setOptions', 'choice1', 'setOptions', '{ options: q.options }'),
    nAssign('b_countAsk', 't.asked', 't.asked + 1'),
    nCall('b_playListen', 'sound1', 'play', '{ notes: q.listenNotes }'),
    ...startGuard.nodes,
    nOn('b_onReplay', 'listenBtn.clicked'),
    nCall('b_playReplay', 'sound1', 'play', '{ notes: q.listenNotes }'),
    ...replayGuard.nodes,
    nOn('b_onChosen', 'choice1.chosen'),
    ...chosenGuard.nodes,
    nBranch('b_isCorrect', 'event.payload.index == q.answerIndex'),
    nAssign('b_markAnswered', 'q.state.answered', 'true'),
    nCall('b_reveal', 'choice1', 'reveal', '{ correctIndex: q.answerIndex }'),
    nCall('b_feedbackOk', 'feedback', 'show', "{ text: '答对了！点「下一题」继续。', tone: 'success' }"),
    nCall('b_feedbackBad', 'feedback', 'show', "{ text: '不是这个，再听一遍。', tone: 'error' }"),
    nOn('b_onNext', 'nextBtn.clicked'),
    ...gate.nodes,
    nComment('b_comment', '首次答对计分（answered 守卫）；答错只给反馈，可重听重选；下一题收题'),
  ]
  const edges: GraphEdge[] = [
    edge('b_onStart', 'b_setOptions'),
    ...chain('b_setOptions', 'b_countAsk', 'b_playListen', startGuard.entry),
    ...startGuard.edges,
    edge('b_onReplay', 'b_playReplay'),
    edge('b_playReplay', replayGuard.entry),
    ...replayGuard.edges,
    edge('b_onChosen', chosenGuard.entry),
    edge(chosenGuard.entry, 'b_isCorrect', 'false'),
    ...chosenGuard.edges,
    edge('b_isCorrect', 'b_markAnswered', 'true'),
    ...chain('b_markAnswered', 'b_reveal', 'b_feedbackOk'),
    edge('b_isCorrect', 'b_feedbackBad', 'false'),
    edge('b_onNext', gate.entry),
    ...gate.edges,
  ]
  return questionType({
    id: 'choice-listen',
    name: '听音选择',
    description: '听音频选择正确选项：演示 choice.options 绑定之外的显式 setOptions 命令、reveal 判定与手动下一题。',
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
      surfaceComponent('choice1', 'choice', {
        name: '选项',
        layout: box(24, 72, 752, 240),
      }),
      surfaceComponent('feedback', 'label', {
        name: '反馈',
        layout: box(24, 336, 752, 40),
        props: { text: '' },
      }),
      surfaceComponent('nextBtn', 'button', {
        name: '下一题',
        layout: box(600, 388, 176, 44),
        props: { text: '下一题 →' },
      }),
      surfaceComponent('sound1', 'sound', { name: '发声器' }),
    ],
    behavior: behaviorProgram(nodes, edges),
    state: [stateField('answered', 'boolean', false)],
    typeState: [stateField('asked', 'number', 0)],
    args: [paramField('bonus', 'number', { optional: true, default: 0 })],
  })
}
