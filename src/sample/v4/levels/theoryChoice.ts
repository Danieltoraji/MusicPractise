/**
 * 内置样例 · 和弦听辨 · 选择题模板（theory-choice，docs/51 §6）。
 *
 * 题型：choice-listen（听音选择）。
 * 流程：顺序遍历题单 → 每题 ask（手动下一题）→ finish(v.score >= 10)。
 */
import { buildChoiceListenType } from '../types'
import { LEGACY_LEVEL_IDS } from './ids'
import { column, levelDoc, row, sampleMeta, scoreShell, sequenceFlow, table } from '../lib'

const TITLE = '和弦听辨 · 选择题模板'
const OPTIONS = ['大三和弦', '小三和弦', '减三和弦', '增三和弦']

export function buildTheoryChoiceLevel() {
  return levelDoc({
    id: LEGACY_LEVEL_IDS['theory-choice'],
    version: '1.0.0',
    meta: sampleMeta({
      title: TITLE,
      description: '听和弦，从选项中选出名称。演示 choice 组件、reveal 判定展示与选择题模板复用。',
      tags: ['练耳', '和弦', '选择题'],
      difficulty: 2,
    }),
    shell: scoreShell(TITLE),
    types: [buildChoiceListenType()],
    tables: {
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
          row('row_major', {
            prompt: '听和弦，选出名称',
            options: OPTIONS,
            answer: '大三和弦',
            answerIndex: 0,
            listenNotes: [
              { midi: 60, vel: 100 },
              { midi: 64, vel: 100 },
              { midi: 67, vel: 100 },
            ],
            scoring: 10,
          }),
          row('row_minor', {
            prompt: '听和弦，选出名称',
            options: OPTIONS,
            answer: '小三和弦',
            answerIndex: 1,
            listenNotes: [{ midi: 57 }, { midi: 60 }, { midi: 64 }],
            scoring: 10,
          }),
        ],
      ),
    },
    flow: sequenceFlow({ passExpr: 'v.score >= 10' }),
  })
}
