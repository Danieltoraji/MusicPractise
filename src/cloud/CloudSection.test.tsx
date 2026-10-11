// @vitest-environment jsdom
import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { CloudSection } from './CloudSection'
import { probeAccount, resetAccountForTests } from '../account/store'
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

async function flushUntil(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now()
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('flushUntil 超时')
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10))
    })
  }
}

const USER = { id: 'usr_A', nickname: '阿明', role: 'user' }
const LEVEL_ID = (goodLevel as { id: string }).id
const SLOT = {
  id: 'cld_TEST000000000000000000001',
  levelId: LEVEL_ID,
  title: '新手引导',
  bytes: 2048,
  schemaVersion: 3,
  createdAt: 1_700_000_000_000,
  updatedAt: 1_700_000_000_000,
}

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
  await Promise.all([db.resources.clear(), db.progress.clear()])
  stubRoutes()
})

afterEach(() => {
  roots.splice(0).forEach((r) => act(() => r.unmount()))
  containers.splice(0).forEach((c) => c.remove())
  vi.unstubAllGlobals()
})

/** 探测为已登录后渲染 */
async function renderSignedIn(): Promise<HTMLElement> {
  routes.push(
    { method: 'GET', path: '/api/health', respond: () => new Response(JSON.stringify({ ok: true })) },
    { method: 'GET', path: '/api/auth/me', respond: () => new Response(JSON.stringify({ user: USER })) },
  )
  await act(async () => {
    await probeAccount()
  })
  return renderEl(<CloudSection />)
}

describe('设置页云盘区（批次 B2）', () => {
  it('未登录：显示引导提示，不发云盘请求', async () => {
    routes.push(
      { method: 'GET', path: '/api/health', respond: () => new Response(JSON.stringify({ ok: true })) },
      { method: 'GET', path: '/api/auth/me', respond: () => new Response(JSON.stringify({ user: null })) },
    )
    await act(async () => {
      await probeAccount()
    })
    const c = renderEl(<CloudSection />)
    expect(c.textContent).toContain('登录后可使用云盘')
    expect(c.querySelector('.cloud-list')).toBeNull()
  })

  it('后端不可用：不渲染（账户区已表达降级）', async () => {
    routes.push({ method: 'GET', path: '/api/health', respond: () => { throw new TypeError('fetch failed') } })
    await act(async () => {
      await probeAccount()
    })
    const c = renderEl(<CloudSection />)
    expect(c.textContent).toBe('')
  })

  it('已登录：拉取槽位列表并显示已用/上限', async () => {
    routes.push({
      method: 'GET',
      path: '/api/cloud/levels',
      respond: () => new Response(JSON.stringify({ levels: [SLOT], used: 1, limit: 10 })),
    })
    const c = await renderSignedIn()
    await flushUntil(() => c.querySelector('.cloud-row') !== null)
    expect(c.textContent).toContain('已用')
    expect(c.textContent).toContain('新手引导')
    expect(c.textContent).toContain('2.0 KB')
    expect(c.querySelectorAll('.cloud-row')).toHaveLength(1)
  })

  it('空槽位：显示引导文案', async () => {
    routes.push({
      method: 'GET',
      path: '/api/cloud/levels',
      respond: () => new Response(JSON.stringify({ levels: [], used: 0, limit: 10 })),
    })
    const c = await renderSignedIn()
    await flushUntil(() => c.textContent!.includes('还没有上传过'))
    expect(c.textContent).toContain('资源库')
  })

  it('下载：写入本地资源库并显示导入报告', async () => {
    routes.push(
      {
        method: 'GET',
        path: '/api/cloud/levels',
        respond: () => new Response(JSON.stringify({ levels: [SLOT], used: 1, limit: 10 })),
      },
      {
        method: 'GET',
        path: `/api/cloud/levels/${SLOT.id}`,
        respond: () => new Response(JSON.stringify({ level: { ...SLOT, payload: goodLevel } })),
      },
    )
    const c = await renderSignedIn()
    await flushUntil(() => c.querySelector('.cloud-row') !== null)
    await act(async () => buttonByText(c, '下载到本机').click())
    await flushUntil(() => c.textContent!.includes('下载完成'))
    const rec = await getResource(LEVEL_ID)
    expect(rec).not.toBeUndefined()
    expect(rec!.kind).toBe('level')
    expect(c.textContent).toContain('新增 1')
  })

  it('删除：确认后调 DELETE 并刷新列表', async () => {
    let deleted = 0
    routes.push(
      {
        method: 'GET',
        path: '/api/cloud/levels',
        respond: () => new Response(JSON.stringify({ levels: deleted === 0 ? [SLOT] : [], used: deleted === 0 ? 1 : 0, limit: 10 })),
      },
      {
        method: 'DELETE',
        path: `/api/cloud/levels/${SLOT.id}`,
        respond: () => {
          deleted++
          return new Response(JSON.stringify({ ok: true }))
        },
      },
    )
    const c = await renderSignedIn()
    await flushUntil(() => c.querySelector('.cloud-row') !== null)
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    await act(async () => buttonByText(c, '删除').click())
    await flushUntil(() => c.textContent!.includes('已删除'))
    expect(deleted).toBe(1)
    await flushUntil(() => c.textContent!.includes('还没有上传过'))
  })
})
