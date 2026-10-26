/**
 * 内置样例 · 限时反应 · 3 秒作答（timed-reaction，docs/51 §6）。
 *
 * 题型：choice-timed（timer 单次 tick 超时；答对即返回）。
 * 流程：顺序遍历题单 → 每题 ask → finish(v.score >= 20)。
 */
import { buildChoiceTimedType } from '../types'
import { LEGACY_LEVEL_IDS } from './ids'
import { column, levelDoc, row, sampleMeta, scoreShell, sequenceFlow, table } from '../lib'

const TITLE = '限时反应 · 3 秒作答'
const OPTIONS = ['大三和弦', '小三和弦', '减三和弦', '增三和弦']

export function buildTimedReactionLevel() {
  return levelDoc({
    id: LEGACY_LEVEL_IDS['timed-reaction'],
    version: '1.0.0',
    meta: sampleMeta({
      title: TITLE,
      description: '每题只有 3 秒！演示隐形 timer 组件的 start/stop/tick 与限时判定（v4：timer.tick → status:timeout）。',
      tags: ['练耳', '限时', '反应'],
      difficulty: 3,
    }),
    shell: scoreShell(TITLE),
    types: [buildChoiceTimedType()],
    tables: {
      'choice-timed': table(
        [
          column('prompt', 'text', '题面'),
          column('options', 'list', '选项'),
          column('answer', 'text', '答案'),
          column('answerIndex', 'number', '答案下标'),
          column('listenNotes', 'notes', '听音'),
          column('timeMs', 'number', '限时毫秒'),
          column('scoring', 'number', '分值'),
        ],
        [
          row('row_chord_major', {
            prompt: '快速听辨：这是什么三和弦？',
            options: OPTIONS,
            answer: '大三和弦',
            answerIndex: 0,
            listenNotes: [{ midi: 60 }, { midi: 64 }, { midi: 67 }],
            timeMs: 3000,
            scoring: 10,
          }),
          row('row_chord_minor', {
            prompt: '快速听辨：这是什么三和弦？',
            options: OPTIONS,
            answer: '小三和弦',
            answerIndex: 1,
            listenNotes: [{ midi: 57 }, { midi: 60 }, { midi: 64 }],
            timeMs: 3000,
            scoring: 10,
          }),
          row('row_interval', {
            prompt: '快速听辨：两个音是什么音程？',
            options: ['大二度', '大三度', '纯四度', '纯五度'],
            answer: '纯四度',
            answerIndex: 2,
            listenNotes: [{ midi: 60 }, { midi: 65 }],
            timeMs: 3000,
            scoring: 10,
          }),
        ],
      ),
    },
    flow: sequenceFlow({ passExpr: 'v.score >= 20' }),
  })
}
