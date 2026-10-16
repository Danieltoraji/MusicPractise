// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { AdminPage } from './AdminPage'
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

const ADMIN = { id: 'usr_ADMIN0000000000000000001', nickname: '站长', role: 'admin' }
const NORMAL = { id: 'usr_NORMAL0000000000000000001', nickname: '用户甲', role: 'user' }
const USER_ROW = { id: 'usr_NORMAL0000000000000000001', nickname: '用户甲', role: 'user', status: 'active', createdAt: 1 }
const LEVEL_ROW = { id: 'cld_TEST000000000000000000001', levelId: 'res_X', title: '甲的关卡', ownerNickname: '用户甲', bytes: 2048, updatedAt: 1 }
const AUDIT_ROW = { id: 'aud_TEST000000000000000000001', actorNickname: '站长', action: 'admin.patch_user', targetType: 'user', targetId: USER_ROW.id, detail: { status: 'disabled' }, createdAt: 1 }
const HUB_PENDING = {
  id: 'hub_TEST000000000000000000001',
  scope: 'public',
  itemKind: 'level',
  rootDocId: 'res_X',
  title: '甲的申请',
  levelCount: 1,
  bytes: 2048,
  submitterName: '用户甲',
  submitterNote: '请审核',
  wantFeatured: true,
  status: 'pending',
  featured: false,
  rejectReason: null,
  downloads: 0,
  createdAt: 1,
  updatedAt: 2,
}
const HUB_PUBLISHED = { ...HUB_PENDING, id: 'hub_TEST000000000000000000002', status: 'published', submitterNote: null, wantFeatured: false, updatedAt: 3 }
const GROUP_ROW = {
  id: 'grp_TEST000000000000000000001',
  name: '练耳小组',
  joinCode: 'lianer2026',
  intro: null,
  status: 'active',
  ownerNickname: '用户甲',
  memberCount: 2,
  itemCount: 1,
  createdAt: 1,
}

/** 按方法+路径前缀路由的可变 fetch 桩 */
const routes: Array<{ method: string; prefix: string; respond: (path: string) => Response }> = []
const calls: { method: string; path: string; body: unknown }[] = []

function stubRoutes(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input).replace(/^https?:\/\/[^/]+/, '')
      const method = (init?.method ?? 'GET').toUpperCase()
      const body = init?.body === undefined ? null : JSON.parse(String(init.body))
      const bare = path.includes('?') ? path.slice(0, path.indexOf('?')) : path
      const hit = routes.find((r) => r.method === method && (path.startsWith(r.prefix) || bare === r.prefix))
      if (!hit) throw new TypeError(`fetch 桩未覆盖 ${method} ${path}`)
      if (method !== 'GET') calls.push({ method, path, body })
      return hit.respond(path)
    }),
  )
}

beforeEach(async () => {
  localStorage.clear()
  resetAccountForTests()
  routes.length = 0
  calls.length = 0
  stubRoutes()
})

afterEach(() => {
  roots.splice(0).forEach((r) => act(() => r.unmount()))
  containers.splice(0).forEach((c) => c.remove())
  vi.unstubAllGlobals()
})

async function renderAfterProbe(user: unknown): Promise<HTMLElement> {
  routes.push(
    { method: 'GET', prefix: '/api/health', respond: () => new Response(JSON.stringify({ ok: true })) },
    { method: 'GET', prefix: '/api/auth/me', respond: () => new Response(JSON.stringify({ user })) },
  )
  await act(async () => {
    await probeAccount()
  })
  return renderEl(<AdminPage />)
}

function stubAdminData(): void {
  routes.push(
    { method: 'GET', prefix: '/api/admin/stats', respond: () => new Response(JSON.stringify({ users: 2, cloudLevels: 1, activeSessions: 2 })) },
    { method: 'GET', prefix: '/api/admin/users?', respond: () => new Response(JSON.stringify({ users: [USER_ROW], total: 1, limit: 20, offset: 0 })) },
    { method: 'GET', prefix: '/api/admin/levels?', respond: () => new Response(JSON.stringify({ levels: [LEVEL_ROW], total: 1, limit: 20, offset: 0 })) },
    { method: 'GET', prefix: '/api/admin/audit?', respond: () => new Response(JSON.stringify({ entries: [AUDIT_ROW], total: 1, limit: 20, offset: 0 })) },
    { method: 'GET', prefix: '/api/admin/groups?', respond: () => new Response(JSON.stringify({ groups: [GROUP_ROW], total: 1, limit: 20, offset: 0 })) },
    { method: 'GET', prefix: '/api/admin/hub?', respond: (path) => {
        const items = path.includes('status=published') ? [HUB_PUBLISHED] : [HUB_PENDING]
        return new Response(JSON.stringify({ items, total: items.length, limit: 20, offset: 0 }))
      } },
  )
}

