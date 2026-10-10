/**
 * 输入校验（docs/31 §5.1 规则的单一真源）：handler 与种子脚本共用。
 * 刻意零依赖、纯 TS 可擦除语法——scripts/seed-admin.ts 会被 Node 原生
 * 类型剥离直接运行，不能引入非可擦除特性（如参数属性类）。
 */

export type ValidateResult = { ok: true; value: string } | { ok: false; message: string }

/** 昵称：2–24 字符，NFC 归一 + trim，拒绝控制字符 */
export function checkNickname(raw: unknown): ValidateResult {
  if (typeof raw !== 'string') return { ok: false, message: '昵称必须是字符串' }
  const value = raw.normalize('NFC').trim()
  const len = [...value].length
  if (len < 2 || len > 24) return { ok: false, message: '昵称需 2–24 个字符' }
  if (/[\u0000-\u001f\u007f]/.test(value)) return { ok: false, message: '昵称不能包含控制字符' }
  return { ok: true, value }
}

/** 密码：8–128 字符（不做复杂度强制，UI 提供建议） */
export function checkPassword(raw: unknown): ValidateResult {
  if (typeof raw !== 'string') return { ok: false, message: '密码必须是字符串' }
  const len = [...raw].length
  if (len < 8 || len > 128) return { ok: false, message: '密码至少 8 位（最长 128 位）' }
  return { ok: true, value: raw }
}
