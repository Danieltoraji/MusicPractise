/**
 * 编辑器全局快捷键守卫（docs/40 B5/E11）。
 * 编辑器页有三处 window 级 keydown（EditorPage 撤销/重做、EditorCanvas 画布删除、
 * GraphEditor 节点删除）——统一从这里取守卫，口径不再各自漂移：
 * - 任一模态层（JSON 单元格/五线谱/列表弹窗）打开期间一律短路：弹窗草稿提交前，
 *   文档不能被快捷键 Undo/Delete 先行改写（此前 Ctrl+Z 穿透弹窗、SELECT 聚焦按 Delete 误删）；
 * - 焦点落在可编辑/可交互控件上时放行给控件自身。撤销类不含 button（点完工具栏
 *   按钮直接 Ctrl+Z 是高频路径）；删除类含 button（误删破坏性更大）。
 */

let openModals = 0

/** 弹窗组件挂载时注册：`useEffect(registerModalOpen, [])`；返回清理函数自动注销 */
export function registerModalOpen(): () => void {
  openModals += 1
  return () => {
    openModals = Math.max(0, openModals - 1)
  }
}

export function isModalOpen(): boolean {
  return openModals > 0
}

/** 事件 target → Element（window/document 级派发时 target 不是元素，直接放行判断） */
function asElement(target: EventTarget | null): HTMLElement | null {
  return target instanceof Element ? (target as HTMLElement) : null
}

/** 撤销/重做类快捷键是否应被忽略（模态打开；或焦点在文本输入/下拉/可编辑区内） */
export function undoTargetBlocked(target: EventTarget | null): boolean {
  if (isModalOpen()) return true
  const el = asElement(target)
  return !!el?.closest('input, textarea, select, [contenteditable]') || !!el?.isContentEditable
}

/** 删除类（Delete/Backspace，破坏性）是否应被忽略（模态打开；或焦点在交互控件内） */
export function deleteTargetBlocked(target: EventTarget | null): boolean {
  if (isModalOpen()) return true
  const el = asElement(target)
  return !!el?.closest('input, textarea, select, button, [contenteditable]') || !!el?.isContentEditable
}
