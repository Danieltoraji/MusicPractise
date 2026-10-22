// @vitest-environment jsdom
// keyGuard（docs/40 B5/E11）：编辑器全局快捷键的统一守卫——模态打开短路 +
// 焦点控件放行（删除类额外含 button；撤销类不含 button——点完按钮直接 Ctrl+Z 是高频路径）
import { describe, expect, it } from 'vitest'
import { deleteTargetBlocked, isModalOpen, registerModalOpen, undoTargetBlocked } from './keyGuard'

function el(tag: string, attrs: Record<string, string> = {}): HTMLElement {
  const e = document.createElement(tag)
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v)
  return e
}

describe('keyGuard', () => {
  it('模态注册/注销：计数器开关，注销不会减为负', () => {
    expect(isModalOpen()).toBe(false)
    const off1 = registerModalOpen()
    expect(isModalOpen()).toBe(true)
    const off2 = registerModalOpen()
    off1()
    expect(isModalOpen()).toBe(true)
    off2()
    expect(isModalOpen()).toBe(false)
    off2() // 重复注销兜底
    expect(isModalOpen()).toBe(false)
  })

  it('模态打开期间撤销/删除守卫均短路', () => {
    const off = registerModalOpen()
    expect(undoTargetBlocked(document.body)).toBe(true)
    expect(deleteTargetBlocked(document.body)).toBe(true)
    off()
    expect(undoTargetBlocked(document.body)).toBe(false)
  })

  it('撤销守卫：input/textarea/select/contenteditable 放行，button 聚焦仍允许撤销', () => {
    expect(undoTargetBlocked(el('input'))).toBe(true)
    expect(undoTargetBlocked(el('textarea'))).toBe(true)
    expect(undoTargetBlocked(el('select'))).toBe(true)
    // [contenteditable] 属性选择器兜底（jsdom 不实现 isContentEditable，浏览器内双保险）
    expect(undoTargetBlocked(el('div', { contenteditable: 'true' }))).toBe(true)
    // button 聚焦仍允许撤销（点完工具栏按钮直接 Ctrl+Z 是高频路径）
    expect(undoTargetBlocked(el('button'))).toBe(false)
    expect(undoTargetBlocked(document.body)).toBe(false)
    expect(undoTargetBlocked(null)).toBe(false)
  })

  it('删除守卫：交互控件（含 button）一律放行给控件自身——SELECT 聚焦按 Delete 误删的回归', () => {
    expect(deleteTargetBlocked(el('input'))).toBe(true)
    expect(deleteTargetBlocked(el('select'))).toBe(true) // docs/40 B5 复现第 6 条
    expect(deleteTargetBlocked(el('button'))).toBe(true)
    expect(deleteTargetBlocked(el('div', { contenteditable: 'true' }))).toBe(true)
    // 祖先链命中：span 嵌在 button 内也算按钮聚焦
    const btn = el('button')
    const span = el('span')
    btn.appendChild(span)
    expect(deleteTargetBlocked(span)).toBe(true)
    expect(deleteTargetBlocked(document.body)).toBe(false)
    expect(deleteTargetBlocked(null)).toBe(false)
  })
})
