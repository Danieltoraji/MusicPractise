/**
 * 内置样例 · 节奏跟拍（rhythm-follow，docs/51 §6）。
 *
 * 题型：rhythm-tap（tap 累积 + roundDone 用 rhythmScore 判定；未达标重开一轮）。
 * 流程：顺序遍历题单 → 每题 ask → finish(v.score >= 15)。
 *
 * 数据列 grid 是相对起拍（四分音符 = 1 拍）的秒数栅格，与 rhythm 组件 tap.t 同一基准；
 * tolerance 为 rhythmScore 的容差（秒），passRatio 为达标比例。
 */
import type { Json } from '../../../engine/expr'
import { buildRhythmTapType } from '../types'
import { LEGACY_LEVEL_IDS } from './ids'
import { column, levelDoc, row, sampleMeta, scoreShell, sequenceFlow, table } from '../lib'

const TITLE = '节奏跟拍'

/** 8 拍、每拍两下（0, 0.5, 1, …）换算成秒（bpm → 秒/拍） */
function eighthGrid(bpm: number): Json[] {
  const spb = 60 / bpm
  const out: Json[] = []
  for (let beat = 0; beat < 8; beat += 0.5) out.push(Math.round(beat * spb * 1000) / 1000)
  return out
}

export function buildRhythmFollowLevel() {
  return levelDoc({
    id: LEGACY_LEVEL_IDS['rhythm-follow'],
    version: '1.0.0',
    meta: sampleMeta({
      title: TITLE,
      description:
        '跟随节拍器在圆盘上打拍子，节奏判定全在题型行为里（rhythmScore 表达式函数 + 多轮重试）。',
      tags: ['节奏', '跟拍'],
      difficulty: 2,
    }),
    shell: scoreShell(TITLE),
    types: [buildRhythmTapType()],
    tables: {
      'rhythm-tap': table(
        [
          column('prompt', 'text', '题面'),
          column('grid', 'json', '节奏栅格（秒）'),
          column('bpm', 'number', '速度'),
          column('beats', 'number', '拍数'),
          column('tolerance', 'number', '容差（秒）'),
          column('passRatio', 'number', '达标比例'),
          column('scoring', 'number', '分值'),
        ],
        [
          row('row_80bpm', {
            prompt: '80 BPM · 8 拍，跟着打',
            grid: eighthGrid(80),
            bpm: 80,
            beats: 8,
            tolerance: 0.12,
            passRatio: 0.8,
            scoring: 10,
          }),
          row('row_104bpm', {
            prompt: '提高到 104 BPM',
            grid: eighthGrid(104),
            bpm: 104,
            beats: 8,
            tolerance: 0.12,
            passRatio: 0.8,
            scoring: 10,
          }),
        ],
      ),
    },
    flow: sequenceFlow({ passExpr: 'v.score >= 15' }),
  })
}
