/**
 * 题型 · staff-click（五线谱点击，docs/51 §6 note-click / clef-test）。
 *
 * 交互：on start 应用乐谱（staff.setMusic）并播放听音；点五线谱音符判分（高亮 + 音效），
 *       「下一题」手动收题（答对计分；未答对按 skipped 返回）。
 * 变体：`variant: 'clef-test'` 额外显示谱号标签（高/中/低音谱号各一行）。
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
  nextGate,
  questionType,
  stateField,
  surfaceComponent,
} from '../lib'

export type StaffClickVariant = 'note-click' | 'clef-test'

export interface StaffClickOptions {
  variant?: StaffClickVariant
}

export function buildStaffClickType(options: StaffClickOptions = {}) {
  const variant = options.variant ?? 'note-click'
  const showClefLabel = variant === 'clef-test'
  const startGuard = answeredGuard('b_start')
  const replayGuard = answeredGuard('b_replay')
  const clickGuard = answeredGuard('b_click')
  const gate = nextGate('b_next')
  const nodes: BehaviorNode[] = [
    nOn('b_onStart', 'start'),
    nCall('b_setMusic', 'staff1', 'setMusic', '{ music: q.music }'),
    nCall('b_playListen', 'sound1', 'play', '{ notes: q.listenNotes }'),
    nAssign('b_countHeard', 't.heard', 't.heard + 1'),
    ...startGuard.nodes,
    nOn('b_onReplay', 'listenBtn.clicked'),
    nCall('b_playReplay', 'sound1', 'play', '{ notes: q.listenNotes }'),
    ...replayGuard.nodes,
    nOn('b_onNote', 'staff1.noteClicked'),
    ...clickGuard.nodes,
    nBranch('b_isCorrect', 'event.payload.midi == q.answerMidi'),
    nAssign('b_markAnswered', 'q.state.answered', 'true'),
    nCall('b_highlightOk', 'staff1', 'highlight', "{ target: q.answerMidi, style: 'correct' }"),
    nCall('b_reward', 'sound1', 'play', '{ notes: q.rewardChord }'),
    nCall('b_feedbackOk', 'feedback', 'show', "{ text: '答对了！点「下一题」继续。', tone: 'success' }"),
    nAssign('b_countWrong', 'q.state.wrongAttempts', 'q.state.wrongAttempts + 1'),
    nCall('b_highlightBad', 'staff1', 'highlight', "{ target: event.payload.midi, style: 'wrong' }"),
    nCall('b_buzz', 'sound1', 'play', '{ notes: q.wrongBuzz }'),
    nCall('b_feedbackBad', 'feedback', 'show', "{ text: '不是这个音，再听听。', tone: 'error' }"),
    nOn('b_onNext', 'nextBtn.clicked'),
    ...gate.nodes,
    nComment('b_comment', '首次答对计分；答错高亮错误音并给反应；下一题收题（未答对=跳过）'),
  ]
  const edges: GraphEdge[] = [
    edge('b_onStart', 'b_setMusic'),
    ...chain('b_setMusic', 'b_playListen', 'b_countHeard', startGuard.entry),
    ...startGuard.edges,
    edge('b_onReplay', 'b_playReplay'),
    edge('b_playReplay', replayGuard.entry),
    ...replayGuard.edges,
    edge('b_onNote', clickGuard.entry),
    edge(clickGuard.entry, 'b_isCorrect', 'false'),
    ...clickGuard.edges,
    edge('b_isCorrect', 'b_markAnswered', 'true'),
    ...chain('b_markAnswered', 'b_highlightOk', 'b_reward', 'b_feedbackOk'),
    edge('b_isCorrect', 'b_countWrong', 'false'),
    ...chain('b_countWrong', 'b_highlightBad', 'b_buzz', 'b_feedbackBad'),
    edge('b_onNext', gate.entry),
    ...gate.edges,
  ]
  const surface = [
    surfaceComponent('prompt', 'label', {
      name: '题面',
      layout: box(24, 16, 552, 32),
      bindings: { text: 'q.prompt' },
    }),
    surfaceComponent('listenBtn', 'button', {
      name: '重听',
      layout: box(600, 16, 176, 36),
      props: { text: '🔊 听' },
    }),
    ...(showClefLabel
      ? [
          surfaceComponent('clefLabel', 'label', {
            name: '谱号',
            layout: box(600, 58, 176, 28),
            bindings: { text: 'q.clefLabel' },
          }),
        ]
      : []),
    surfaceComponent('staff1', 'staff', {
      name: '五线谱',
      layout: box(24, 72, 752, 264),
      props: { clickable: true },
    }),
    surfaceComponent('feedback', 'label', {
      name: '反馈',
      layout: box(24, 344, 752, 40),
      props: { text: '' },
    }),
    surfaceComponent('nextBtn', 'button', {
      name: '下一题',
      layout: box(600, 388, 176, 44),
      props: { text: '下一题 →' },
    }),
    surfaceComponent('sound1', 'sound', { name: '发声器' }),
  ]
  return questionType({
    id: 'staff-click',
    name: variant === 'clef-test' ? '谱号听音点击' : '五线谱听音',
    description:
      variant === 'clef-test'
        ? '高/中/低音谱号各一行：听音后在对应谱面点击目标音（演示 staff 的 setMusic/highlight 与谱号数据）。'
        : '听一个音，在五线谱上点出它：演示 staff 的 setMusic/highlight、音效与手动下一题。',
    surface,
    behavior: behaviorProgram(nodes, edges),
    state: [stateField('answered', 'boolean', false), stateField('wrongAttempts', 'number', 0)],
    typeState: [stateField('heard', 'number', 0)],
  })
}
