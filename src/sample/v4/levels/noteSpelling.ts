/**
 * 内置样例 · 音名拼写 · 输入框作答（note-spelling，docs/51 §6）。
 *
 * 题型：text-answer（input 回车提交，大小写无关 + aliases 兜底）。
 * 流程：顺序遍历题单 → 每题 ask（拼对即返回）→ finish(v.score >= 20)。
 */
import { buildTextAnswerType } from '../types'
import { LEGACY_LEVEL_IDS } from './ids'
import { column, levelDoc, row, sampleMeta, scoreShell, sequenceFlow, table } from '../lib'

const TITLE = '音名拼写 · 输入框作答'

export function buildNoteSpellingLevel() {
  return levelDoc({
    id: LEGACY_LEVEL_IDS['note-spelling'],
    version: '1.0.0',
    meta: sampleMeta({
      title: TITLE,
      description: '听和弦，用音名拼写它并回车提交。演示 input 组件与大小写无关的文本判定（含 aliases 兜底与提示）。',
      tags: ['乐理', '和弦', '拼写'],
      difficulty: 2,
    }),
    shell: scoreShell(TITLE),
    types: [buildTextAnswerType()],
    tables: {
      'text-answer': table(
        [
          column('prompt', 'text', '题面'),
          column('answer', 'text', '答案'),
          column('aliases', 'list', '可接受写法'),
          column('listenNotes', 'notes', '听音'),
          column('rewardChord', 'notes', '答对音效'),
          column('wrongBuzz', 'notes', '答错音效'),
          column('hint', 'text', '提示'),
          column('scoring', 'number', '分值'),
        ],
        [
          row('row_ceg', {
            prompt: '拼写这个和弦的音名',
            answer: 'CEG',
            aliases: ['ceg', 'c-e-g', 'c e g'],
            listenNotes: [{ midi: 60 }, { midi: 64 }, { midi: 67 }],
            rewardChord: [{ midi: 60 }, { midi: 64 }, { midi: 67 }, { midi: 72 }],
            wrongBuzz: [{ midi: 43, dur: '8n' }],
            hint: '从 C 开始：C + 大三度 + 小三度',
            scoring: 10,
          }),
          row('row_fac', {
            prompt: '拼写这个和弦的音名',
            answer: 'FAC',
            aliases: ['fac', 'f-a-c', 'f a c'],
            listenNotes: [{ midi: 53 }, { midi: 57 }, { midi: 60 }],
            rewardChord: [{ midi: 53 }, { midi: 57 }, { midi: 60 }, { midi: 65 }],
            wrongBuzz: [{ midi: 43, dur: '8n' }],
            hint: '从 F 开始的大三和弦',
            scoring: 10,
          }),
          row('row_gbd', {
            prompt: '拼写这个和弦的音名',
            answer: 'GBD',
            aliases: ['gbd', 'g-b-d', 'g b d'],
            listenNotes: [{ midi: 55 }, { midi: 59 }, { midi: 62 }],
            rewardChord: [{ midi: 55 }, { midi: 59 }, { midi: 62 }, { midi: 67 }],
            wrongBuzz: [{ midi: 43, dur: '8n' }],
            hint: '从 G 开始的大三和弦',
            scoring: 10,
          }),
        ],
      ),
    },
    flow: sequenceFlow({ passExpr: 'v.score >= 20' }),
  })
}
