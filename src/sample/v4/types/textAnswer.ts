/**
 * 题型 · text-answer（音名拼写，docs/51 §6 note-spelling）。
 *
 * 交互：on start 播放 listenNotes；输入框回车提交（input.submitted）→ 大小写无关比较 + aliases 兜底；
 *       正确即返回；错误清空并提示（第 2 次错误起给 hint 提示）。
 * 计分：首次答对 scoreDelta = q.scoring。
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

export function buildTextAnswerType() {
  const startGuard = answeredGuard('b_start')
  const replayGuard = answeredGuard('b_replay')
  const submitGuard = answeredGuard('b_submit')
  const nodes: BehaviorNode[] = [
    nOn('b_onStart', 'start'),
    nCall('b_playListen', 'sound1', 'play', '{ notes: q.listenNotes }'),
    ...startGuard.nodes,
    nOn('b_onReplay', 'listenBtn.clicked'),
    nCall('b_playReplay', 'sound1', 'play', '{ notes: q.listenNotes }'),
    ...replayGuard.nodes,
    nOn('b_onSubmit', 'input1.submitted'),
    ...submitGuard.nodes,
    nAssign('b_countTry', 'q.state.attempts', 'q.state.attempts + 1'),
    nBranch(
      'b_isCorrect',
      "upper(event.payload.value) == upper(q.answer) || contains(q.aliases, lower(event.payload.value))",
    ),
    nAssign('b_markAnswered', 'q.state.answered', 'true'),
    nCall('b_feedbackOk', 'feedback', 'show', "{ text: '拼写正确！', tone: 'success' }"),
    nReturn('b_retOk', "{ status: 'answered', correct: true, scoreDelta: q.scoring }"),
    nCall('b_clearInput', 'input1', 'clear'),
    nBranch('b_showHint', 'q.state.attempts >= 2'),
    nCall('b_feedbackHint', 'feedback', 'show', "{ text: '提示：' + q.hint, tone: 'info' }"),
    nCall('b_feedbackBad', 'feedback', 'show', "{ text: '还不对，先听一遍再输入。', tone: 'error' }"),
    nComment('b_comment', '提交即判定：大小写无关 + aliases 兜底；两次错误后给提示（预设「提示/反馈」）'),
  ]
  const edges: GraphEdge[] = [
    edge('b_onStart', 'b_playListen'),
    edge('b_playListen', startGuard.entry),
    ...startGuard.edges,
    edge('b_onReplay', 'b_playReplay'),
    edge('b_playReplay', replayGuard.entry),
    ...replayGuard.edges,
    edge('b_onSubmit', submitGuard.entry),
    edge(submitGuard.entry, 'b_countTry', 'false'),
    ...submitGuard.edges,
    edge('b_countTry', 'b_isCorrect'),
    edge('b_isCorrect', 'b_markAnswered', 'true'),
    ...chain('b_markAnswered', 'b_feedbackOk', 'b_retOk'),
    edge('b_isCorrect', 'b_clearInput', 'false'),
    edge('b_clearInput', 'b_showHint'),
    edge('b_showHint', 'b_feedbackHint', 'true'),
    edge('b_showHint', 'b_feedbackBad', 'false'),
  ]
  return questionType({
    id: 'text-answer',
    name: '文本作答',
    description: '输入音名（如 CEG）回车提交：演示 input.submitted、大小写无关比较与 aliases 兜底。',
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
      surfaceComponent('input1', 'input', {
        name: '作答输入框',
        layout: box(24, 100, 480, 56),
        props: { placeholder: '输入音名，如 CEG，回车提交' },
      }),
      surfaceComponent('feedback', 'label', {
        name: '反馈',
        layout: box(24, 180, 752, 40),
        props: { text: '' },
      }),
      surfaceComponent('sound1', 'sound', { name: '发声器' }),
    ],
    behavior: behaviorProgram(nodes, edges),
    state: [stateField('answered', 'boolean', false), stateField('attempts', 'number', 0)],
  })
}