describe('管理后台页（批次 B4，#/admin）', () => {
  it('探测中显示检测中；普通用户显示「仅管理员可见」', async () => {
    const c1 = renderEl(<AdminPage />)
    expect(c1.textContent).toContain('云端状态检测中')
    await act(async () => roots[0] && roots[0].unmount())

    routes.push(
      { method: 'GET', prefix: '/api/health', respond: () => new Response(JSON.stringify({ ok: true })) },
      { method: 'GET', prefix: '/api/auth/me', respond: () => new Response(JSON.stringify({ user: NORMAL })) },
    )
    await act(async () => {
      await probeAccount()
    })
    const c2 = renderEl(<AdminPage />)
    expect(c2.textContent).toContain('仅管理员可见')
  })

  it('admin 视角：统计 + 用户行 + 关卡行 + 审计行全部渲染', async () => {
    stubAdminData()
    const c = await renderAfterProbe(ADMIN)
    await flushUntil(() => c.querySelector('.admin-row') !== null)
    expect(c.textContent).toContain('用户')
    expect(c.textContent).toContain('用户甲')
    expect(c.textContent).toContain('甲的关卡')
    expect(c.textContent).toContain('admin.patch_user')
    expect(c.querySelectorAll('.admin-row').length).toBeGreaterThanOrEqual(3)
  })

  it('禁用用户：PATCH {status:disabled} + 刷新列表 + 成功反馈', async () => {
    stubAdminData()
    routes.push({
      method: 'PATCH',
      prefix: '/api/admin/users/',
      respond: () => new Response(JSON.stringify({ user: { ...USER_ROW, status: 'disabled' } })),
    })
    const c = await renderAfterProbe(ADMIN)
    await flushUntil(() => c.querySelector('.admin-row') !== null)
    await act(async () => buttonByText(c, '禁用').click())
    await flushUntil(() => c.textContent!.includes('已禁用并强制下线'))
    const patch = calls.find((x) => x.method === 'PATCH')
    expect(patch?.body).toEqual({ status: 'disabled' })
  })

  it('删除云盘关卡：confirm 后 DELETE', async () => {
    stubAdminData()
    routes.push({
      method: 'DELETE',
      prefix: '/api/admin/levels/',
      respond: () => new Response(JSON.stringify({ ok: true })),
    })
    const c = await renderAfterProbe(ADMIN)
    await flushUntil(() => c.querySelector('.admin-row') !== null)
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    // 关卡区的「删除」在第二个 .admin-table 里（用户区也有同名按钮）
    const levelTable = c.querySelectorAll('.admin-table')[1]
    const delBtn = [...(levelTable?.querySelectorAll('button') ?? [])].find((b) => b.textContent === '删除')
    expect(delBtn, '找不到关卡删除按钮').toBeTruthy()
    await act(async () => delBtn!.click())
    await flushUntil(() => c.textContent!.includes('已删除关卡'))
    expect(calls.find((x) => x.method === 'DELETE')?.path).toBe(`/api/admin/levels/${LEVEL_ROW.id}`)
  })

  it('重置密码：prompt 取消则不发请求；输入有效密码则 PATCH', async () => {
    stubAdminData()
    routes.push({
      method: 'PATCH',
      prefix: '/api/admin/users/',
      respond: () => new Response(JSON.stringify({ user: USER_ROW })),
    })
    const c = await renderAfterProbe(ADMIN)
    await flushUntil(() => c.querySelector('.admin-row') !== null)

    vi.spyOn(window, 'prompt').mockReturnValue(null)
    await act(async () => buttonByText(c, '重置密码').click())
    await act(async () => new Promise((r) => setTimeout(r, 20)))
    expect(calls.find((x) => x.method === 'PATCH')).toBeUndefined()

    vi.spyOn(window, 'prompt').mockReturnValue('new-pass-12345')
    await act(async () => buttonByText(c, '重置密码').click())
    await flushUntil(() => c.textContent!.includes('已重置密码'))
    expect(calls.find((x) => x.method === 'PATCH')?.body).toEqual({ newPassword: 'new-pass-12345' })
  })

  it('关卡库审核：待审行渲染 + 批准并精选 POST {featured:true}', async () => {
    stubAdminData()
    routes.push({
      method: 'POST',
      prefix: '/api/admin/hub/hub_TEST000000000000000000001/approve',
      respond: () => new Response(JSON.stringify({ ok: true, status: 'published', featured: true })),
    })
    const c = await renderAfterProbe(ADMIN)
    await flushUntil(() => c.textContent!.includes('甲的申请'))
    expect(c.textContent).toContain('申请人：用户甲')
    expect(c.textContent).toContain('留言：请审核')
    expect(c.textContent).toContain('申请精选')
    await act(async () => buttonByText(c, '批准并精选').click())
    await flushUntil(() => c.textContent!.includes('已批准「甲的申请」并设为精选'))
    const post = calls.find((x) => x.method === 'POST' && x.path.includes('/approve'))
    expect(post?.body).toEqual({ featured: true })
  })

  it('驳回：prompt 理由 → POST reject {reason}', async () => {
    stubAdminData()
    routes.push({
      method: 'POST',
      prefix: '/api/admin/hub/hub_TEST000000000000000000001/reject',
      respond: () => new Response(JSON.stringify({ ok: true, status: 'rejected' })),
    })
    const c = await renderAfterProbe(ADMIN)
    await flushUntil(() => c.textContent!.includes('甲的申请'))
    vi.spyOn(window, 'prompt').mockReturnValue('难度标注不符')
    await act(async () => buttonByText(c, '驳回').click())
    await flushUntil(() => c.textContent!.includes('已驳回「甲的申请」'))
    const post = calls.find((x) => x.method === 'POST' && x.path.includes('/reject'))
    expect(post?.body).toEqual({ reason: '难度标注不符' })
  })

  it('精选开关：已发布公共条目 PATCH {featured:true}', async () => {
    stubAdminData()
    routes.push({
      method: 'PATCH',
      prefix: '/api/admin/hub/hub_TEST000000000000000000002',
      respond: () => new Response(JSON.stringify({ ok: true, featured: true })),
    })
    const c = await renderAfterProbe(ADMIN)
    await flushUntil(() => c.textContent!.includes('关卡库审核'))
    await act(async () => {
      const sel = c.querySelector('.admin-toolbar select') as HTMLSelectElement
      sel.value = 'published'
      sel.dispatchEvent(new Event('change', { bubbles: true }))
    })
    await flushUntil(() => c.textContent!.includes('设为精选'))
    await act(async () => buttonByText(c, '设为精选').click())
    await flushUntil(() => c.textContent!.includes('已设置精选'))
    const patch = calls.find((x) => x.method === 'PATCH' && x.path.includes('/api/admin/hub/'))
    expect(patch?.body).toEqual({ featured: true })
  })

  it('群组管理：列表渲染 + 封禁 PATCH {status:banned} + 强制解散 DELETE', async () => {
    stubAdminData()
    routes.push(
      { method: 'PATCH', prefix: '/api/admin/groups/grp_TEST000000000000000000001', respond: () => new Response(JSON.stringify({ ok: true, status: 'banned' })) },
      { method: 'DELETE', prefix: '/api/admin/groups/grp_TEST000000000000000000001', respond: () => new Response(JSON.stringify({ ok: true })) },
    )
    const c = await renderAfterProbe(ADMIN)
    await flushUntil(() => c.textContent!.includes('群组管理'))
    await flushUntil(() => c.textContent!.includes('练耳小组'))
    expect(c.textContent).toContain('群主：用户甲')
    expect(c.textContent).toContain('2 名成员')
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    await act(async () => buttonByText(c, '封禁').click())
    await flushUntil(() => c.textContent!.includes('已封禁群组「练耳小组」'))
    const patch = calls.find((x) => x.method === 'PATCH' && x.path.includes('/api/admin/groups/'))
    expect(patch?.body).toEqual({ status: 'banned' })
    await act(async () => buttonByText(c, '强制解散').click())
    await flushUntil(() => c.textContent!.includes('已强制解散群组「练耳小组」'))
    expect(calls.some((x) => x.method === 'DELETE' && x.path.includes('/api/admin/groups/'))).toBe(true)
  })

  it('官方直传：单关 JSON 文件上传 → POST official', async () => {
    stubAdminData()
    routes.push({
      method: 'POST',
      prefix: '/api/admin/hub/official',
      respond: () => new Response(JSON.stringify({ ok: true, item: { id: 'hub_NEW' } }), { status: 201 }),
    })
    const c = await renderAfterProbe(ADMIN)
    await flushUntil(() => c.textContent!.includes('官方库管理'))
    const doc = { schemaVersion: 3, kind: 'level', id: 'res_OFFICIAL00000000000000001', version: '1.0.0', meta: { title: '官方关' }, refs: [], content: {} }
    const file = new File([JSON.stringify(doc)], 'official.json', { type: 'application/json' })
    const input = [...c.querySelectorAll('input[type="file"]')].find((i) => !(i as HTMLInputElement).multiple) as HTMLInputElement
    Object.defineProperty(input, 'files', { value: [file] })
    await act(async () => input.dispatchEvent(new Event('change', { bubbles: true })))
    await flushUntil(() => c.textContent!.includes('官方条目已上传'))
    const post = calls.find((x) => x.method === 'POST' && x.path.includes('/official'))
    expect(post?.body).toMatchObject({ levelId: 'res_OFFICIAL00000000000000001', title: '官方关' })
  })
})
