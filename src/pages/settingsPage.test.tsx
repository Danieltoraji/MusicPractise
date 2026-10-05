// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AI_SETTINGS_KEY } from '../ai/settings'
import * as audio from '../runtime/audio'
import { SettingsPage } from './SettingsPage'

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

function inputByValue(container: HTMLElement, match: RegExp): HTMLInputElement {
  const el = [...container.querySelectorAll('.settings-form input')].find((i) => match.test((i as HTMLInputElement).value))
  expect(el, `找不到值匹配 ${match} 的输入框`).toBeTruthy()
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

/** 轮询等待异步副作用（测试连接的 promise 链）渲染出结果 */
async function flushUntil(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now()
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('flushUntil 超时')
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10))
    })
  }
}

beforeEach(() => {
  localStorage.clear()
})

afterEach(() => {
  roots.splice(0).forEach((r) => act(() => r.unmount()))
  containers.splice(0).forEach((c) => c.remove())
  vi.unstubAllGlobals()
})

describe('SettingsPage（jsdom）', () => {
  it('渲染预设供应商卡片，切换卡片联动表单', () => {
    const c = renderEl(<SettingsPage />)
    expect(c.textContent).toContain('DeepSeek')
    expect(c.textContent).toContain('智谱 GLM')
    expect(c.textContent).toContain('OpenRouter')
    // 默认表单是 deepseek
    expect(inputByValue(c, /deepseek\.com/)).toBeTruthy()
    // 切到 GLM
    const glm = [...c.querySelectorAll('.provider-card')].find((b) => b.textContent?.includes('智谱 GLM'))!
    act(() => (glm as HTMLElement).click())
    expect(inputByValue(c, /bigmodel\.cn/)).toBeTruthy()
    expect(inputByValue(c, /glm-4\.6/)).toBeTruthy()
  })

  it('编辑 + 保存写入 localStorage；重挂（模拟刷新）读取一致', async () => {
    const c = renderEl(<SettingsPage />)
    await type(inputByValue(c, /^sk-|^$/), 'sk-abc')
    await act(async () => buttonByText(c, '保存设置').click())
    const stored = JSON.parse(localStorage.getItem(AI_SETTINGS_KEY)!)
    expect(stored.profiles.deepseek.apiKey).toBe('sk-abc')
    expect(c.textContent).toContain('已保存')
    // 重挂 = 模拟页面刷新
    const c2 = renderEl(<SettingsPage />)
    expect(inputByValue(c2, /^sk-abc$/)).toBeTruthy()
  })

  it('添加自定义供应商 → 出现名称/地址表单并可保存；删除后消失', async () => {
    const c = renderEl(<SettingsPage />)
    await act(async () => buttonByText(c, '＋ 添加自定义供应商').click())
    expect(c.querySelector('.provider-card-custom')).toBeTruthy()
    expect(c.textContent).toContain('自定义供应商配置')
    await type(inputByValue(c, /^$/), 'https://gw.example/v1')
    await act(async () => buttonByText(c, '保存设置').click())
    const stored = JSON.parse(localStorage.getItem(AI_SETTINGS_KEY)!)
    const customIds = Object.keys(stored.profiles).filter((k) => k.startsWith('custom-'))
    expect(customIds).toHaveLength(1)
    expect(stored.profiles[customIds[0]].baseUrl).toBe('https://gw.example/v1')
    // 删除
    await act(async () => (c.querySelector('.provider-card-remove') as HTMLElement).click())
    expect(c.querySelector('.provider-card-custom')).toBeNull()
    // 删除后激活档回落预设
    expect(inputByValue(c, /deepseek\.com/)).toBeTruthy()
  })

  it('测试连接：成功显示延迟与模型应答（用当前表单值）', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ choices: [{ message: { content: '正常' } }] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
    )
    vi.stubGlobal('fetch', fetchMock)
    const c = renderEl(<SettingsPage />)
    await type(inputByValue(c, /^sk-|^$/), 'sk-ok')
    await act(async () => buttonByText(c, '测试连接').click())
    await flushUntil(() => c.querySelector('.settings-test') !== null)
    expect(c.querySelector('.settings-test-ok')?.textContent).toContain('连接成功')
    expect(c.querySelector('.settings-test-ok')?.textContent).toContain('正常')
    const init = (fetchMock.mock.calls[0] as unknown[])[1] as RequestInit
    const body = JSON.parse(init.body as string)
    expect(body.model).toBe('deepseek-chat')
  })

  it('测试连接失败：显示分类错误文案', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ error: { message: 'Invalid API key' } }), {
            status: 401,
            headers: { 'Content-Type': 'application/json' },
          }),
      ),
    )
    const c = renderEl(<SettingsPage />)
    await type(inputByValue(c, /^sk-|^$/), 'sk-wrong')
    await act(async () => buttonByText(c, '测试连接').click())
    await flushUntil(() => c.querySelector('.settings-test') !== null)
    const bad = c.querySelector('.settings-test-bad')
    expect(bad?.textContent).toContain('鉴权失败')
    expect(bad?.textContent).toContain('Invalid API key')
  })
})

describe('设置页音频卡（批次13）', () => {
  beforeEach(() => {
    localStorage.removeItem('master-volume')
  })

  function audioSlider(c: HTMLElement): HTMLInputElement {
    const el = c.querySelector('.audio-volume-row input[type="range"]') as HTMLInputElement
    expect(el, '找不到音量滑条').toBeTruthy()
    return el
  }

  it('音量滑条拖动即写 localStorage（master-volume）并显示百分比', async () => {
    const c = renderEl(<SettingsPage />)
    const slider = audioSlider(c)
    expect(slider.value).toBe('100') // 缺省 1
    await type(slider, '40')
    expect(localStorage.getItem('master-volume')).toBe('0.4')
    expect(c.querySelector('.audio-volume-row b')?.textContent).toBe('40%')
  })

  it('重挂读取持久化音量；试听按钮不抛错', async () => {
    localStorage.setItem('master-volume', '0.3')
    const c = renderEl(<SettingsPage />)
    expect(audioSlider(c).value).toBe('30')
    const play = vi.spyOn(audio, 'playNotes').mockReturnValue(undefined)
    await act(async () => {
      ;(c.querySelector('.audio-volume-row button') as HTMLButtonElement).click()
    })
    expect(play).toHaveBeenCalledTimes(1)
  })
})
