// @vitest-environment jsdom
// 文档页（docs/35 步骤0）：目录渲染、子路由定位、搜索过滤、翻页器
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DOC_FLAT } from './docsContent'
import { DocsPage } from './DocsPage'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root | null = null
let container: HTMLElement | null = null

async function renderDocs(subId = ''): Promise<HTMLElement> {
  container = document.createElement('div')
  document.body.appendChild(container)
  await act(async () => {
    root = createRoot(container!)
    root!.render(<DocsPage subId={subId} />)
  })
  return container
}

describe('DocsPage', () => {
  beforeEach(() => {
    root = null
    container = null
  })
  afterEach(() => {
    act(() => root?.unmount())
    container?.remove()
  })

  it('默认渲染第一篇（平台简介）与全部分组目录', async () => {
    const c = await renderDocs()
    expect(c.querySelector('.docs-article h1')!.textContent).toBe('平台简介')
    const links = [...c.querySelectorAll('.docs-link')]
    expect(links.length).toBe(DOC_FLAT.length)
    expect(links[0].textContent).toBe('平台简介')
    // 平级入口语义：分组包含「开始」「创作」「参考」等
    const groups = [...c.querySelectorAll('.docs-group-title')].map((el) => el.textContent)
    expect(groups).toContain('开始')
    expect(groups).toContain('创作')
    expect(groups).toContain('参考')
  })

  it('子路径定位：#/docs/expr 渲染表达式参考且激活态正确', async () => {
    const c = await renderDocs('expr')
    expect(c.querySelector('.docs-article h1')!.textContent).toBe('表达式参考')
    expect(c.querySelector('.docs-link.active')!.getAttribute('href')).toBe('#/docs/expr')
  })

  it('搜索过滤目录并显示空态', async () => {
    const c = await renderDocs()
    const input = c.querySelector('.docs-search') as HTMLInputElement
    // React 受控输入：必须走原生 value setter 绕过 value tracker，onChange 才会触发
    const setNative = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    await act(async () => {
      setNative.call(input, '表达式')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    const links = [...c.querySelectorAll('.docs-link')].map((el) => el.textContent)
    expect(links).toEqual(['表达式参考'])
    await act(async () => {
      setNative.call(input, '不存在的词条xyz')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    expect(c.querySelector('.docs-nav-empty')!.textContent).toContain('没有匹配')
  })

  it('翻页器：首篇无上一篇、末篇无下一篇', async () => {
    const c = await renderDocs('about')
    const dirs = [...c.querySelectorAll('.docs-pager-dir')].map((el) => el.textContent)
    expect(dirs).toEqual(['下一篇 →'])
    const last = DOC_FLAT[DOC_FLAT.length - 1].id
    const c2 = await renderDocs(last)
    const dirs2 = [...c2.querySelectorAll('.docs-pager-dir')].map((el) => el.textContent)
    expect(dirs2).toEqual(['← 上一篇'])
  })
})
