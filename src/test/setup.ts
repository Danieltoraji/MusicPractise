/**
 * Vitest 全局 setup（docs/40 H6 基座）：对所有测试文件生效。
 * - React ACT 环境标记：jsdom 测试文件此前逐文件手写，此处兜底（node 环境测试无副作用）
 * - 指针捕获兜底：jsdom 无 setPointerCapture（编辑器画布/节点图拖拽测试依赖）
 * - Canvas 2D 替身（docs/44 R15）：jsdom 无原生 canvas 导致 VexFlow 文本度量输出大量
 *   not-implemented；替身只保证 API 可执行，不断言像素结果
 * 既有测试文件的重复样板不强迁——新测试可直接依赖这里的全局状态。
 */
import { installCanvasStub } from './canvasStub'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

if (typeof Element !== 'undefined' && !Element.prototype.setPointerCapture) {
  Element.prototype.setPointerCapture = (): void => {}
}
if (typeof Element !== 'undefined' && !Element.prototype.releasePointerCapture) {
  Element.prototype.releasePointerCapture = (): void => {}
}

// jsdom 的滚动 API 未实现会打印 not-implemented（React Flow/页面滚动/滚动到可视区调用触发）；
// 测试不做真实滚动断言，统一 no-op（需要滚动的用例自行 stub/断言）。
if (typeof window !== 'undefined' && typeof window.scrollTo === 'function') {
  window.scrollTo = ((): void => {}) as typeof window.scrollTo
}
if (typeof HTMLElement !== 'undefined') {
  HTMLElement.prototype.scrollTo = ((): void => {}) as typeof HTMLElement.prototype.scrollTo
  HTMLElement.prototype.scrollIntoView = ((): void => {}) as typeof HTMLElement.prototype.scrollIntoView
}

// jsdom 环境（HTMLCanvasElement 存在）安装；node 环境自动跳过
installCanvasStub()
