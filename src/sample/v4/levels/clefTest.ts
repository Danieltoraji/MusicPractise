/**
 * 内置样例 · 听音点击 · 测试（clef-test，docs/51 §6）。
 *
 * 题型：staff-click 的 clef 变体（额外显示谱号标签；每行 music.clef 不同）。
 * 流程：顺序遍历题单 → 每题 ask → 手动下一题 → finish(v.score >= 30)。
 */
import type { Json } from '../../../engine/expr'
import { buildClefStaffClickType } from '../types'
import { LEGACY_LEVEL_IDS } from './ids'
import { column, levelDoc, row, sampleMeta, scoreShell, sequenceFlow, table } from '../lib'

const TITLE = '听音点击 · 测试'

/** 谱号全音域半音铺面：low..high 每个半音一个全音符（与 v3 样例同内容） */
function chromaticMusic(clef: 'treble' | 'alto' | 'bass', low: number, high: number): Json {
  const notes: Json[] = []
  for (let midi = low; midi <= high; midi++) notes.push({ midi, dur: '1n' })
  return { notes, clef }
}

function majorTriad(root: number): Json[] {
  return [{ midi: root }, { midi: root + 4 }, { midi: root + 7 }]
}

export function buildClefTestLevel() {
  return levelDoc({
    id: LEGACY_LEVEL_IDS['clef-test'],
    version: '1.0.0',
    meta: sampleMeta({
      title: TITLE,
      description:
        '谱面测试关：高/中/低音谱号各一题，每题铺出该谱号下加三线到上加三线的全部半音（含升号），点击任意音符即可试听其音高。',
      tags: ['谱面测试', '全音域', '谱号'],
      difficulty: 5,
    }),
    shell: scoreShell(TITLE),
    types: [buildClefStaffClickType()],
    tables: {
      'staff-click': table(
        [
          column('prompt', 'text', '题面'),
          column('clefLabel', 'text', '谱号'),
          column('music', 'json', '谱面'),
          column('listenNotes', 'notes', '听音'),
          column('answerMidi', 'number', '答案音高'),
          column('rewardChord', 'notes', '答对音效'),
          column('wrongBuzz', 'notes', '答错音效'),
          column('scoring', 'number', '分值'),
        ],
        [
          row('row_treble', {
            prompt: '听 —— 在高音谱号谱面上点击你听到的那个音',
            clefLabel: '高音谱号',
            music: chromaticMusic('treble', 53, 76),
            listenNotes: [{ midi: 69, dur: '2n' }],
            answerMidi: 69,
            rewardChord: majorTriad(69),
            wrongBuzz: [{ midi: 33, dur: '8n' }],
            scoring: 10,
          }),
          row('row_alto', {
            prompt: '听 —— 在中音谱号谱面上点击你听到的那个音',
            clefLabel: '中音谱号',
            music: chromaticMusic('alto', 43, 77),
            listenNotes: [{ midi: 60, dur: '2n' }],
            answerMidi: 60,
            rewardChord: majorTriad(60),
            wrongBuzz: [{ midi: 33, dur: '8n' }],
            scoring: 10,
          }),
          row('row_bass', {
            prompt: '听 —— 在低音谱号谱面上点击你听到的那个音',
            clefLabel: '低音谱号',
            music: chromaticMusic('bass', 33, 67),
            listenNotes: [{ midi: 50, dur: '2n' }],
            answerMidi: 50,
            rewardChord: majorTriad(50),
            wrongBuzz: [{ midi: 33, dur: '8n' }],
            scoring: 10,
          }),
        ],
      ),
    },
    flow: sequenceFlow({ passExpr: 'v.score >= 30' }),
  })
}
