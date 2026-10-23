/**
 * AI 修改检查点（批次2a）：agent 模式发送时自动快照当前 doc，
 * 面板「↩ 回滚」据此恢复——单级撤销，回滚后清除。
 * 模块级 Map 按 doc.id 键（与会话 store 同款惯例）；快照为 structuredClone 深拷贝。
 */

import type { LevelDoc } from '../engine/level'

interface Checkpoint {
  doc: LevelDoc
  at: number
}

const checkpoints = new Map<string, Checkpoint>()

export function saveCheckpoint(docId: string, doc: LevelDoc): number {
  const at = Date.now()
  checkpoints.set(docId, { doc: structuredClone(doc), at })
  return at
}

export function getCheckpoint(docId: string): Checkpoint | null {
  return checkpoints.get(docId) ?? null
}

export function clearCheckpoint(docId: string): void {
  checkpoints.delete(docId)
}

/**
 * 检查点换档（docs/42 §4.6 C5）：内置示例另存副本后 doc.id 变更，单级回滚快照
 * 必须跟着迁移——否则同挂载内「↩ 回滚」按钮消失，AI 修改失去回滚入口。
 */
export function renameCheckpoint(oldDocId: string, newDocId: string): void {
  if (oldDocId === newDocId) return
  const cp = checkpoints.get(oldDocId)
  if (!cp) return
  checkpoints.delete(oldDocId)
  checkpoints.set(newDocId, cp)
}
