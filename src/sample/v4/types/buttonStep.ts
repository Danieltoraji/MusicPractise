/**
 * 题型 · button-step（教程第 1 步：按钮）。
 *
 * 交互：点「点我」按钮 → 反馈文案 → 本题返回（无手动下一题，教程按步骤推进）。
 * 计分：scoreDelta = q.scoring（教程该行 scoring = 0，仅 choice 计 10 分）。
 * 行为预设：`on start` 的 answered 守卫（重复调用同一行不重复计分）+ 点击即返回。
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

export function buildButtonStepType() {
  const startGuard = answeredGuard('b_start')
  const nodes: BehaviorNode[] = [
    nOn('b_onStart', 'start'),
    ...startGuard.nodes,
    nOn('b_onTry', 'tryBtn.clicked'),
    nCall('b_feedback', 'feedback', 'show', "{ text: '很棒！按钮被点亮了 —— 这就是最小交互单元。', tone: 'success' }"),
    nAssign('b_count', 't.clicks', 't.clicks + 1'),
    nReturn('b_ret', "{ status: 'answered', correct: true, scoreDelta: q.scoring }"),
    nComment('b_comment', '预设「点击即完成」：副作用后直接 return；on start 守卫保证重复调用不重复计分'),
  ]
  const edges: GraphEdge[] = [
    edge('b_onStart', startGuard.entry),
    ...startGuard.edges,
    ...chain('b_onTry', 'b_feedback', 'b_count', 'b_ret'),
  ]
  return questionType({
    id: 'button-step',
    name: '按钮步骤',
    description: '点一下按钮完成这一步：演示 surface 组件 + on start 守卫 + 点击即返回。',
    surface: [
      surfaceComponent('prompt', 'label', {
        name: '题面',
        layout: box(24, 16, 752, 32),
        bindings: { text: 'q.prompt' },
      }),
      surfaceComponent('tryBtn', 'button', {
        name: '试试点我',
        layout: box(280, 140, 240, 64),
        props: { text: '点我！' },
      }),
      surfaceComponent('feedback', 'label', {
        name: '反馈',
        layout: box(24, 240, 752, 36),
        props: { text: '' },
      }),
    ],
    behavior: behaviorProgram(nodes, edges),
    state: [stateField('answered', 'boolean', false)],
    typeState: [stateField('clicks', 'number', 0)],
  })
}
