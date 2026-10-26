/**
 * 内置样例 · 新手引导 · 交互教程（tutorial-hello，docs/51 §6）。
 *
 * 题型：button-step → slider-step → choice-listen（三个题型各 1 行）。
 * 流程（docs/51 特殊流程）：
 *   setView welcome → waitShell start_btn.clicked → setView step1 → ask 按钮题
 *   → setView step2 → ask 滑块题 → setView step3 → ask 听音选答题
 *   → setView done → finish(v.score >= 10) → waitShell again_btn.clicked → restart。
 *   **只有听音选答计 10 分**（按钮 / 滑块题 scoreDelta = 0）。
 */
import { buildButtonStepType, buildChoiceListenType, buildSliderStepType } from '../types'
import { LEGACY_LEVEL_IDS } from './ids'
import {
  box,
  chain,
  column,
  flowProgram,
  levelDoc,
  nAsk,
  nAssign,
  nComment,
  nFinish,
  nRestart,
  nSetView,
  nStart,
  nWaitShell,
  row,
  sampleMeta,
  shellComponent,
  stateField,
  table,
  view,
} from '../lib'

const TITLE = '新手引导 · 交互教程'

export function buildTutorialHelloLevel() {
  const shell = {
    views: [
      view('welcome', '欢迎'),
      view('step1', '第 1 步'),
      view('step2', '第 2 步'),
      view('step3', '第 3 步'),
      view('done', '完成'),
    ],
    components: [
      shellComponent('t_label', 'label', 'welcome', {
        name: '欢迎标题',
        layout: box(24, 24, 752, 44),
        props: { text: '🎵 欢迎来到音乐练习！' },
      }),
      shellComponent('w_label', 'label', 'welcome', {
        name: '欢迎说明',
        layout: box(24, 80, 752, 96),
        props: {
          text: '接下来 3 步，你会认识本平台关卡的全部交互：按钮、滑块、听音选答。\n随时可以点页面底部的「重开本关」从头来过。',
        },
      }),
      shellComponent('start_btn', 'button', 'welcome', {
        name: '开始按钮',
        layout: box(24, 200, 200, 48),
        props: { text: '开始 ▶' },
      }),
      shellComponent('s1_label', 'label', 'step1', {
        name: '第 1 步说明',
        layout: box(24, 352, 752, 32),
        props: { text: '第 1 步 · 按钮：点击下面的按钮试试' },
      }),
      shellComponent('s2_label', 'label', 'step2', {
        name: '第 2 步说明',
        layout: box(24, 352, 752, 32),
        props: { text: '第 2 步 · 滑块：拖动滑块，感受数值变化' },
      }),
      shellComponent('s3_label', 'label', 'step3', {
        name: '第 3 步说明',
        layout: box(24, 352, 752, 32),
        props: { text: '第 3 步 · 听音：先播一段 Do-Re-Mi，最后一个音是题目，选出它的唱名' },
      }),
      shellComponent('done_label', 'label', 'done', {
        name: '完成标题',
        layout: box(24, 32, 752, 44),
        props: { text: '🎉 教程完成！' },
      }),
      shellComponent('score_label', 'label', 'done', {
        name: '本关得分',
        layout: box(24, 92, 752, 36),
        bindings: { text: "'本关得分 ' + v.score" },
      }),
      shellComponent('again_btn', 'button', 'done', {
        name: '再学一遍',
        layout: box(24, 160, 200, 48),
        props: { text: '再学一遍' },
      }),
    ],
  }

  const nodes = [
    nStart('f_start'),
    nSetView('f_welcome', 'welcome'),
    nWaitShell('f_waitStart', 'start_btn.clicked'),
    nSetView('f_step1', 'step1'),
    nAsk('f_askButton', "{ type: 'button-step', row: 'row_button' }", 'r1'),
    nAssign('f_add1', 'v.score', 'v.score + (local.r1.scoreDelta || 0)'),
    nAssign('f_row1', 'v.row', 'v.row + 1'),
    nSetView('f_step2', 'step2'),
    nAsk('f_askSlider', "{ type: 'slider-step', row: 'row_slider' }", 'r2'),
    nAssign('f_add2', 'v.score', 'v.score + (local.r2.scoreDelta || 0)'),
    nAssign('f_row2', 'v.row', 'v.row + 1'),
    nSetView('f_step3', 'step3'),
    nAsk('f_askChoice', "{ type: 'choice-listen', row: 'row_choice' }", 'r3'),
    nAssign('f_add3', 'v.score', 'v.score + (local.r3.scoreDelta || 0)'),
    nAssign('f_row3', 'v.row', 'v.row + 1'),
    nSetView('f_done', 'done'),
    nFinish('f_finish', 'v.score >= 10'),
    nWaitShell('f_waitAgain', 'again_btn.clicked'),
    nRestart('f_restart'),
    nComment('f_comment', 'docs/51 §6 教程特殊流程：固定 3 步 + 结算后 waitShell → restart（重玩走流程图，而非只靠 runner 按钮）'),
  ]
  const edges = chain('f_start', 'f_welcome', 'f_waitStart', 'f_step1', 'f_askButton', 'f_add1', 'f_row1')
  edges.push(
    ...chain('f_row1', 'f_step2', 'f_askSlider', 'f_add2', 'f_row2'),
    ...chain('f_row2', 'f_step3', 'f_askChoice', 'f_add3', 'f_row3'),
    ...chain('f_row3', 'f_done', 'f_finish', 'f_waitAgain', 'f_restart'),
  )

  return levelDoc({
    id: LEGACY_LEVEL_IDS['tutorial-hello'],
    version: '1.0.0',
    meta: sampleMeta({
      title: TITLE,
      description:
        '3 步学会按钮、滑块与听音选答。对创作者而言，这也是 v4「题型函数 + 固定步骤流程 + 结算后 waitShell/restart」的活示例。',
      tags: ['教程', '新手', '示例'],
      difficulty: 1,
      featured: true,
    }),
    shell,
    types: [buildButtonStepType(), buildSliderStepType(), buildChoiceListenType()],
    tables: {
      'button-step': table(
        [column('prompt', 'text', '题面'), column('scoring', 'number', '分值')],
        [row('row_button', { prompt: '点一下按钮，看看会发生什么。', scoring: 0 })],
      ),
      'slider-step': table(
        [
          column('prompt', 'text', '题面'),
          column('target', 'number', '参考值'),
          column('scoring', 'number', '分值'),
        ],
        [row('row_slider', { prompt: '拖动滑块，把数值拖到任意位置，然后点下一步。', target: 42, scoring: 0 })],
      ),
      'choice-listen': table(
        [
          column('prompt', 'text', '题面'),
          column('options', 'list', '选项'),
          column('answer', 'text', '答案'),
          column('answerIndex', 'number', '答案下标'),
          column('listenNotes', 'notes', '听音'),
          column('scoring', 'number', '分值'),
        ],
        [
          row('row_choice', {
            prompt: '听三音：Do-Re-Mi，最后一个音是？',
            options: ['Do', 'Re', 'Mi'],
            answer: 'Mi',
            answerIndex: 2,
            listenNotes: [
              { midi: 60, dur: '8n' },
              { midi: 62, dur: '8n' },
              { midi: 64, dur: '2n' },
            ],
            scoring: 10,
          }),
        ],
      ),
    },
    flow: flowProgram(nodes, edges, [stateField('score', 'number', 0), stateField('row', 'number', 0)]),
  })
}
