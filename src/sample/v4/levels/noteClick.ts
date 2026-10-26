/**
 * 内置样例 · 听音点击 · 入门（note-click，docs/51 §6）。
 *
 * 题型：staff-click（五线谱点击）。
 * 数据表：prompt / music（谱面）/ listenNotes / answerMidi / rewardChord / wrongBuzz / scoring。
 * 流程：顺序遍历题单 → 每题 ask → 手动下一题 → finish(v.score >= 20)。
 */
import type { Json } from '../../../engine/expr'
import { buildStaffClickType } from '../types'
import { LEGACY_LEVEL_IDS } from './ids'
import {
  box,
  column,
  levelDoc,
  row,
  sampleMeta,
  scoreShell,
  sequenceFlow,
  shellComponent,
  table,
} from '../lib'

const TITLE = '听音点击 · 入门'

function trebleNotes(): Json {
  return { notes: [{ midi: 60 }, { midi: 62 }, { midi: 64 }, { midi: 65 }], clef: 'treble' }
}

function trebleNotes2(): Json {
  return { notes: [{ midi: 65 }, { midi: 67 }, { midi: 69 }, { midi: 71 }], clef: 'treble' }
}

function trebleNotes3(): Json {
  return { notes: [{ midi: 67 }, { midi: 69 }, { midi: 72 }, { midi: 74 }], clef: 'treble' }
}

export function buildNoteClickLevel() {
  const shell = scoreShell(TITLE, {
    main: [
      // 题面由题型 surface 显示；shell 只放关卡级说明，演示 shell 绑定 v.* / run.*
      shellComponent('hintLabel', 'label', 'main', {
        name: '玩法提示',
        layout: box(24, 440, 752, 24),
        props: { text: '听一个音，在五线谱上点出它；答对后点「下一题」。' },
      }),
    ],
  })
  return levelDoc({
    id: LEGACY_LEVEL_IDS['note-click'],
    version: '1.0.0',
    meta: sampleMeta({
      title: TITLE,
      description:
        '听发声器播放的音，在五线谱上点击对应的音符。演示 v4 的「题型 surface + 数据行 + 顺序遍历题单」组合。',
      tags: ['练耳', '音名', '入门'],
      difficulty: 1,
    }),
    shell,
    types: [buildStaffClickType({ variant: 'note-click' })],
    tables: {
      'staff-click': table(
        [
          column('prompt', 'text', '题面'),
          column('music', 'json', '谱面'),
          column('listenNotes', 'notes', '听音'),
          column('answerMidi', 'number', '答案音高'),
          column('rewardChord', 'notes', '答对音效'),
          column('wrongBuzz', 'notes', '答错音效'),
          column('scoring', 'number', '分值'),
        ],
        [
          row('row_01', {
            prompt: '听 —— 点击你听到的那个音',
            music: trebleNotes(),
            listenNotes: [{ midi: 64, dur: '2n', vel: 100 }],
            answerMidi: 64,
            rewardChord: [
              { midi: 60, vel: 100 },
              { midi: 64, vel: 100 },
              { midi: 67, vel: 100 },
              { midi: 72, vel: 100 },
            ],
            wrongBuzz: [{ midi: 43, dur: '8n' }],
            scoring: 10,
          }),
          row('row_02', {
            prompt: '听 —— 点击你听到的那个音',
            music: trebleNotes2(),
            listenNotes: [{ midi: 71, dur: '2n' }],
            answerMidi: 71,
            rewardChord: [{ midi: 65 }, { midi: 69 }, { midi: 72 }],
            wrongBuzz: [{ midi: 43, dur: '8n' }],
            scoring: 10,
          }),
          row('row_03', {
            prompt: '听 —— 点击你听到的那个音',
            music: trebleNotes3(),
            listenNotes: [{ midi: 72, dur: '2n' }],
            answerMidi: 72,
            rewardChord: [{ midi: 67 }, { midi: 72 }, { midi: 76 }],
            wrongBuzz: [{ midi: 43, dur: '8n' }],
            scoring: 10,
          }),
        ],
      ),
    },
    flow: sequenceFlow({ passExpr: 'v.score >= 20' }),
  })
}
