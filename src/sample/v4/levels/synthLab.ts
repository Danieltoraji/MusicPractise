/**
 * 内置样例 · 音色实验室 · 合成器示例（synth-lab，docs/51 §6）。
 *
 * 题型：synth-demo（每行一种波形；点击播放 → 下一音色返回）。
 * 数据表：wave / title / desc / notes（6 行 = 6 种音色）。
 * 流程：顺序遍历题单 → 每题 ask → finish(passed: true)（无分数）。
 */
import type { Json } from '../../../engine/expr'
import { buildSynthDemoType } from '../types'
import { LEGACY_LEVEL_IDS } from './ids'
import {
  box,
  column,
  levelDoc,
  row,
  sampleMeta,
  sequenceFlow,
  shellComponent,
  table,
  view,
} from '../lib'

const TITLE = '音色实验室 · 合成器示例'

function melodyNotes(midis: number[], durs: string[]): Json[] {
  return midis.map((midi, index) => ({ midi, dur: durs[index] }))
}

export function buildSynthLabLevel() {
  const shell = {
    views: [view('lab', '音色实验室'), view('settled', '结算视图')],
    components: [
      shellComponent('headLabel', 'label', 'lab', {
        name: '标题',
        layout: box(24, 12, 536, 40),
        props: { text: '🎹 音色实验室' },
      }),
      shellComponent('progressLabel', 'label', 'lab', {
        name: '进度',
        layout: box(600, 16, 176, 28),
        bindings: { text: "'进度 ' + v.row + ' / ' + run.total" },
      }),
      shellComponent('settledLabel', 'label', 'settled', {
        name: '结算文本',
        layout: box(200, 120, 400, 48),
        bindings: { text: "'已听 ' + run.total + ' 种音色'" },
      }),
    ],
  }
  return levelDoc({
    id: LEGACY_LEVEL_IDS['synth-lab'],
    version: '1.0.0',
    meta: sampleMeta({
      title: TITLE,
      description:
        '一张逻辑图 × 每型实例表（6 行）驱动全部内容：每种音色一行数据，「下一音色」推进题目；演示 synth 组件与「改数据不改图」。',
      tags: ['示例', '合成器', '数据表'],
      difficulty: 1,
      featured: true,
    }),
    shell,
    types: [buildSynthDemoType()],
    tables: {
      'synth-demo': table(
        [
          column('wave', 'text', '波形'),
          column('title', 'text', '音色名'),
          column('desc', 'text', '说明'),
          column('notes', 'notes', '示例旋律'),
        ],
        [
          row('row_sine', {
            wave: 'sine',
            title: '正弦 · 柔和',
            desc: '最纯净的波形，没有泛音——适合做提示音和温柔的背景',
            notes: melodyNotes([60, 64, 67], ['4n', '4n', '2n']),
          }),
          row('row_triangle', {
            wave: 'triangle',
            title: '三角 · 木琴',
            desc: '略带空心感的圆润音色，接近木琴或八音盒',
            notes: melodyNotes([67, 64, 60], ['8n', '8n', '2n']),
          }),
          row('row_square', {
            wave: 'square',
            title: '方波 · 芯片',
            desc: '只有通断两态的波形，是 8-bit 游戏机的经典音色',
            notes: melodyNotes([64, 64, 71], ['8n', '8n', '2n']),
          }),
          row('row_sawtooth', {
            wave: 'sawtooth',
            title: '锯齿 · 明亮',
            desc: '包含全部泛音的明亮波形，经典合成器主音（配了低通滤波会温暖很多）',
            notes: melodyNotes([60, 62, 64, 67], ['8n', '8n', '8n', '2n']),
          }),
          row('row_fm', {
            wave: 'fm',
            title: 'FM · 电钢',
            desc: '频率调制合成：调制波让音色起音明亮、随后变纯，像电钢琴',
            notes: melodyNotes([65, 69, 72], ['4n', '4n', '2n']),
          }),
          row('row_bell', {
            wave: 'bell',
            title: '钟琴 · 空灵',
            desc: '更高调制比的 FM，带自然衰减的长尾音，像风铃或编钟',
            notes: melodyNotes([72, 76, 79], ['4n', '4n', '2n']),
          }),
        ],
      ),
    },
    flow: sequenceFlow({ passExpr: 'true' }),
  })
}
