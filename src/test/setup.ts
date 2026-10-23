/**
 * Vitest 全局 setup（docs/40 H6 基座）：对所有测试文件生效。
 * - React ACT 环境标记：jsdom 测试文件此前逐文件手写，此处兜底（node 环境测试无副作用）
 * - 指针捕获兜底：jsdom 无 setPointerCapture（编辑器画布/节点图拖拽测试依赖）
 * 既有测试文件的重复样板不强迁——新测试可直接依赖这里的全局状态。
 */
;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

if (typeof Element !== 'undefined' && !Element.prototype.setPointerCapture) {
  Element.prototype.setPointerCapture = (): void => {}
}
if (typeof Element !== 'undefined' && !Element.prototype.releasePointerCapture) {
  Element.prototype.releasePointerCapture = (): void => {}
}
