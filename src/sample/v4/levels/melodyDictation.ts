/**
 * 内置样例 · 旋律听写 · 键盘输入（melody-dictation，docs/51 §6）。
 *
 * 题型：keyboard-melody（fingering 键盘按序弹奏）。
 * 流程：顺序遍历题单 → 每题 ask（弹对即返回）→ finish(v.score >= 20)。
 */
import { buildKeyboardMelodyType } from '../types'
import { LEGACY_LEVEL_IDS } from './ids'
import { column, levelDoc, row, sampleMeta, scoreShell, sequenceFlow, table } from '../lib'

const TITLE = '旋律听写 · 键盘输入'

function notesOf(midis: number[]): number[] {
  return midis
}

export function buildMelodyDictationLevel() {
  return levelDoc({
    id: LEGACY_LEVEL_IDS['melody-dictation'],
    version: '1.0.0',
    meta: sampleMeta({
      title: TITLE,
      description:
        '听一段短旋律，在键盘上按顺序弹出它。演示序列播放、fingering 键盘输入与数组累加判定（v4：题型行为 + 数据行）。',
      tags: ['练耳', '旋律', '键盘'],
      difficulty: 3,
    }),
    shell: scoreShell(TITLE),
    types: [buildKeyboardMelodyType()],
    tables: {
      'keyboard-melody': table(
        [
          column('prompt', 'text', '题面'),
          column('listenNotes', 'notes', '听音'),
          column('targetNotes', 'json', '目标音高序列'),
          column('rewardChord', 'notes', '答对音效'),
          column('wrongBuzz', 'notes', '答错音效'),
          column('scoring', 'number', '分值'),
        ],
        [
          row('row_cde', {
            prompt: '听旋律，在键盘上弹出它（C-D-E）',
            listenNotes: [
              { midi: 60, dur: '4n' },
              { midi: 62, dur: '4n' },
              { midi: 64, dur: '2n' },
            ],
            targetNotes: notesOf([60, 62, 64]),
            rewardChord: [{ midi: 60 }, { midi: 64 }, { midi: 67 }, { midi: 72 }],
            wrongBuzz: [{ midi: 43, dur: '8n' }],
            scoring: 10,
          }),
          row('row_ceg', {
            prompt: '听旋律，在键盘上弹出它（有一个跳进）',
            listenNotes: [
              { midi: 60, dur: '4n' },
              { midi: 64, dur: '4n' },
              { midi: 67, dur: '2n' },
            ],
            targetNotes: notesOf([60, 64, 67]),
            rewardChord: [{ midi: 60 }, { midi: 64 }, { midi: 67 }, { midi: 72 }],
            wrongBuzz: [{ midi: 43, dur: '8n' }],
            scoring: 10,
          }),
          row('row_ega', {
            prompt: '听旋律，在键盘上弹出它',
            listenNotes: [
              { midi: 64, dur: '4n' },
              { midi: 67, dur: '4n' },
              { midi: 69, dur: '2n' },
            ],
            targetNotes: notesOf([64, 67, 69]),
            rewardChord: [{ midi: 64 }, { midi: 69 }, { midi: 72 }],
            wrongBuzz: [{ midi: 43, dur: '8n' }],
            scoring: 10,
          }),
        ],
      ),
    },
    flow: sequenceFlow({ passExpr: 'v.score >= 20' }),
  })
}
