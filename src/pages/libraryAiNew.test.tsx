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

describe('LibraryPage AI 新建关卡（批次4）', () => {
  it('表单展开 → 填描述 → 创建空白关卡 + 写入 kickoff + 跳编辑器', async () => {
    const c = renderEl(<LibraryPage />)
    await flushUntil(() => c.querySelector('.library-actions') !== null)
    // 空库：先等 ensureSeeded 把内置关卡入库（App 层逻辑；这里直接验证表单流转，不强依赖种子）
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
    await flushUntil(() => window.location.hash.startsWith('#/edit/'))
    const newId = window.location.hash.slice('#/edit/'.length)
    expect(newId).toMatch(/^res_/)
    const kickoff = JSON.parse(sessionStorage.getItem('ai-kickoff')!)
    expect(kickoff).toMatchObject({ docId: newId, prompt: '大三和弦听辨练习，10 题' })
    // 空关卡已入库
    const rec = await db.resources.get(newId)
    expect(rec?.kind).toBe('level')
  })

  it('空描述：报错不跳转', async () => {
    const c = renderEl(<LibraryPage />)
    await flushUntil(() => c.querySelector('.library-actions') !== null)
    act(() => [...c.querySelectorAll('button')].find((b) => b.textContent?.includes('AI 新建关卡'))!.click())
    const form = c.querySelector('.ai-new-form') as HTMLElement
    await act(async () => {
      ;[...form.querySelectorAll('button')].find((b) => b.textContent?.includes('创建并让 AI 开工'))!.click()
    })
    expect(c.textContent).toContain('先描述一下想做的关卡')
    expect(window.location.hash).not.toContain('#/edit/')
  })
})
