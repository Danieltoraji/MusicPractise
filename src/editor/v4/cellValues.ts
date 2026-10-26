/**
 * v4 数据表单元格值转换小工具（编辑器 v4 专用）。
 *
 * 背景：v3 的 `notesFromCell/notesToCell` 在 `src/editor/graph/NoteChipsEditor.tsx`（W9 随 graph/
 * 清理），v4 编辑器需要同语义但**不依赖将被删除的 v3 模块**，因此在这里独立实现（结构相同的
 * `PlayNote` 形态，StaffEditor/StaffPreview 可直接消费）。
 *
 * 纪律（docs/27 / AGENTS 已知坑）：非标量单元格绝不 `String()` 兜底（会泄漏 `[object Object]`），
 * 不合规形态返回 null，由 UI 回落 JSON 高级编辑（JsonFallback）。
 */
import type { Json } from '../../engine/expr'
import { COLUMN_TYPE_LABELS, type ColumnType } from '../../engine/level'

/** 音符串元素（与 engine/level Note 同形；StaffEditor 的 PlayNote 结构兼容） */
export interface CellNote {
  midi?: number
  dur: string
  vel?: number
  t?: number
  rest?: boolean
}

/** 列类型下拉选项（按 engine/level 的中文标签单一真源生成顺序） */
export const COLUMN_TYPES_V4: { value: ColumnType; label: string }[] = (
  ['text', 'number', 'boolean', 'notes', 'list', 'json'] as ColumnType[]
).map((value) => ({ value, label: COLUMN_TYPE_LABELS[value] }))

/** 备注：v3 里 notes 列的中文名是「音符串」、list 是「文本列表」，与 COLUMN_TYPE_LABELS 一致 */

const PLAY_NOTE_KEYS = ['midi', 'dur', 'vel', 't', 'rest']

/**
 * 单元格 Json → 音符数组；结构不符返回 null（UI 回落 JSON 高级编辑）。
 * 已知键完整往返，未知键拒绝（防静默丢数据）。
 */
export function notesFromCell(v: unknown): CellNote[] | null {
  if (v === null || v === undefined) return []
  if (!Array.isArray(v)) return null
  const out: CellNote[] = []
  for (const item of v) {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) return null
    const rec = item as Record<string, unknown>
    for (const key of Object.keys(rec)) {
      if (!PLAY_NOTE_KEYS.includes(key)) return null
    }
    const dur = rec.dur
    if (dur !== undefined && typeof dur !== 'string') return null
    const t = rec.t
    if (t !== undefined && (typeof t !== 'number' || !Number.isFinite(t))) return null
    const vel = rec.vel
    if (vel !== undefined && (typeof vel !== 'number' || !Number.isFinite(vel))) return null
    const rest = rec.rest === true
    const midi = rec.midi
    if (!rest && (typeof midi !== 'number' || !Number.isFinite(midi))) return null
    if (rest && midi !== undefined) return null
    const note: CellNote = { dur: typeof dur === 'string' ? dur : '4n' }
    if (!rest) note.midi = Math.round(midi as number)
    if (vel !== undefined) note.vel = vel
    if (t !== undefined) note.t = t
    if (rest) note.rest = true
    out.push(note)
  }
  return out
}

/** 音符数组 → 单元格 Json（可选字段仅在有值时输出） */
export function notesToCell(notes: CellNote[]): Json[] {
  return notes.map((note) => {
    const cell: { [k: string]: Json } = {}
    if (note.rest === true) cell.rest = true
    else if (typeof note.midi === 'number') cell.midi = note.midi
    cell.dur = note.dur
    if (typeof note.vel === 'number') cell.vel = note.vel
    if (typeof note.t === 'number') cell.t = note.t
    return cell
  })
}

/**
 * list 列原始单元格值是否需要「将转换为文本列表」提示：
 * 非数组，或非「全字符串数组」（数字/对象数组会逐项 JSON 文本化）都提示。
 */
export function needsListConversion(v: unknown): boolean {
  return !Array.isArray(v) || v.some((item) => typeof item !== 'string')
}

/** 短摘要（按钮内预览用；不改变数据形态） */
export function clipText(text: string, max = 60): string {
  return text.length > max ? `${text.slice(0, max)}…` : text
}
