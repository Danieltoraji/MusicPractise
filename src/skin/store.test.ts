// @vitest-environment jsdom
// 皮肤状态存储（docs/35 步骤2b）：资产回路（保存→解析→清除）与 updatePrefs 落盘
import 'fake-indexeddb/auto'
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { deleteSkinImage, getSkinImage, saveSkinImage } from './assets'
import { getSkinSnapshot, subscribeSkin, updatePrefs } from './store'

let unsub: (() => void) | null = null

beforeEach(() => {
  localStorage.clear()
  // jsdom 未实现 objectURL：打桩（验证 id→URL 解析链路即可）
  vi.stubGlobal('URL', {
    ...URL,
    createObjectURL: vi.fn(() => `blob:mock-${Math.random().toString(36).slice(2)}`),
    revokeObjectURL: vi.fn(),
  })
})

afterEach(() => {
  unsub?.()
  unsub = null
  vi.unstubAllGlobals()
})

describe('skin store', () => {
  it('updatePrefs：归一化落盘、通知订阅者、快照可读', () => {
    let notified = 0
    unsub = subscribeSkin(() => notified++)
    act(() => {
      updatePrefs({ skinId: 'violet', bg: { id: null, opacity: 0.7, scope: 'home' } })
    })
    expect(notified).toBeGreaterThan(0)
    expect(getSkinSnapshot().skinId).toBe('violet')
    expect(getSkinSnapshot().bg).toMatchObject({ opacity: 0.7, scope: 'home' })
    expect(JSON.parse(localStorage.getItem('skin.prefs.v1')!).skinId).toBe('violet')
  })

  it('背景图资产回路：入库→引用→运行时 URL→清除后引用清空', async () => {
    const data = new TextEncoder().encode('fake-png-bytes').buffer as ArrayBuffer
    const id = await saveSkinImage(data, 'image/png')
    expect((await getSkinImage(id))?.type).toBe('image/png')

    act(() => {
      updatePrefs({ bg: { id, opacity: 1, scope: 'all' } })
    })
    // applySkin 异步解析：轮询等 rt.bgUrl 就绪
    for (let i = 0; i < 20 && !getSkinSnapshot().rt.bgUrl; i++) {
      await new Promise((r) => setTimeout(r, 20))
    }
    expect(getSkinSnapshot().rt.bgUrl).toMatch(/^blob:mock-/)
    expect(document.documentElement.style.getPropertyValue('--user-bg-image')).toContain('blob:mock-')

    await act(async () => {
      await import('./store').then((m) => m.clearBackground())
    })
    expect(getSkinSnapshot().bg.id).toBeNull()
    expect(await getSkinImage(id)).toBeUndefined()
    expect(getSkinSnapshot().rt.bgUrl).toBeUndefined()
  })

  it('水印资产引用与 CSS 变量（位置/渐隐）', async () => {
    const data = new TextEncoder().encode('fake-wm').buffer as ArrayBuffer
    const id = await saveSkinImage(data, 'image/png')
    act(() => {
      updatePrefs({ wm: { id, opacity: 0.4, pos: 'tile', fade: 40 } })
    })
    for (let i = 0; i < 20 && !getSkinSnapshot().rt.wmUrl; i++) {
      await new Promise((r) => setTimeout(r, 20))
    }
    expect(document.documentElement.style.getPropertyValue('--wm-repeat')).toBe('repeat')
    expect(document.documentElement.style.getPropertyValue('--wm-opacity')).toBe('0.4')
    expect(document.documentElement.style.getPropertyValue('--wm-mask')).toContain('black 60%')
    await act(async () => {
      await import('./store').then((m) => m.clearWatermark())
    })
    await deleteSkinImage(id).catch(() => undefined)
  })
})
