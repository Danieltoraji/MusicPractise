/**
 * v4 内置样例关卡注册表（docs/51 §6）：10 个关卡 builder + 生成/测试元数据。
 *
 * 保留现 v3 样例的**关卡 id / version / meta.title / 文件名**（W9 覆盖 `src/sample/*.level.json`
 * 与视觉矩阵引用时零连带改动）；`flowKind` 供数据变更属性测试区分「固定步骤教程」与「遍历题单」。
 */
import type { LevelDocV4 } from '../../../engine/v4/model'
import { buildClefTestLevel } from './clefTest'
import { buildMelodyDictationLevel } from './melodyDictation'
import { buildNoteClickLevel } from './noteClick'
import { buildNoteSpellingLevel } from './noteSpelling'
import { buildRhythmFollowLevel } from './rhythmFollow'
import { buildSynthLabLevel } from './synthLab'
import { buildTheoryChoiceLevel } from './theoryChoice'
import { buildTimedReactionLevel } from './timedReaction'
import { buildTuneIntroLevel } from './tuneIntro'
import { buildTutorialHelloLevel } from './tutorialHello'
import { LEGACY_LEVEL_IDS } from './ids'

export type SampleFlowKind = 'sequence' | 'tutorial'

export interface SampleLevelSpec {
  /** 产物文件（相对 src/sample/v4 目录；与 v3 样例文件名一致） */
  file: string
  /** 关卡 id（与 v3 样例一致；同时是资源库内置种子 id） */
  id: string
  title: string
  /** 本关题型 id（顺序 = 自动题单平票排序） */
  typeIds: string[]
  /** finish 的通过阈值（与 flow 内 passed 表达式一致；属性测试用来断言 passed） */
  passScore: number
  /** sequence = foreach(run.questions)；tutorial = 固定步骤流程 */
  flowKind: SampleFlowKind
  build(): LevelDocV4
}

export const SAMPLE_LEVELS: SampleLevelSpec[] = [
  {
    file: 'tutorial-hello.level.json',
    id: LEGACY_LEVEL_IDS['tutorial-hello'],
    title: '新手引导 · 交互教程',
    typeIds: ['button-step', 'slider-step', 'choice-listen'],
    passScore: 10,
    flowKind: 'tutorial',
    build: buildTutorialHelloLevel,
  },
  {
    file: 'synth-lab.level.json',
    id: LEGACY_LEVEL_IDS['synth-lab'],
    title: '音色实验室 · 合成器示例',
    typeIds: ['synth-demo'],
    passScore: 0,
    flowKind: 'sequence',
    build: buildSynthLabLevel,
  },
  {
    file: 'note-click.level.json',
    id: LEGACY_LEVEL_IDS['note-click'],
    title: '听音点击 · 入门',
    typeIds: ['staff-click'],
    passScore: 20,
    flowKind: 'sequence',
    build: buildNoteClickLevel,
  },
  {
    file: 'clef-test.level.json',
    id: LEGACY_LEVEL_IDS['clef-test'],
    title: '听音点击 · 测试',
    typeIds: ['staff-click'],
    passScore: 30,
    flowKind: 'sequence',
    build: buildClefTestLevel,
  },
  {
    file: 'theory-choice.level.json',
    id: LEGACY_LEVEL_IDS['theory-choice'],
    title: '和弦听辨 · 选择题模板',
    typeIds: ['choice-listen'],
    passScore: 10,
    flowKind: 'sequence',
    build: buildTheoryChoiceLevel,
  },
  {
    file: 'melody-dictation.level.json',
    id: LEGACY_LEVEL_IDS['melody-dictation'],
    title: '旋律听写 · 键盘输入',
    typeIds: ['keyboard-melody'],
    passScore: 20,
    flowKind: 'sequence',
    build: buildMelodyDictationLevel,
  },
  {
    file: 'note-spelling.level.json',
    id: LEGACY_LEVEL_IDS['note-spelling'],
    title: '音名拼写 · 输入框作答',
    typeIds: ['text-answer'],
    passScore: 20,
    flowKind: 'sequence',
    build: buildNoteSpellingLevel,
  },
  {
    file: 'timed-reaction.level.json',
    id: LEGACY_LEVEL_IDS['timed-reaction'],
    title: '限时反应 · 3 秒作答',
    typeIds: ['choice-timed'],
    passScore: 20,
    flowKind: 'sequence',
    build: buildTimedReactionLevel,
  },
  {
    file: 'rhythm-follow.level.json',
    id: LEGACY_LEVEL_IDS['rhythm-follow'],
    title: '节奏跟拍',
    typeIds: ['rhythm-tap'],
    passScore: 15,
    flowKind: 'sequence',
    build: buildRhythmFollowLevel,
  },
  {
    file: 'tune-intro.level.json',
    id: LEGACY_LEVEL_IDS['tune-intro'],
    title: '调音入门',
    typeIds: ['tuner-target'],
    passScore: 20,
    flowKind: 'sequence',
    build: buildTuneIntroLevel,
  },
]

export { LEGACY_LEVEL_IDS } from './ids'
