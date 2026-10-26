/**
 * 内置样例 · 调音入门（tune-intro，docs/51 §6）。
 *
 * 题型：tuner-target（麦克风 pitch 事件；容差内连续命中 stableSeconds×10 次即达标）。
 * 流程：顺序遍历题单 → 每题 ask → finish(v.score >= 20)。
 */
import { buildTunerTargetType } from '../types'
import { LEGACY_LEVEL_IDS } from './ids'
import { column, levelDoc, row, sampleMeta, scoreShell, sequenceFlow, table } from '../lib'

const TITLE = '调音入门'

export function buildTuneIntroLevel() {
  return levelDoc({
    id: LEGACY_LEVEL_IDS['tune-intro'],
    version: '1.0.0',
    meta: sampleMeta({
      title: TITLE,
      description: '对麦克风唱/奏标准音（A4 440Hz 等），音分稳定在容差内保持 1 秒即通过。需要麦克风权限。',
      tags: ['调音', '麦克风'],
      difficulty: 2,
    }),
    shell: scoreShell(TITLE),
    types: [buildTunerTargetType()],
    tables: {
      'tuner-target': table(
        [
          column('prompt', 'text', '题面'),
          column('targetMidi', 'number', '目标音高'),
          column('targetName', 'text', '目标音名'),
          column('tolerance', 'number', '容差（音分）'),
          column('stableSeconds', 'number', '稳定秒数'),
          column('scoring', 'number', '分值'),
        ],
        [
          row('row_a4', {
            prompt: '把声音稳定在 A4（440Hz）附近',
            targetMidi: 69,
            targetName: 'A4 · 440Hz',
            tolerance: 50,
            stableSeconds: 1,
            scoring: 10,
          }),
          row('row_a3', {
            prompt: '再来一次：这次用更低的 A3',
            targetMidi: 57,
            targetName: 'A3 · 220Hz',
            tolerance: 50,
            stableSeconds: 1,
            scoring: 10,
          }),
        ],
      ),
    },
    flow: sequenceFlow({ passExpr: 'v.score >= 20' }),
  })
}
