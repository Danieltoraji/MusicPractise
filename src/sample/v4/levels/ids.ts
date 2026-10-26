/**
 * 保留自 v3 内置样例的关卡 id / 标题 / 文件名（docs/51 §6 / docs/52 W4.3 约束：W9 覆盖时零连带改动）。
 *
 * 本文件由脚本按 `src/sample/*.level.json` 的既有值生成一次；之后由 builder 维护（id 不再从 v3 样例读取）。
 */
export const LEGACY_LEVEL_IDS = {
  'clef-test': 'res_01J9E0E0E0E0E0E0E0E0E0E0E0',
  'melody-dictation': 'res_01J9A0A0A0A0A0A0A0A0A0A0A3',
  'note-click': 'res_01J9A0A0A0A0A0A0A0A0A0A0A1',
  'note-spelling': 'res_01J9A0A0A0A0A0A0A0A0A0A0A5',
  'rhythm-follow': 'res_01J9F0F0F0F0F0F0F0F0F0F0F0',
  'synth-lab': 'res_01J9C100000000000000000000',
  'theory-choice': 'res_01J9A0A0A0A0A0A0A0A0A0A0A2',
  'timed-reaction': 'res_01J9A0A0A0A0A0A0A0A0A0A0A4',
  'tune-intro': 'res_01J9F1F1F1F1F1F1F1F1F1F1F1',
  'tutorial-hello': 'res_01J9C000000000000000000000',
} as const

export type LegacyLevelSlug = keyof typeof LEGACY_LEVEL_IDS

