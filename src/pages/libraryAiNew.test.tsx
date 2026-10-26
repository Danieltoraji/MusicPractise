// @vitest-environment jsdom
import 'fake-indexeddb/auto'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { db } from '../library/db'
import { LibraryPage } from './LibraryPage'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const containers: HTMLElement[] = []
const roots: Root[] = []

function renderEl(ui: React.ReactElement): HTMLElement {
  const container = document.createElement('div')
  document.body.appendChild(container)
  let root!: Root
  act(() => {
    root = createRoot(container)
    root.render(ui)
  })
  containers.push(container)
  roots.push(root)
  return container
}

async function flushUntil(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now()
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('flushUntil 超时')
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10))
    })
  }
}

beforeEach(async () => {
  window.location.hash = ''
  sessionStorage.clear()
  await db.resources.clear()
  await db.progress.clear()
})

afterEach(async () => {
  roots.splice(0).forEach((r) => act(() => r.unmount()))
  containers.splice(0).forEach((c) => c.remove())
  await db.resources.clear()
})

describe('LibraryPage AI 新建关卡（W9 后：进入 v4 模板向导）', () => {
  it('表单展开 → 填描述 → 跳转 #/edit/new（不再预建空白关卡/写 kickoff）', async () => {
    const c = renderEl(<LibraryPage />)
    await flushUntil(() => c.querySelector('.page-actions') !== null)
    const aiBtn = [...c.querySelectorAll('button')].find((b) => b.textContent?.includes('AI 新建关卡'))!
    act(() => aiBtn.click())
    const form = c.querySelector('.ai-new-form') as HTMLElement
    expect(form).toBeTruthy()
    const ta = form.querySelector('textarea') as HTMLTextAreaElement
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')!.set!
      setter.call(ta, '大三和弦听辨练习，10 题')
      ta.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => {
      ;[...form.querySelectorAll('button')].find((b) => b.textContent?.includes('创建并让 AI 开工'))!.click()
    })
    await flushUntil(() => window.location.hash === '#/edit/new')
    // v4 编辑器在 #/edit/new 首帧展示零代码模板向导，由编辑器首存落库
    expect(await db.resources.where('kind').equals('level').count()).toBe(0)
    expect(sessionStorage.getItem('ai-kickoff:new')).toBeNull()
  })

  it('空描述：报错不跳转', async () => {
    const c = renderEl(<LibraryPage />)
    await flushUntil(() => c.querySelector('.page-actions') !== null)
    act(() => [...c.querySelectorAll('button')].find((b) => b.textContent?.includes('AI 新建关卡'))!.click())
    const form = c.querySelector('.ai-new-form') as HTMLElement
    await act(async () => {
      ;[...form.querySelectorAll('button')].find((b) => b.textContent?.includes('创建并让 AI 开工'))!.click()
    })
    expect(c.textContent).toContain('先描述一下想做的关卡')
    expect(window.location.hash).not.toContain('#/edit/')
  })
})
