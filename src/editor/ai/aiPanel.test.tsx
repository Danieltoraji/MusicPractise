// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AI_SETTINGS_KEY, defaultAiSettings } from '../../ai/settings'
import { clearSession, getSession } from '../../ai/session'
import { blankLevelDoc } from '../docState'
import { AiPanel } from './AiPanel'

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

async function flushUntil(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now()
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('flushUntil 超时')
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10))
    })
  }
}

const DOC = blankLevelDoc()
const noop = (): void => {}

function bodyResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), { status, headers: { 'Content-Type': 'application/json' } })
}

beforeEach(() => {
  localStorage.clear()
  clearSession(DOC.id)
})

afterEach(() => {
  roots.splice(0).forEach((r) => act(() => r.unmount()))
  containers.splice(0).forEach((c) => c.remove())
  vi.unstubAllGlobals()
})

describe('AiPanel（jsdom）', () => {
  it('未配置 Key：显示去设置引导，发送被禁用', () => {
    const c = renderEl(<AiPanel doc={DOC} selection={{ tab: 'canvas' }} onClose={noop} />)
    expect(c.textContent).toContain('前往设置')
    const send = [...c.querySelectorAll('button')].find((b) => b.textContent === '发送') as HTMLButtonElement
    expect(send.disabled).toBe(true)
  })

  it('ask 一轮：工具调用+文本回复渲染；消息含选中上下文前缀', async () => {
    localStorage.setItem(AI_SETTINGS_KEY, JSON.stringify(defaultAiSettings()))
    // 预置 Key
    const stored = JSON.parse(localStorage.getItem(AI_SETTINGS_KEY)!)
    stored.profiles.deepseek.apiKey = 'sk-t'
    localStorage.setItem(AI_SETTINGS_KEY, JSON.stringify(stored))

    let call = 0
    const fetchMock = vi.fn(async () => {
      const payload =
        call === 0
          ? { choices: [{ message: { content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'read_script', arguments: '{}' } }] } }] }
          : { choices: [{ message: { content: '这个关卡逻辑很简单：点按钮播声音。' } }] }
      call += 1
      return bodyResponse(payload)
    })
    vi.stubGlobal('fetch', fetchMock)

    const c = renderEl(
      <AiPanel doc={DOC} selection={{ tab: 'graph', nodeId: null, componentId: null, scriptRange: null }} onClose={noop} />,
    )
    const input = c.querySelector('.ai-panel-form textarea') as HTMLTextAreaElement
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')!.set!
      setter.call(input, '这个关卡的逻辑是怎么走的？')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => {
      ;[...c.querySelectorAll('button')].find((b) => b.textContent === '发送')!.click()
    })
    await flushUntil(() => c.textContent!.includes('这个关卡逻辑很简单'))

    // 消息渲染：用户气泡、工具调用行、工具结果折叠卡、AI 回复
    expect(c.querySelector('.ai-msg-user')?.textContent).toContain('这个关卡的逻辑是怎么走的')
    expect(c.querySelector('.ai-tool-calls')?.textContent).toContain('read_script')
    expect(c.querySelector('.ai-msg-tool')?.textContent).toContain('read_script')
    expect(c.textContent).toContain('这个关卡逻辑很简单')
    // 首次请求的 user 消息带 ask 工具；系统提示不在会话历史里
    const init = (fetchMock.mock.calls[1] as unknown[])[1] as { body: string }
    const body = JSON.parse(init.body)
    const roles = (body.messages as { role: string }[]).map((m) => m.role)
    expect(roles.filter((r) => r === 'tool')).toHaveLength(1)
    expect(roles[0]).toBe('system')
  })

  it('清空按钮：会话消息清空后空态恢复', async () => {
    localStorage.setItem(AI_SETTINGS_KEY, JSON.stringify(defaultAiSettings()))
    const stored = JSON.parse(localStorage.getItem(AI_SETTINGS_KEY)!)
    stored.profiles.deepseek.apiKey = 'sk-t'
    localStorage.setItem(AI_SETTINGS_KEY, JSON.stringify(stored))
    vi.stubGlobal('fetch', vi.fn(async () => bodyResponse({ choices: [{ message: { content: 'hi' } }] })))

    const c = renderEl(<AiPanel doc={DOC} selection={{ tab: 'canvas' }} onClose={noop} />)
    const input = c.querySelector('.ai-panel-form textarea') as HTMLTextAreaElement
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')!.set!
      setter.call(input, '你好')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => {
      ;[...c.querySelectorAll('button')].find((b) => b.textContent === '发送')!.click()
    })
    await flushUntil(() => c.textContent!.includes('hi'))
    await act(async () => {
      ;[...c.querySelectorAll('button')].find((b) => b.textContent === '清空')!.click()
    })
    expect(getSession(DOC.id).messages).toHaveLength(0)
    expect(c.querySelector('.ai-panel-empty')).toBeTruthy()
  })

  it('供应商 401：错误条显示鉴权失败，可关闭', async () => {
    localStorage.setItem(AI_SETTINGS_KEY, JSON.stringify(defaultAiSettings()))
    const stored = JSON.parse(localStorage.getItem(AI_SETTINGS_KEY)!)
    stored.profiles.deepseek.apiKey = 'sk-bad'
    localStorage.setItem(AI_SETTINGS_KEY, JSON.stringify(stored))
    vi.stubGlobal('fetch', vi.fn(async () => bodyResponse({ error: { message: 'bad key' } }, 401)))

    const c = renderEl(<AiPanel doc={DOC} selection={{ tab: 'canvas' }} onClose={noop} />)
    const input = c.querySelector('.ai-panel-form textarea') as HTMLTextAreaElement
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')!.set!
      setter.call(input, '测试')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => {
      ;[...c.querySelectorAll('button')].find((b) => b.textContent === '发送')!.click()
    })
    await flushUntil(() => c.querySelector('.ai-panel-error') !== null)
    expect(c.querySelector('.ai-panel-error')?.textContent).toContain('鉴权失败')
    await act(async () => (c.querySelector('.ai-panel-error-close') as HTMLElement).click())
    expect(c.querySelector('.ai-panel-error')).toBeNull()
  })
})
