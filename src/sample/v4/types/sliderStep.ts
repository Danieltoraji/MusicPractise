/**
 * 题型 · slider-step（教程第 2 步：滑块）。
 *
 * 交互：拖动滑块 → 反馈显示当前值 → 点「下一步」收题（payload 带回 value，供流程/AI 调试观察）。
 * 计分：scoreDelta = 0（教程只让听音选答计分）。
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
  type ComponentOptions,
} from '../lib'

const sliderProps: ComponentOptions['props'] = { min: 0, max: 100, step: 1, initial: 0 }

export function buildSliderStepType() {
  const startGuard = answeredGuard('b_start')
  const changeGuard = answeredGuard('b_change')
  const nodes: BehaviorNode[] = [
    nOn('b_onStart', 'start'),
    ...startGuard.nodes,
    nOn('b_onChange', 'slider1.changed'),
    nAssign('b_store', 'q.state.value', 'event.payload.value'),
    nAssign('b_count', 't.changes', 't.changes + 1'),
    nCall('b_feedback', 'feedback', 'show', "{ text: '当前值：' + event.payload.value, tone: 'info' }"),
    ...changeGuard.nodes,
    nOn('b_onNext', 'nextBtn.clicked'),
    nReturn(
      'b_ret',
      "{ status: 'answered', correct: true, scoreDelta: 0, payload: { value: q.state.value } }",
    ),
    nComment('b_comment', '手动推进：滑块只记录 q.state.value，由「下一步」返回 payload'),
  ]
  const edges: GraphEdge[] = [
    edge('b_onStart', startGuard.entry),
    ...startGuard.edges,
    edge('b_onChange', 'b_store'),
    ...chain('b_store', 'b_count', 'b_feedback', changeGuard.entry),
    ...changeGuard.edges,
    edge('b_onNext', 'b_ret'),
  ]
  return questionType({
    id: 'slider-step',
    name: '滑块步骤',
    description: '拖动滑块记录数值，点下一题继续：演示 slider.changed 事件与手动推进。',
    surface: [
      surfaceComponent('prompt', 'label', {
        name: '题面',
        layout: box(24, 16, 752, 32),
        bindings: { text: 'q.prompt' },
      }),
      surfaceComponent('slider1', 'slider', {
        name: '滑块',
        layout: box(140, 130, 520, 44),
        props: sliderProps,
      }),
      surfaceComponent('feedback', 'label', {
        name: '反馈',
        layout: box(24, 210, 752, 36),
        props: { text: '' },
      }),
      surfaceComponent('nextBtn', 'button', {
        name: '下一步',
        layout: box(300, 280, 200, 48),
        props: { text: '下一步 ▶' },
      }),
    ],
    behavior: behaviorProgram(nodes, edges),
    state: [stateField('answered', 'boolean', false), stateField('value', 'number', 0)],
    typeState: [stateField('changes', 'number', 0)],
  })
}
