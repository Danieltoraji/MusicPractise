// @vitest-environment jsdom
// 皮肤中心（docs/35 步骤3）：三张预设卡 + 点击换肤 + 背景图自定义区
import 'fake-indexeddb/auto'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SKIN_CATALOG } from './prefs'
import { SkinCenterPage } from './SkinCenterPage'
import { getSkinSnapshot, updatePrefs } from './store'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root | null = null
let container: HTMLElement | null = null

beforeEach(() => {
  localStorage.clear()
  vi.stubGlobal('URL', {
    ...URL,
    createObjectURL: vi.fn(() => 'blob:mock'),
    revokeObjectURL: vi.fn(),
  })
})

afterEach(() => {
  act(() => root?.unmount())
  container?.remove()
  vi.unstubAllGlobals()
})

async function renderSkinPage(): Promise<HTMLElement> {
  container = document.createElement('div')
  document.body.appendChild(container)
  await act(async () => {
    root = createRoot(container!)
    root!.render(<SkinCenterPage />)
  })
  return container
}

describe('SkinCenterPage', () => {
  it('渲染全部预设皮肤卡与三大自定义区', async () => {
    const c = await renderSkinPage()
    const names = [...c.querySelectorAll('.skin-card-name')].map((el) => el.textContent)
    for (const s of SKIN_CATALOG) expect(names.join()).toContain(s.name)
    const headings = [...c.querySelectorAll('h2')].map((el) => el.textContent)
    expect(headings).toEqual(['预设皮肤', '背景图', '水印图', '字体'])
    expect(c.textContent).toContain('不随账户同步')
  })

  it('点击预设卡即换肤：data-skin 与持久化同步', async () => {
    const c = await renderSkinPage()
    const target = SKIN_CATALOG.find((s) => s.id !== getSkinSnapshot().skinId)!
    const card = [...c.querySelectorAll('.skin-card')].find((el) => el.textContent!.includes(target.name)) as HTMLButtonElement
    await act(async () => {
      card.click()
      await new Promise((r) => setTimeout(r, 30))
    })
    expect(document.documentElement.dataset.skin).toBe(target.id)
    expect(JSON.parse(localStorage.getItem('skin.prefs.v1')!).skinId).toBe(target.id)
    expect(c.querySelector('.skin-card.active')!.textContent).toContain(target.name)
  })

  it('背景引用失效时宽松降级：无缩略图，但保留更换/移除操作', async () => {
    act(() => {
      updatePrefs({ bg: { id: 'skin_FAKE', opacity: 1, scope: 'all' } })
    })
    const c = await renderSkinPage()
    // 资产解析失败（假 id）→ 不渲染缩略图（层自动隐藏），但引用仍在可移除
    for (let i = 0; i < 15 && getSkinSnapshot().rt.bgUrl; i++) await new Promise((r) => setTimeout(r, 20))
    expect(c.querySelector('.skin-thumb')).toBeNull()
    expect(c.querySelector('.skin-upload')!.textContent).toContain('更换背景图')
    const removeBtn = [...c.querySelectorAll('button')].find((el) => el.textContent === '移除')
    expect(removeBtn).toBeDefined()
    await act(async () => {
      removeBtn!.click()
      await new Promise((r) => setTimeout(r, 30))
    })
    expect(getSkinSnapshot().bg.id).toBeNull()
    expect(c.querySelector('.skin-upload')!.textContent).toContain('上传背景图')
  })

  it('水印区提供位置/渐隐控件', async () => {
    const c = await renderSkinPage()
    expect(c.textContent).toContain('显示位置')
    expect(c.textContent).toContain('四周渐隐')
    const selects = [...c.querySelectorAll('.skin-panel select')]
    expect(selects.some((el) => [...(el as HTMLSelectElement).options].some((o) => o.textContent === '平铺'))).toBe(true)
  })
})
