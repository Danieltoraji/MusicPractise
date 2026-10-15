// @vitest-environment jsdom
import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { CloudSection } from './CloudSection'
import { probeAccount, resetAccountForTests } from '../account/store'

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

const USER = { id: 'usr_A', nickname: '阿明', role: 'user' }

/** 按路径+方法路由的可变 fetch 桩 */
const routes: Array<{ method: string; path: string; respond: () => Response }> = []

function stubRoutes(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input).replace(/^https?:\/\/[^/]+/, '')
      const method = (init?.method ?? 'GET').toUpperCase()
      const hit = routes.find((r) => r.method === method && r.path === path)
      if (!hit) throw new TypeError(`fetch 桩未覆盖 ${method} ${path}`)
      return hit.respond()
    }),
  )
}

beforeEach(async () => {
  localStorage.clear()
  resetAccountForTests()
  routes.length = 0
  stubRoutes()
})

afterEach(() => {
  roots.splice(0).forEach((r) => act(() => r.unmount()))
  containers.splice(0).forEach((c) => c.remove())
  vi.unstubAllGlobals()
})

describe('设置页云盘区（摘要，docs/39 H2）', () => {
  it('未登录：显示引导提示，不渲染用量', async () => {
    routes.push(
      { method: 'GET', path: '/api/health', respond: () => new Response(JSON.stringify({ ok: true })) },
      { method: 'GET', path: '/api/auth/me', respond: () => new Response(JSON.stringify({ user: null })) },
    )
    await act(async () => {
      await probeAccount()
    })
    const c = renderEl(<CloudSection />)
    expect(c.textContent).toContain('登录后可使用云盘')
    expect(c.querySelector('.cloud-box')).toBeNull()
  })

  it('后端不可用：不渲染（账户区已表达降级）', async () => {
    routes.push({ method: 'GET', path: '/api/health', respond: () => { throw new TypeError('fetch failed') } })
    await act(async () => {
      await probeAccount()
    })
    const c = renderEl(<CloudSection />)
    expect(c.textContent).toBe('')
  })

  it('已登录：显示合并口径用量与「前往我的云盘」入口', async () => {
    routes.push(
      { method: 'GET', path: '/api/health', respond: () => new Response(JSON.stringify({ ok: true })) },
      { method: 'GET', path: '/api/auth/me', respond: () => new Response(JSON.stringify({ user: USER })) },
      { method: 'GET', path: '/api/cloud/levels', respond: () => new Response(JSON.stringify({ levels: [], folders: [], used: 3, limit: 10 })) },
    )
    await act(async () => {
      await probeAccount()
    })
    const c = renderEl(<CloudSection />)
    await flushUntil(() => (c.querySelector('.cloud-head b')?.textContent ?? '') === '3')
    expect(c.textContent).toContain('3')
    expect(c.textContent).toContain('前往我的云盘')
    const link = c.querySelector('a[href="#/cloud"]')
    expect(link).not.toBeNull()
  })
})
