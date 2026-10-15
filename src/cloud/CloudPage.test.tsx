// @vitest-environment jsdom
import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { CloudPage } from './CloudPage'
import { probeAccount, resetAccountForTests } from '../account/store'
import { db, getResource, putResource } from '../library/db'
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

async function flushUntil(predicate: () => boolean, timeoutMs = 4000): Promise<void> {
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
const FOLDER = {
  id: 'cldf_TEST00000000000000000001',
  folderId: 'res_01J9B000000000000000000000',
  title: '入门系列',
  levelCount: 2,
  bytes: 4096,
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

async function probeSignedIn(): Promise<void> {
  routes.push(
    { method: 'GET', path: '/api/health', respond: () => new Response(JSON.stringify({ ok: true })) },
    { method: 'GET', path: '/api/auth/me', respond: () => new Response(JSON.stringify({ user: USER })) },
  )
  await act(async () => {
    await probeAccount()
  })
}

/** 本机库种子：入门系列（res_01J9B0…）▸ 专题（res_01J9B1…）▸ 1 关卡（goodLevel） */
async function seedLocalSeries(): Promise<void> {
  const topicId = 'res_01J9B100000000000000000000'
  await putResource({
    schemaVersion: 1,
    kind: 'series',
    id: FOLDER.folderId,
    version: '1.0.0',
    meta: { title: '入门系列' },
    refs: [],
    content: { topicIds: [topicId] },
  } as never)
  await putResource({
    schemaVersion: 1,
    kind: 'topic',
    id: topicId,
    version: '1.0.0',
    meta: { title: '听音基础' },
    refs: [],
    content: { levelIds: [LEVEL_ID], brief: '' },
  } as never)
  await putResource(goodLevel as never)
}

describe('我的云盘页（docs/39 H2）', () => {
  it('未登录：显示引导与设置页链接', async () => {
    routes.push(
      { method: 'GET', path: '/api/health', respond: () => new Response(JSON.stringify({ ok: true })) },
      { method: 'GET', path: '/api/auth/me', respond: () => new Response(JSON.stringify({ user: null })) },
    )
    await act(async () => {
      await probeAccount()
    })
    const c = renderEl(<CloudPage />)
    await flushUntil(() => c.textContent!.includes('云盘需要登录'))
    expect(c.querySelector('a[href="#/settings"]')).not.toBeNull()
  })

  it('后端不可用：显示降级提示', async () => {
    routes.push({ method: 'GET', path: '/api/health', respond: () => { throw new TypeError('fetch failed') } })
    await act(async () => {
      await probeAccount()
    })
    const c = renderEl(<CloudPage />)
    await flushUntil(() => c.textContent!.includes('后端不可用'))
  })

  it('列表：文件夹与关卡分区渲染，合并口径已用', async () => {
    await probeSignedIn()
    routes.push({
      method: 'GET',
      path: '/api/cloud/levels',
      respond: () => new Response(JSON.stringify({ levels: [SLOT], folders: [FOLDER], used: 3, limit: 10 })),
    })
    const c = renderEl(<CloudPage />)
    await flushUntil(() => c.querySelector('.cloud-row') !== null)
    expect(c.textContent).toContain('已用')
    expect(c.textContent).toContain('3')
    expect(c.textContent).toContain('系列文件夹')
    expect(c.textContent).toContain('入门系列')
    expect(c.textContent).toContain('2 个关卡')
    expect(c.textContent).toContain('新手引导')
    expect(c.querySelectorAll('.cloud-row')).toHaveLength(2)
  })

  it('上传系列：选择器点击本机系列 → POST 文件夹包 → 消息反馈并刷新', async () => {
    await seedLocalSeries()
    await probeSignedIn()
    routes.push(
      {
        method: 'GET',
        path: '/api/cloud/levels',
        respond: () => new Response(JSON.stringify({ levels: [], folders: [], used: 0, limit: 10 })),
      },
      {
        method: 'POST',
        path: '/api/cloud/folders',
        respond: () => new Response(JSON.stringify({ folder: { ...FOLDER, levelCount: 1 }, used: 1 }), { status: 201 }),
      },
    )

    const c = renderEl(<CloudPage />)
    await flushUntil(() => c.textContent!.includes('已用'))
    await act(async () => buttonByText(c, '☁ 上传').click())
    await flushUntil(() => c.querySelector('.tjson-backdrop') !== null)
    const entry = [...c.querySelectorAll('.lib-move-target')].find((b) => b.textContent?.includes('入门系列')) as HTMLButtonElement
    expect(entry.disabled).toBe(false)
    expect(entry.textContent).toContain('1 个关卡')

    await act(async () => entry.click())
    await flushUntil(() => c.textContent!.includes('已上传云盘'))
    const calls = (vi.mocked(fetch) as unknown as { mock: { calls: Array<[string, RequestInit]> } }).mock.calls
    const post = calls.find(([, init]) => init?.method === 'POST')!
    expect(post[0]).toBe('/api/cloud/folders')
    const body = JSON.parse(post[1].body as string) as { folderId: string; title: string; docs: { id: string; kind: string }[] }
    expect(body.folderId).toBe(FOLDER.folderId)
    expect(body.title).toBe('入门系列')
    expect(body.docs).toHaveLength(3) // 系列 + 专题 + 关卡
  })

  it('下载文件夹：docs 写入本机库并显示导入报告', async () => {
    await probeSignedIn()
    routes.push(
      {
        method: 'GET',
        path: '/api/cloud/levels',
        respond: () => new Response(JSON.stringify({ levels: [], folders: [FOLDER], used: 2, limit: 10 })),
      },
      {
        method: 'GET',
        path: `/api/cloud/folders/${FOLDER.id}`,
        respond: () =>
          new Response(
            JSON.stringify({
              folder: FOLDER,
              docs: [
                {
                  id: FOLDER.folderId,
                  kind: 'series',
                  payload: { schemaVersion: 1, kind: 'series', id: FOLDER.folderId, version: '1.0.0', meta: { title: '入门系列' }, refs: [], content: { topicIds: ['res_01J9B100000000000000000000'] } },
                },
                {
                  id: 'res_01J9B100000000000000000000',
                  kind: 'topic',
                  payload: { schemaVersion: 1, kind: 'topic', id: 'res_01J9B100000000000000000000', version: '1.0.0', meta: { title: '听音基础' }, refs: [], content: { levelIds: [LEVEL_ID], brief: '' } },
                },
                { id: LEVEL_ID, kind: 'level', payload: goodLevel },
              ],
            }),
          ),
      },
    )
    const c = renderEl(<CloudPage />)
    await flushUntil(() => c.querySelector('.cloud-row') !== null)
    await act(async () => buttonByText(c, '下载到本机').click())
    await flushUntil(() => c.textContent!.includes('下载完成'))
    expect(await getResource(FOLDER.folderId)).not.toBeUndefined()
    expect(await getResource(LEVEL_ID)).not.toBeUndefined()
  })

  it('删除文件夹：确认后 DELETE 并提示释放槽位', async () => {
    await probeSignedIn()
    let deleted = 0
    routes.push(
      {
        method: 'GET',
        path: '/api/cloud/levels',
        respond: () => new Response(JSON.stringify({ levels: [], folders: deleted === 0 ? [FOLDER] : [], used: deleted === 0 ? 2 : 0, limit: 10 })),
      },
      {
        method: 'DELETE',
        path: `/api/cloud/folders/${FOLDER.id}`,
        respond: () => {
          deleted++
          return new Response(JSON.stringify({ ok: true }))
        },
      },
    )
    const c = renderEl(<CloudPage />)
    await flushUntil(() => c.querySelector('.cloud-row') !== null)
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    await act(async () => buttonByText(c, '删除').click())
    await flushUntil(() => c.textContent!.includes('释放 2 个槽位'))
    expect(deleted).toBe(1)
    await flushUntil(() => c.textContent!.includes('云盘还是空的'))
  })
})
