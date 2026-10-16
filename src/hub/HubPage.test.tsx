// @vitest-environment jsdom
import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { HubPage } from './HubPage'
import { db, getResource } from '../library/db'
import goodLevel from '../sample/tutorial-hello.level.json'

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

function buttonByText(container: HTMLElement, text: string): HTMLButtonElement {
  const el = [...container.querySelectorAll('button')].find((b) => b.textContent === text)
  expect(el, `找不到按钮「${text}」`).toBeTruthy()
  return el as HTMLButtonElement
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

const LEVEL_ID = (goodLevel as { id: string }).id

const PUBLIC_ITEM = {
  id: 'hub_A',
  scope: 'public',
  itemKind: 'level',
  rootDocId: LEVEL_ID,
  title: '新手引导 · 交互教程',
  levelCount: 1,
  bytes: 2048,
  authorName: '阿明',
  featured: true,
  downloads: 7,
  publishedAt: 1_700_000_000_000,
}

/** 按路径+方法路由的可变 fetch 桩 */
const routes: Array<{ method: string; path: string; respond: (path: string) => Response }> = []

function stubRoutes(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input).replace(/^https?:\/\/[^/]+/, '')
      const method = (init?.method ?? 'GET').toUpperCase()
      const hit = routes.find((r) => r.method === method && path.split('?')[0] === r.path)
      if (!hit) throw new TypeError(`fetch 桩未覆盖 ${method} ${path}`)
      return hit.respond(path)
    }),
  )
}

beforeEach(async () => {
  routes.length = 0
  await Promise.all([db.resources.clear(), db.progress.clear()])
  stubRoutes()
})

afterEach(() => {
  roots.splice(0).forEach((r) => act(() => r.unmount()))
  containers.splice(0).forEach((c) => c.remove())
  vi.unstubAllGlobals()
})

describe('关卡库页（docs/39 H3）', () => {
  it('公共列表：条目渲染（标题/作者/精选徽章/下载计数）', async () => {
    routes.push({
      method: 'GET',
      path: '/api/hub/items',
      respond: () => new Response(JSON.stringify({ items: [PUBLIC_ITEM], total: 1, limit: 20, offset: 0 })),
    })
    const c = renderEl(<HubPage />)
    await flushUntil(() => c.querySelector('.cloud-row') !== null)
    expect(c.textContent).toContain('新手引导 · 交互教程')
    expect(c.textContent).toContain('阿明')
    expect(c.textContent).toContain('精选')
    expect(c.textContent).toContain('下载 7')
    expect(c.textContent).toContain('已显示 1 / 1')
  })

  it('搜索：输入后按 query 请求', async () => {
    routes.push({
      method: 'GET',
      path: '/api/hub/items',
      respond: () => new Response(JSON.stringify({ items: [], total: 0, limit: 20, offset: 0 })),
    })
    const c = renderEl(<HubPage />)
    await flushUntil(() => c.textContent!.includes('关卡库还是空的'))
    const input = c.querySelector('.library-search') as HTMLInputElement
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!
      setter.call(input, '节奏')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => buttonByText(c, '搜索').click())
    await flushUntil(() => c.textContent!.includes('没有匹配「节奏」'))
    const calls = (vi.mocked(fetch) as unknown as { mock: { calls: Array<[string, RequestInit]> } }).mock.calls
    expect(calls.some(([url]) => String(url).includes('query=%E8%8A%82%E5%A5%8F'))).toBe(true)
  })

  it('下载到本机：详情快照写入本机资源库并显示报告', async () => {
    routes.push(
      {
        method: 'GET',
        path: '/api/hub/items',
        respond: () => new Response(JSON.stringify({ items: [PUBLIC_ITEM], total: 1, limit: 20, offset: 0 })),
      },
      {
        method: 'GET',
        path: '/api/hub/items/hub_A',
        respond: () => new Response(JSON.stringify({ item: PUBLIC_ITEM, docs: [{ id: LEVEL_ID, kind: 'level', payload: goodLevel }] })),
      },
    )
    const c = renderEl(<HubPage />)
    await flushUntil(() => c.querySelector('.cloud-row') !== null)
    await act(async () => buttonByText(c, '下载到本机').click())
    await flushUntil(() => c.textContent!.includes('下载完成'))
    expect(await getResource(LEVEL_ID)).not.toBeUndefined()
  })

  it('Tab：精选走 featured 过滤；官方走 scope=official；群组占位', async () => {
    routes.push({
      method: 'GET',
      path: '/api/hub/items',
      respond: (path) =>
        new Response(
          JSON.stringify({
            items: path.includes('featured=1') ? [PUBLIC_ITEM] : [],
            total: path.includes('featured=1') ? 1 : 0,
            limit: 20,
            offset: 0,
          }),
        ),
    })
    const c = renderEl(<HubPage />)
    await flushUntil(() => c.textContent!.includes('关卡库还是空的'))
    await act(async () => buttonByText(c, '精选').click())
    await flushUntil(() => c.querySelector('.cloud-row') !== null)
    const calls = (vi.mocked(fetch) as unknown as { mock: { calls: Array<[string, RequestInit]> } }).mock.calls
    expect(calls.some(([url]) => String(url).includes('featured=1'))).toBe(true)

    await act(async () => buttonByText(c, '官方关卡').click())
    await flushUntil(() => c.textContent!.includes('官方关卡库还没有内容'))
    expect(calls.some(([url]) => String(url).includes('scope=official'))).toBe(true)

    await act(async () => buttonByText(c, '群组关卡').click())
    await flushUntil(() => c.textContent!.includes('群组关卡库即将上线'))
  })
})
