/**
 * 编辑器撤销/重做历史（docs/40 §12.3 / docs/42 §4.6 C5）。
 * W9 后 v4 编辑器的撤销栈与身份重映射在 `editor/v4/docStateV4.ts`（EditorHistoryV4 /
 * remapHistoryForCopyV4）；本模块只保留两代编辑器共用的栈上限常量。
 */

/** 撤销栈上限（docs/40 §12.3：cap 50） */
export const HISTORY_CAP = 50
