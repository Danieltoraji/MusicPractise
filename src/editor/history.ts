/**
 * 编辑器撤销/重做历史（docs/40 §12.3 / docs/42 §4.6 C5）。
 * 历史条目存 doc 引用而非深拷贝（docState 变换恒返回新对象、全仓禁原地 mutation）。
 *
 * 抽出的唯一目的：内置示例「另存副本」时对 past/future 两栈做**身份重映射**——
 * 此前保存只 setDoc(saved)，历史栈仍保留内置原档引用，一次 Ctrl+Z 会把 doc.id
 * 退回内置 id（实测标题从「内置示例（副本）」变回「内置示例」），此后保存又因
 * existing.builtIn=1 再建第二份副本（docs/42 §4.6）。
 *
 * 入栈/同 tag 合并/上限截断仍留在 EditorPage（与 setDirty / setSavedTip 等状态耦合）。
 */
import type { LevelDoc } from '../engine/level'

export interface EditorHistory {
  past: LevelDoc[]
  future: LevelDoc[]
}

/** 撤销栈上限（docs/40 §12.3：cap 50） */
export const HISTORY_CAP = 50

/** 副本标题后缀（与 docState.copyForEditing 同源口径） */
const COPY_TITLE_SUFFIX = '（副本）'

function withCopySuffix(title: string): string {
  return title.includes(COPY_TITLE_SUFFIX) ? title : `${title}${COPY_TITLE_SUFFIX}`
}

/**
 * 内置示例另存副本后的历史身份重映射（C5）：
 * - id / version 统一改写为副本身份——undo/redo 不再回退到内置 id 与旧版本；
 * - 标题补「（副本）」后缀：历史快照在身份转换后属于副本文档，撤销不应把标题退回
 *   内置模板名（docs/42 §4.6 要求「保存后 Ctrl+Z 标题仍含（副本）」）。
 * 返回新的 history 对象，不原地修改既有条目（历史引用存档纪律）。
 */
export function remapHistoryForCopy(
  history: EditorHistory,
  saved: Pick<LevelDoc, 'id' | 'version'>,
): EditorHistory {
  const remap = (doc: LevelDoc): LevelDoc => ({
    ...doc,
    id: saved.id,
    version: saved.version,
    meta: { ...doc.meta, title: withCopySuffix(String(doc.meta.title ?? '')) },
  })
  return { past: history.past.map(remap), future: history.future.map(remap) }
}
