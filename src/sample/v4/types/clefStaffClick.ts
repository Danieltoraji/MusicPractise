/**
 * 题型 · staff-click 的 clef 变体（docs/51 §6 clef-test：高/中/低音谱号三行）。
 *
 * 与 `buildStaffClickType({ variant: 'clef-test' })` 等价，独立成一个 builder 便于注册表/
 * 编辑器题型库按「11 个内置题型」罗列（docs/52 W4.2 的项数口径）。
 */
import type { QuestionTypeDef } from '../../../engine/v4/model'
import { buildStaffClickType } from './staffClick'

export function buildClefStaffClickType(): QuestionTypeDef {
  return buildStaffClickType({ variant: 'clef-test' })
}
