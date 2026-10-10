// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { AccountSection } from './AccountSection'
import { probeAccount, resetAccountForTests } from './store'

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

function inputByLabel(container: HTMLElement, label: string): HTMLInputElement {
  const el = [...container.querySelectorAll('.account-form label')].find((l) =>
    l.textContent?.includes(label),
  )?.querySelector('input')
  expect(el, `找不到「${label}」输入框`).toBeTruthy()
  return el as HTMLInputElement
}

async function type(el: HTMLInputElement, value: string): Promise<void> {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!
    setter.call(el, value)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

function buttonByText(container: HTMLElement, text: string): HTMLButtonElement {
  const el = [...container.querySelectorAll('button')].find((b) => b.textContent === text)
  expect(el, `找不到按钮「${text}」`).toBeTruthy()
  return el as HTMLButtonElement
}

/** 登录/注册提交按钮（登录态下模式切换按钮也叫「登录」，须用主按钮选择器区分） */
function submitButton(container: HTMLElement): HTMLButtonElement {
  const el = container.querySelector<HTMLButtonElement>('.account-form .settings-actions button.primary')
  expect(el, '找不到提交主按钮').toBeTruthy()
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
const ADMIN = { id: 'usr_B', nickname: '站长', role: 'admin' }

/** 按路径路由的可变 fetch 桩：测试中随时改写 routes 转换场景 */
const routes: Record<string, (init: RequestInit) => Response> = {}

beforeEach(() => {
  localStorage.clear()
  resetAccountForTests()
  for (const key of Object.keys(routes)) delete routes[key]
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input).replace(/^https?:\/\/[^/]+/, '')
      const handler = routes[path]
      if (!handler) throw new TypeError(`fetch 桩未覆盖路径: ${path}`)
      return handler(init ?? {})
    }),
  )
})

afterEach(() => {
  roots.splice(0).forEach((r) => act(() => r.unmount()))
  containers.splice(0).forEach((c) => c.remove())
  vi.unstubAllGlobals()
})

/** 先探测到指定状态再渲染（探测由 App 负责，组件只消费快照） */
async function renderAfterProbe(user: unknown): Promise<HTMLElement> {
  routes['/api/health'] = () => new Response(JSON.stringify({ ok: true }))
  routes['/api/auth/me'] = () => new Response(JSON.stringify({ user }))
  await act(async () => {
    await probeAccount()
  })
  return renderEl(<AccountSection />)
}

describe('设置页账户区（批次 B1）', () => {
  it('探测中：显示检测中提示', () => {
    const c = renderEl(<AccountSection />)
    expect(c.textContent).toContain('云端状态检测中')
  })

  it('云端不可用：降级提示并说明本地功能不受影响', async () => {
    routes['/api/health'] = () => {
      throw new TypeError('fetch failed')
    }
    await act(async () => {
      await probeAccount()
    })
    const c = renderEl(<AccountSection />)
    expect(c.textContent).toContain('云端不可用')
    expect(c.textContent).toContain('不受影响')
    expect(c.querySelector('.account-form')).toBeNull()
  })

  it('未登录默认登录态：表单 + 忘记密码提示；登录成功切换到已登录视图', async () => {
    const c = await renderAfterProbe(null)
    expect(c.textContent).toContain('忘记密码')
    expect(c.querySelector('.account-mode button.active')?.textContent).toBe('登录')

    routes['/api/auth/login'] = () => new Response(JSON.stringify({ user: USER }))
    await type(inputByLabel(c, '昵称'), '阿明')
    await type(inputByLabel(c, '密码'), 'password-123')
    await act(async () => submitButton(c).click())
    await flushUntil(() => c.textContent!.includes('当前账号'))
    expect(c.textContent).toContain('阿明')
    expect(c.textContent).not.toContain('管理员')
  })

  it('登录失败：红字反馈服务端中文消息，保留登录态', async () => {
    const c = await renderAfterProbe(null)
    routes['/api/auth/login'] = () =>
      new Response(JSON.stringify({ error: { code: 'invalid_credentials', message: '昵称或密码错误' } }), { status: 401 })
    await type(inputByLabel(c, '昵称'), '阿明')
    await type(inputByLabel(c, '密码'), 'wrong-pass-1')
    await act(async () => submitButton(c).click())
    await flushUntil(() => c.querySelector('.settings-test-bad') !== null)
    expect(c.querySelector('.settings-test-bad')?.textContent).toBe('昵称或密码错误')
    expect(c.querySelector('.account-current')).toBeNull()
  })

  it('注册态：确认密码不一致本地拦截；一致则注册成功', async () => {
    const c = await renderAfterProbe(null)
    await act(async () => buttonByText(c, '注册').click())
    expect(c.textContent).toContain('确认密码')
    expect(c.textContent).toContain('密码丢失需联系管理员重置')

    await type(inputByLabel(c, '昵称'), '小明')
    await type(inputByLabel(c, '密码'), 'password-123')
    await type(inputByLabel(c, '确认密码'), 'password-456')
    await act(async () => buttonByText(c, '创建账号').click())
    await flushUntil(() => c.querySelector('.settings-test-bad') !== null)
    expect(c.querySelector('.settings-test-bad')?.textContent).toBe('两次输入的密码不一致')

    await type(inputByLabel(c, '确认密码'), 'password-123')
    routes['/api/auth/register'] = () => new Response(JSON.stringify({ user: { ...USER, nickname: '小明' } }), { status: 201 })
    await act(async () => buttonByText(c, '创建账号').click())
    await flushUntil(() => c.textContent!.includes('当前账号'))
    expect(c.textContent).toContain('小明')
  })

  it('已登录视图：管理员徽标 + 保存昵称 + 退出登录回到登录表单', async () => {
    const c = await renderAfterProbe(ADMIN)
    expect(c.textContent).toContain('当前账号')
    expect(c.querySelector('.account-badge')?.textContent).toBe('管理员')

    routes['/api/auth/nickname'] = () => new Response(JSON.stringify({ user: { ...ADMIN, nickname: '新站长' } }))
    await type(inputByLabel(c, '修改昵称'), '新站长')
    await act(async () => buttonByText(c, '保存昵称').click())
    await flushUntil(() => c.textContent!.includes('昵称已更新'))
    expect(c.querySelector('.account-current b')?.textContent).toBe('新站长')

    routes['/api/auth/logout'] = () => new Response(JSON.stringify({ ok: true }))
    await act(async () => buttonByText(c, '退出登录').click())
    await flushUntil(() => c.querySelector('.account-mode') !== null)
    expect(c.textContent).toContain('忘记密码')
    // 退出后固定落在登录模式（注册态不复用）
    expect(c.querySelector('.account-mode button.active')?.textContent).toBe('登录')
  })

  it('改密码：成功反馈；输入为空时按钮禁用', async () => {
    const c = await renderAfterProbe(USER)
    const submit = buttonByText(c, '修改密码')
    expect(submit.disabled).toBe(true)

    routes['/api/auth/password'] = () => new Response(JSON.stringify({ ok: true }))
    await type(inputByLabel(c, '当前密码'), 'old-pass-123')
    expect(submit.disabled).toBe(true)
    await type(inputByLabel(c, '新密码（至少 8 位）'), 'new-pass-456')
    expect(submit.disabled).toBe(false)
    await act(async () => submit.click())
    await flushUntil(() => c.textContent!.includes('密码已更新'))
  })
})
