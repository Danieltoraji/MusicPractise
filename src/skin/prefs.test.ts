// @vitest-environment jsdom
// 皮肤偏好（docs/35 步骤2b）：归一化、持久化回路、CSS 变量应用
import { beforeEach, describe, expect, it } from 'vitest'
import {
  DEFAULT_PREFS,
  applyPrefsToDom,
  loadPrefs,
  normalizePrefs,
  savePrefs,
  watermarkMask,
} from './prefs'

describe('normalizePrefs', () => {
  it('脏输入收敛为默认值；越界数值钳制到界内', () => {
    const p = normalizePrefs({
      skinId: ' hacked ',
      bg: { id: 42, opacity: 'x', scope: 'everywhere' },
      wm: { id: '', opacity: 99, pos: 'diagonal', fade: -5 },
      font: { ui: '   ', display: 123 },
    })
    expect(p.skinId).toBe('dream')
    expect(p.bg).toEqual({ id: null, opacity: 1, scope: 'all' })
    expect(p.wm).toEqual({ id: null, opacity: 1, pos: 'br', fade: 0 })
    expect(p.font).toEqual({ ui: null, display: null })
  })

  it('合法输入保留；数值钳制到界内', () => {
    const p = normalizePrefs({
      skinId: 'liuhua',
      bg: { id: 'skin_A', opacity: 1.7, scope: 'home' },
      wm: { id: 'skin_B', opacity: 0.3, pos: 'tile', fade: 240 },
      font: { ui: '黑体', display: '汉仪文黑85W' },
    })
    expect(p.skinId).toBe('liuhua')
    expect(p.bg).toEqual({ id: 'skin_A', opacity: 1, scope: 'home' })
    expect(p.wm).toEqual({ id: 'skin_B', opacity: 0.3, pos: 'tile', fade: 100 })
    expect(p.font).toEqual({ ui: '黑体', display: '汉仪文黑85W' })
  })
})

describe('loadPrefs / savePrefs', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('空存储给默认；保存后读取回路一致', () => {
    expect(loadPrefs()).toEqual(DEFAULT_PREFS)
    const prefs = normalizePrefs({ skinId: 'violet', bg: { id: 'x1', opacity: 0.6, scope: 'home' } })
    savePrefs(prefs)
    expect(loadPrefs()).toEqual(prefs)
  })

  it('存储内容损坏时回退默认', () => {
    localStorage.setItem('skin.prefs.v1', '{not json')
    expect(loadPrefs()).toEqual(DEFAULT_PREFS)
  })
})

describe('applyPrefsToDom', () => {
  it('设置 data-skin 与 --user-*/--wm-* 变量；无资产时清除变量', () => {
    applyPrefsToDom(normalizePrefs({ skinId: 'violet' }), { bgUrl: 'blob:x', wmUrl: 'blob:y' })
    expect(document.documentElement.dataset.skin).toBe('violet')
    expect(document.documentElement.style.getPropertyValue('--user-bg-image')).toContain('blob:x')
    expect(document.documentElement.style.getPropertyValue('--wm-repeat')).toBe('no-repeat')

    applyPrefsToDom(normalizePrefs({ skinId: 'dream' }), {})
    expect(document.documentElement.dataset.skin).toBe('dream')
    expect(document.documentElement.style.getPropertyValue('--user-bg-image')).toBe('')
    expect(document.documentElement.style.getPropertyValue('--wm-image')).toBe('')
  })

  it('字体覆盖拼兜底栈；空槽位清除', () => {
    applyPrefsToDom(normalizePrefs({ font: { ui: '黑体', display: '汉仪文黑85W' } }), {})
    expect(document.documentElement.style.getPropertyValue('--user-font-ui')).toBe(
      `'黑体', 'Segoe UI', 'Microsoft YaHei', system-ui, sans-serif`,
    )
    expect(document.documentElement.style.getPropertyValue('--user-font-display')).toContain('汉仪文黑85W')
    applyPrefsToDom(normalizePrefs({}), {})
    expect(document.documentElement.style.getPropertyValue('--user-font-ui')).toBe('')
  })
})

describe('watermarkMask', () => {
  it('渐隐 0 = 无蒙版；渐隐越大实心区越小', () => {
    expect(watermarkMask(0)).toBe('none')
    expect(watermarkMask(30)).toContain('black 70%')
    expect(watermarkMask(80)).toContain('black 20%')
  })
})
