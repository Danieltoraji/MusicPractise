// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { clearCheckpoint } from '../../ai/checkpoint'
import { AI_SETTINGS_KEY, defaultAiSettings } from '../../ai/settings'
import { clearSession, getSession } from '../../ai/session'
import { blankLevelDoc } from '../docState'
import type { LevelDoc } from '../../engine/level'
import { AiPanel } from './AiPanel'

// 附图压缩依赖 Image 解码（jsdom 不加载资源，onload 永不触发）——面板测试短路为原图直通
vi.mock('../../ai/imageAttach', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../ai/imageAttach')>()
  return { ...mod, downscaleImage: async (url: string) => url }
})

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

/** 受控 textarea 输入（React 原生 value setter + input 事件） */
async function type(el: HTMLTextAreaElement, value: string): Promise<void> {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')!.set!
    setter.call(el, value)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

const DOC = blankLevelDoc()
const noop = (): void => {}

/** 200 且含 choices 时把 JSON 响应转成 SSE 流（面板走 stream:true，供应商总是回流）；错误状态保持 JSON */
function bodyResponse(payload: unknown, status = 200): Response {
  const p = payload as {
    choices?: Array<{ message?: { content?: string; tool_calls?: Array<Record<string, unknown>> } }>
    usage?: unknown
  }
  if (status === 200 && p?.choices) {
    const msg = p.choices[0]?.message ?? {}
    const enc = new TextEncoder()
    const parts: string[] = []
    if (msg.content) parts.push(`data: ${JSON.stringify({ choices: [{ delta: { content: msg.content } }] })}\n\n`)
    if (msg.tool_calls) parts.push(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: msg.tool_calls } }] })}\n\n`)
    // 部分供应商在末块附顶层 usage（批次8c 用量统计的来源）
    if (p.usage) parts.push(`data: ${JSON.stringify({ usage: p.usage })}\n\n`)
    parts.push('data: [DONE]\n\n')
    return new Response(enc.encode(parts.join('')), { status, headers: { 'Content-Type': 'text/event-stream' } })
  }
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

describe('运行归属（docs/40 R5：C4/F5）', () => {
  function setKey(): void {
    localStorage.setItem(AI_SETTINGS_KEY, JSON.stringify(defaultAiSettings()))
    const stored = JSON.parse(localStorage.getItem(AI_SETTINGS_KEY)!)
    stored.profiles.deepseek.apiKey = 'sk-t'
    localStorage.setItem(AI_SETTINGS_KEY, JSON.stringify(stored))
  }

  it('面板卸载即停止 agent 循环——不再「关面板后隐蔽运行/写入丢失但显示已应用」', async () => {
    setKey()
    clearSession(DOC.id)
    // fetch 挂起：模拟一轮运行中的请求
    vi.stubGlobal('fetch', vi.fn((_url: unknown, init?: { signal?: AbortSignal }) => new Promise((_res, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')))
    })))
    const c = renderEl(<AiPanel doc={DOC} selection={{ tab: 'canvas' }} onApplyDoc={vi.fn()} onClose={noop} />)
    await flushUntil(() => (c.querySelector('.ai-panel-form textarea') as HTMLTextAreaElement) !== null)
    const ta = c.querySelector('.ai-panel-form textarea') as HTMLTextAreaElement
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')!.set!
    act(() => {
      setter.call(ta, '帮我改关卡')
      ta.dispatchEvent(new Event('input', { bubbles: true }))
    })
    const sendBtn = [...c.querySelectorAll('button')].find((b) => b.textContent === '发送') as HTMLButtonElement
    act(() => sendBtn.click())
    await flushUntil(() => getSession(DOC.id).busy)
    expect(getSession(DOC.id).busy).toBe(true)
    // 卸载面板（用户关闭面板 / 切 Tab）——renderEl 注册的 root 需手动出列
    const idx = roots.length - 1
    await act(async () => roots[idx].unmount())
    roots.splice(idx, 1)
    await flushUntil(() => !getSession(DOC.id).busy)
    expect(getSession(DOC.id).busy).toBe(false) // 修复前：运行继续且无法停止
    expect(getSession(DOC.id).error).toContain('已停止')
    vi.unstubAllGlobals()
  })
})

describe('AiPanel（jsdom）', () => {
  it('未配置 Key：显示去设置引导，发送被禁用', () => {
    const c = renderEl(<AiPanel doc={DOC} selection={{ tab: 'canvas' }} onApplyDoc={vi.fn()} onClose={noop} />)
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
      <AiPanel doc={DOC} selection={{ tab: 'graph', nodeId: null, componentId: null, scriptRange: null }} onApplyDoc={vi.fn()} onClose={noop} />,
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

    const c = renderEl(<AiPanel doc={DOC} selection={{ tab: 'canvas' }} onApplyDoc={vi.fn()} onClose={noop} />)
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

    const c = renderEl(<AiPanel doc={DOC} selection={{ tab: 'canvas' }} onApplyDoc={vi.fn()} onClose={noop} />)
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

describe('AiPanel agent 模式（批次2a）', () => {
  beforeEach(() => {
    clearCheckpoint('res_agent_ui')
  })

  function setKey(): void {
    localStorage.setItem(AI_SETTINGS_KEY, JSON.stringify(defaultAiSettings()))
    const stored = JSON.parse(localStorage.getItem(AI_SETTINGS_KEY)!)
    stored.profiles.deepseek.apiKey = 'sk-t'
    localStorage.setItem(AI_SETTINGS_KEY, JSON.stringify(stored))
  }

  it('模式切换：agent 分段按钮切换会话模式并持久（按 doc.id）', () => {
    setKey()
    const c = renderEl(<AiPanel doc={DOC} selection={{ tab: 'canvas' }} onApplyDoc={vi.fn()} onClose={noop} />)
    const agentTab = [...c.querySelectorAll('.ai-mode-tab')].find((b) => b.textContent === 'agent') as HTMLButtonElement
    act(() => agentTab.click())
    expect(getSession(DOC.id).mode).toBe('agent')
    expect(agentTab.classList.contains('active')).toBe(true)
    // 切回 ask
    const askTab = [...c.querySelectorAll('.ai-mode-tab')].find((b) => b.textContent === 'ask') as HTMLButtonElement
    act(() => askTab.click())
    expect(getSession(DOC.id).mode).toBe('ask')
  })

  it('ask 模式：请求体只带只读工具（不含 write_script）', async () => {
    setKey()
    const fetchMock = vi.fn(async () => bodyResponse({ choices: [{ message: { content: '好的' } }] }))
    vi.stubGlobal('fetch', fetchMock)
    const c = renderEl(<AiPanel doc={DOC} selection={{ tab: 'canvas' }} onApplyDoc={vi.fn()} onClose={noop} />)
    await type((c.querySelector(".ai-panel-form textarea") as HTMLTextAreaElement), '这个关卡是干嘛的')
    await act(async () => {
      ;[...c.querySelectorAll('button')].find((b) => b.textContent === '发送')!.click()
    })
    await flushUntil(() => c.textContent!.includes('好的'))
    const body = JSON.parse(((fetchMock.mock.calls[0] as unknown[])[1] as { body: string }).body)
    const names = (body.tools as { function: { name: string } }[]).map((t) => t.function.name)
    expect(names).not.toContain('write_script')
    expect(names).toContain('read_script')
  })

  it('agent 模式：write_script 调用落地 onApplyDoc；发送存检查点；回滚恢复原 doc', async () => {
    setKey()
    clearSession(DOC.id)
    const applyDoc = vi.fn()
    const original = blankLevelDoc() // 独立 doc（可变引用，检查点对照用）
    let call = 0
    const fetchMock = vi.fn(async () => {
      const payload =
        call === 0
          ? {
              choices: [
                {
                  message: {
                    content: '',
                    tool_calls: [
                      { id: 'w1', type: 'function', function: { name: 'write_script', arguments: JSON.stringify({ script: 'on level.started {\n  v.score = 100\n}' }) } },
                    ],
                  },
                },
              ],
            }
          : { choices: [{ message: { content: '已把初始分改为 100。' } }] }
      call += 1
      return bodyResponse(payload)
    })
    vi.stubGlobal('fetch', fetchMock)
    const c = renderEl(<AiPanel doc={original} selection={{ tab: 'canvas' }} onApplyDoc={applyDoc} onClose={noop} />)
    // 切 agent 模式
    act(() => ([...c.querySelectorAll('.ai-mode-tab')].find((b) => b.textContent === 'agent') as HTMLElement).click())
    await type((c.querySelector(".ai-panel-form textarea") as HTMLTextAreaElement), '把初始分改成 100')
    await act(async () => {
      ;[...c.querySelectorAll('button')].find((b) => b.textContent === '发送')!.click()
    })
    await flushUntil(() => c.textContent!.includes('已把初始分改为 100'))

    // 写入落地：applyDoc 收到的 doc 含新逻辑节点
    expect(applyDoc).toHaveBeenCalledTimes(1)
    const applied = applyDoc.mock.calls[0][0] as LevelDoc
    expect(applied.content.logic.nodes.some((n: { kind: string; target?: string }) => n.kind === 'assign' && (n as { target: string }).target === 'score')).toBe(true)
    // 第二次请求带上了 tool 结果
    const body2 = JSON.parse(((fetchMock.mock.calls[1] as unknown[])[1] as { body: string }).body)
    expect(body2.messages.some((m: { role: string; tool_call_id?: string }) => m.role === 'tool' && m.tool_call_id === 'w1')).toBe(true)
    // agent 请求体含 write_script 工具
    const body1 = JSON.parse(((fetchMock.mock.calls[0] as unknown[])[1] as { body: string }).body)
    expect((body1.tools as { function: { name: string } }[]).some((t) => t.function.name === 'write_script')).toBe(true)

    // 回滚按钮出现 → 点击恢复原 doc、按钮消失
    expect(getSession(original.id).checkpointAt).not.toBeNull()
    const rollback = [...c.querySelectorAll('button')].find((b) => b.textContent === '↩ 回滚') as HTMLButtonElement
    expect(rollback).toBeTruthy()
    await act(async () => rollback.click())
    expect(applyDoc).toHaveBeenCalledTimes(2)
    expect((applyDoc.mock.calls[1][0] as LevelDoc).meta.title).toBe(original.meta.title)
    expect(getSession(original.id).checkpointAt).toBeNull()
    expect(c.textContent).toContain('已回滚')
  })
})

describe('AiPanel plan 模式 + plan-act 工作流（批次2b 完成）', () => {
  function setKey(): void {
    localStorage.setItem(AI_SETTINGS_KEY, JSON.stringify(defaultAiSettings()))
    const stored = JSON.parse(localStorage.getItem(AI_SETTINGS_KEY)!)
    stored.profiles.deepseek.apiKey = 'sk-t'
    localStorage.setItem(AI_SETTINGS_KEY, JSON.stringify(stored))
  }

  const PLAN_TEXT = '1. [write_script] 把 on level.started 的初始分改为 100\n2. [run_level] 验证：无头试运行'

  it('plan 全流程：无写工具请求 → 计划卡清单 → 勾选排除 → 执行 → update_plan 进度 → 完成', async () => {
    setKey()
    clearSession(DOC.id)
    const applyDoc = vi.fn()
    let call = 0
    const fetchMock = vi.fn(async () => {
      let payload: unknown
      if (call === 0) payload = { choices: [{ message: { content: PLAN_TEXT } }] }
      else if (call === 1) {
        payload = {
          choices: [
            {
              message: {
                content: '',
                tool_calls: [
                  { id: 'p1', type: 'function', function: { name: 'update_plan', arguments: JSON.stringify({ marks: [{ index: 0, status: 'done' }] }) } },
                ],
              },
            },
          ],
        }
      } else payload = { choices: [{ message: { content: '计划执行完毕。' } }] }
      call += 1
      return bodyResponse(payload)
    })
    vi.stubGlobal('fetch', fetchMock)

    const c = renderEl(<AiPanel doc={DOC} selection={{ tab: 'canvas' }} onApplyDoc={applyDoc} onClose={noop} />)
    act(() => ([...c.querySelectorAll('.ai-mode-tab')].find((b) => b.textContent === 'plan') as HTMLElement).click())
    await type((c.querySelector('.ai-panel-form textarea') as HTMLTextAreaElement), '把初始分改成 100')
    await act(async () => {
      ;[...c.querySelectorAll('button')].find((b) => b.textContent === '发送')!.click()
    })
    await flushUntil(() => c.querySelector('.ai-plan-card') !== null)

    // plan 请求体不含写工具
    const body1 = JSON.parse(((fetchMock.mock.calls[0] as unknown[])[1] as { body: string }).body)
    const names1 = (body1.tools as { function: { name: string } }[]).map((t) => t.function.name)
    expect(names1).not.toContain('write_script')

    // 计划卡：2 项清单 + 勾选框
    expect(c.querySelectorAll('.ai-plan-item')).toHaveLength(2)
    expect(c.textContent).toContain('[write_script] 把 on level.started 的初始分改为 100')

    // 勾选排除第 2 项（index 1）
    const boxes = [...c.querySelectorAll('.ai-plan-item input[type=checkbox]')] as HTMLInputElement[]
    await act(async () => boxes[1].click())
    expect(boxes[1].checked).toBe(false)

    // 执行计划 → 转 agent、update_plan 可用、指令只含未排除项
    await act(async () => {
      ;[...c.querySelectorAll('button')].find((b) => b.textContent === '▶ 执行计划')!.click()
    })
    await flushUntil(() => c.textContent!.includes('计划执行完毕'))

    expect(getSession(DOC.id).mode).toBe('agent')
    const body2 = JSON.parse(((fetchMock.mock.calls[1] as unknown[])[1] as { body: string }).body)
    const lastUser = [...body2.messages].reverse().find((m: { role: string }) => m.role === 'user')
    expect(lastUser.content).toContain('write_script] 把 on level.started')
    expect(lastUser.content).not.toContain('run_level] 验证')
    const names2 = (body2.tools as { function: { name: string } }[]).map((t) => t.function.name)
    expect(names2).toContain('write_script')
    expect(names2).toContain('update_plan')

    // update_plan 落地：第 1 项 done、第 2 项 skipped、计划完成
    const plan = getSession(DOC.id).plan!
    expect(plan.status).toBe('done')
    expect(plan.items[0].status).toBe('done')
    expect(plan.items[1].status).toBe('skipped')
    expect(c.textContent).toContain('✅ 计划完成')
  })
})
describe('AiPanel 开场自动发送与预设（批次4）', () => {
  function setKey(): void {
    localStorage.setItem(AI_SETTINGS_KEY, JSON.stringify(defaultAiSettings()))
    const stored = JSON.parse(localStorage.getItem(AI_SETTINGS_KEY)!)
    stored.profiles.deepseek.apiKey = 'sk-t'
    localStorage.setItem(AI_SETTINGS_KEY, JSON.stringify(stored))
  }

  it('kickoff：资源库 AI 新建 → 挂载即切 agent 并自动发送描述', async () => {
    setKey()
    clearSession(DOC.id)
    const kickoffDoc = blankLevelDoc()
    sessionStorage.setItem(`ai-kickoff:${kickoffDoc.id}`, JSON.stringify({ docId: kickoffDoc.id, prompt: '做一个三和弦听辨练习' }))
    const fetchMock = vi.fn(async () => bodyResponse({ choices: [{ message: { content: '收到，开始搭建。' } }] }))
    vi.stubGlobal('fetch', fetchMock)
    const c = renderEl(<AiPanel doc={kickoffDoc} selection={{ tab: 'canvas' }} onApplyDoc={vi.fn()} onClose={noop} />)
    await flushUntil(() => c.textContent!.includes('收到，开始搭建'))
    expect(getSession(kickoffDoc.id).mode).toBe('agent')
    const body = JSON.parse(((fetchMock.mock.calls[0] as unknown[])[1] as { body: string }).body)
    const lastUser = [...body.messages].reverse().find((m: { role: string }) => m.role === 'user')
    expect(lastUser.content).toContain('做一个三和弦听辨练习')
    expect(sessionStorage.getItem(`ai-kickoff:${kickoffDoc.id}`)).toBeNull()
  })

  it('kickoff 未配置 Key：提示词填入输入框不丢失', () => {
    const kickoffDoc = blankLevelDoc()
    sessionStorage.setItem(`ai-kickoff:${kickoffDoc.id}`, JSON.stringify({ docId: kickoffDoc.id, prompt: '节奏训练关' }))
    const c = renderEl(<AiPanel doc={kickoffDoc} selection={{ tab: 'canvas' }} onApplyDoc={vi.fn()} onClose={noop} />)
    expect((c.querySelector('.ai-panel-form textarea') as HTMLTextAreaElement).value).toBe('节奏训练关')
    expect(getSession(kickoffDoc.id).mode).toBe('agent')
    expect(sessionStorage.getItem(`ai-kickoff:${kickoffDoc.id}`)).toBeNull()
  })

  it('空态预设：点击即填入输入框', () => {
    setKey()
    const c = renderEl(<AiPanel doc={DOC} selection={{ tab: 'canvas' }} onApplyDoc={vi.fn()} onClose={noop} />)
    const preset = [...c.querySelectorAll('.ai-preset')].find((b) => b.textContent?.includes('这个关卡的逻辑')) as HTMLButtonElement
    act(() => preset.click())
    expect((c.querySelector('.ai-panel-form textarea') as HTMLTextAreaElement).value).toContain('这个关卡的逻辑')
  })
})

describe('一键预设指令（批次6d）', () => {
  function setKey(): void {
    localStorage.setItem(AI_SETTINGS_KEY, JSON.stringify(defaultAiSettings()))
    const stored = JSON.parse(localStorage.getItem(AI_SETTINGS_KEY)!)
    stored.profiles.deepseek.apiKey = 'sk-t'
    localStorage.setItem(AI_SETTINGS_KEY, JSON.stringify(stored))
  }

  it('预设按钮：审查→ask 只读 / 生成介绍→agent，指令下发', async () => {
    setKey()
    clearSession(DOC.id)
    const fetchMock = vi.fn(async () => bodyResponse({ choices: [{ message: { content: '好的' } }] }))
    vi.stubGlobal('fetch', fetchMock)
    const c = renderEl(<AiPanel doc={DOC} selection={{ tab: 'canvas' }} onApplyDoc={vi.fn()} onClose={noop} />)

    // 审查（ask）
    const reviewBtn = [...c.querySelectorAll('.ai-presets button')].find((b) => b.textContent?.includes('审查关卡')) as HTMLButtonElement
    await act(async () => reviewBtn.click())
    await flushUntil(() => c.textContent!.includes('好的'))
    expect(getSession(DOC.id).mode).toBe('ask')
    const body1 = JSON.parse(((fetchMock.mock.calls[0] as unknown[])[1] as { body: string }).body)
    const reviewMsg = body1.messages.at(-1)
    expect(reviewMsg.role).toBe('user')
    expect(reviewMsg.content).toContain('全面审查')

    // 生成介绍（agent）
    const introBtn = [...c.querySelectorAll('.ai-presets button')].find((b) => b.textContent?.includes('生成介绍')) as HTMLButtonElement
    await act(async () => introBtn.click())
    await flushUntil(() => c.textContent!.includes('好的'))
    expect(getSession(DOC.id).mode).toBe('agent')
    const body3 = JSON.parse(((fetchMock.mock.calls[1] as unknown[])[1] as { body: string }).body)
    const introMsg = body3.messages.at(-1)
    expect(introMsg.content).toContain('edit_meta')
  })
})

describe('AI 回复 Markdown 渲染（批次7）', () => {
  function setKey(): void {
    localStorage.setItem(AI_SETTINGS_KEY, JSON.stringify(defaultAiSettings()))
    const stored = JSON.parse(localStorage.getItem(AI_SETTINGS_KEY)!)
    stored.profiles.deepseek.apiKey = 'sk-t'
    localStorage.setItem(AI_SETTINGS_KEY, JSON.stringify(stored))
  }

  it('定稿 assistant 消息渲染 markdown（标题/列表/GFM 表格）', async () => {
    setKey()
    clearSession(DOC.id)
    const md = '# 问题报告\n- 悬空引用\n\n| 列 | 值 |\n| --- | --- |\n| score | 100 |'

    vi.stubGlobal('fetch', vi.fn(async () => bodyResponse({ choices: [{ message: { content: md } }] })))
    const c = renderEl(<AiPanel doc={DOC} selection={{ tab: 'canvas' }} onApplyDoc={vi.fn()} onClose={noop} />)
    await type((c.querySelector('.ai-panel-form textarea') as HTMLTextAreaElement), '审查')
    await act(async () => {
      ;[...c.querySelectorAll('button')].find((b) => b.textContent === '发送')!.click()
    })
    await flushUntil(() => c.querySelector('.ai-md h1') !== null)
    expect(c.querySelector('.ai-md h1')?.textContent).toBe('问题报告')
    expect(c.querySelectorAll('.ai-md li').length).toBeGreaterThan(0)
    expect(c.querySelector('.ai-md table')).toBeTruthy()
  })

  it('XSS 安全：原始 HTML 不被渲染为元素', async () => {
    setKey()
    clearSession(DOC.id)
    const evil = '<script>window.__pwned = 1</script>\n<img src=x onerror="window.__pwned = 2">\n正常文本'
    vi.stubGlobal('fetch', vi.fn(async () => bodyResponse({ choices: [{ message: { content: evil } }] })))
    const c = renderEl(<AiPanel doc={DOC} selection={{ tab: 'canvas' }} onApplyDoc={vi.fn()} onClose={noop} />)
    await type((c.querySelector('.ai-panel-form textarea') as HTMLTextAreaElement), '看')
    await act(async () => {
      ;[...c.querySelectorAll('button')].find((b) => b.textContent === '发送')!.click()
    })
    await flushUntil(() => c.textContent!.includes('正常文本'))
    expect(c.querySelector('.ai-msg-md script')).toBeNull()
    expect(c.querySelector('.ai-msg-md img')).toBeNull()
    expect((window as unknown as { __pwned?: number }).__pwned).toBeUndefined()
  })

  it('流式中为纯文本（无 .ai-md），定稿后才有 markdown 包裹；链接 target=_blank', async () => {
    setKey()
    clearSession(DOC.id)
    let call = 0
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        let payload: unknown
        if (call === 0) {
          // SSE：流式文本 delta（无 markdown），120ms 延迟使中间态可观察
          const enc = new TextEncoder()
          const stream = new ReadableStream<Uint8Array>({
            start(c2) {
              c2.enqueue(enc.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: '链接：' } }] })}\n\n`))
              setTimeout(() => {
                c2.enqueue(enc.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: '[文档](https://example.com/docs)' } }] })}\n\n`))
                c2.enqueue(enc.encode('data: [DONE]\n\n'))
                c2.close()
              }, 120)
            },
          })
          call += 1
          return new Response(stream, { status: 200 })
        }
        payload = { choices: [{ message: { content: '好的' } }] }
        call += 1
        return bodyResponse(payload)
      }),
    )
    const c = renderEl(<AiPanel doc={DOC} selection={{ tab: 'canvas' }} onApplyDoc={vi.fn()} onClose={noop} />)
    await type((c.querySelector('.ai-panel-form textarea') as HTMLTextAreaElement), '发链接')
    await act(async () => {
      ;[...c.querySelectorAll('button')].find((b) => b.textContent === '发送')!.click()
    })
    // 中间态：第一条流式占位（纯文本，无 .ai-md）
    await act(async () => {
      await new Promise((r) => setTimeout(r, 60))
    })
    expect(c.querySelectorAll('.ai-msg-assistant .ai-md')).toHaveLength(0)
    await flushUntil(() => c.querySelectorAll('.ai-msg-assistant .ai-md a').length > 0)
    // 定稿回复中链接安全打开新页
    const link = c.querySelector('.ai-md a[target="_blank"]') as HTMLAnchorElement
    expect(link?.href).toContain('example.com')
  })
})

describe('用户附图（批次8a）', () => {
  function setKey(): void {
    localStorage.setItem(AI_SETTINGS_KEY, JSON.stringify(defaultAiSettings()))
    const stored = JSON.parse(localStorage.getItem(AI_SETTINGS_KEY)!)
    stored.profiles.deepseek.apiKey = 'sk-t'
    localStorage.setItem(AI_SETTINGS_KEY, JSON.stringify(stored))
  }

  /** 构造带 clipboardData.items 的 paste 事件 */
  function pasteEvent(files: File[]): Event {
    const ev = new Event('paste', { bubbles: true, cancelable: true }) as Event & { clipboardData: unknown }
    ev.clipboardData = { items: files.map((f) => ({ type: f.type, getAsFile: () => f })) }
    return ev
  }

  async function attachFile(c: HTMLElement, file: File): Promise<void> {
    const input = c.querySelector('input[type="file"]') as HTMLInputElement
    await act(async () => {
      Object.defineProperty(input, 'files', { value: [file] })
      input.dispatchEvent(new Event('change', { bubbles: true }))
    })
    await flushUntil(() => c.querySelectorAll('.ai-attach-chip').length > 0)
  }

  it('📎 上传附图 → chip + 纯文本模型警告；发送后 user 消息带图（multimodal 下发）', async () => {
    setKey()
    clearSession(DOC.id)
    const fetchMock = vi.fn(async () => bodyResponse({ choices: [{ message: { content: '收到图片。' } }] }))
    vi.stubGlobal('fetch', fetchMock)
    const c = renderEl(<AiPanel doc={DOC} selection={{ tab: 'canvas' }} onApplyDoc={vi.fn()} onClose={noop} />)

    await attachFile(c, new File(['fake-png'], 'shot.png', { type: 'image/png' }))
    // 默认档案 deepseek-chat 属已知纯文本 → 附图警告可见
    expect(c.textContent).toContain('可能不支持图像输入')
    // 无文本但有图：发送按钮可用
    const send = [...c.querySelectorAll('button')].find((b) => b.textContent === '发送') as HTMLButtonElement
    expect(send.disabled).toBe(false)

    await type(c.querySelector('.ai-panel-form textarea') as HTMLTextAreaElement, '看这张图')
    await act(async () => {
      send.click()
    })
    await flushUntil(() => c.textContent!.includes('收到图片。'))

    expect(getSession(DOC.id).messages[0]).toMatchObject({
      role: 'user',
      images: expect.arrayContaining([expect.stringContaining('data:image/png')]),
    })
    const body = JSON.parse(((fetchMock.mock.calls[0] as unknown[])[1] as { body: string }).body)
    const userMsg = body.messages.at(-1)
    expect(Array.isArray(userMsg.content)).toBe(true)
    expect(userMsg.content[1]).toMatchObject({ type: 'image_url' })
    // 面板渲染出图，且发送后 chip 区清空
    expect(c.querySelector('.ai-msg-user img')).toBeTruthy()
    expect(c.querySelectorAll('.ai-attach-chip')).toHaveLength(0)
  })

  it('Ctrl+V 粘贴截图：chip 入列；× 可移除', async () => {
    setKey()
    clearSession(DOC.id)
    vi.stubGlobal('fetch', vi.fn(async () => bodyResponse({ choices: [{ message: { content: '好' } }] })))
    const c = renderEl(<AiPanel doc={DOC} selection={{ tab: 'canvas' }} onApplyDoc={vi.fn()} onClose={noop} />)
    const textarea = c.querySelector('.ai-panel-form textarea') as HTMLTextAreaElement
    await act(async () => {
      textarea.dispatchEvent(pasteEvent([new File(['x'], 'clip.png', { type: 'image/png' })]))
    })
    await flushUntil(() => c.querySelectorAll('.ai-attach-chip').length > 0)
    expect(c.querySelectorAll('.ai-attach-chip')).toHaveLength(1)

    await act(async () => {
      ;(c.querySelector('.ai-attach-del') as HTMLButtonElement).click()
    })
    expect(c.querySelectorAll('.ai-attach-chip')).toHaveLength(0)
  })
})

describe('会话治理（批次8c）', () => {
  function setKey(): void {
    localStorage.setItem(AI_SETTINGS_KEY, JSON.stringify(defaultAiSettings()))
    const stored = JSON.parse(localStorage.getItem(AI_SETTINGS_KEY)!)
    stored.profiles.deepseek.apiKey = 'sk-t'
    localStorage.setItem(AI_SETTINGS_KEY, JSON.stringify(stored))
  }

  it('失败重试：不重复插入 user 消息，续跑成功后错误清除', async () => {
    setKey()
    clearSession(DOC.id)
    let call = 0
    const fetchMock = vi.fn(async () => {
      call += 1
      if (call === 1) {
        return new Response(JSON.stringify({ error: { message: 'quota exceeded' } }), {
          status: 429,
          headers: { 'Content-Type': 'application/json' },
        })
      }
      return bodyResponse({ choices: [{ message: { content: '重试成功。' } }] })
    })
    vi.stubGlobal('fetch', fetchMock)
    const c = renderEl(<AiPanel doc={DOC} selection={{ tab: 'canvas' }} onApplyDoc={vi.fn()} onClose={noop} />)
    await type(c.querySelector('.ai-panel-form textarea') as HTMLTextAreaElement, '帮我看看')
    await act(async () => {
      ;[...c.querySelectorAll('button')].find((b) => b.textContent === '发送')!.click()
    })
    await flushUntil(() => c.querySelector('.ai-panel-error') !== null)
    expect(c.querySelector('.ai-panel-error')?.textContent).toContain('429')
    expect(getSession(DOC.id).messages.filter((m) => m.role === 'user')).toHaveLength(1)

    await act(async () => {
      ;(c.querySelector('.ai-panel-error-retry') as HTMLButtonElement).click()
    })
    await flushUntil(() => c.textContent!.includes('重试成功。'))
    // user 消息没有因重试翻倍；错误条消失
    expect(getSession(DOC.id).messages.filter((m) => m.role === 'user')).toHaveLength(1)
    expect(getSession(DOC.id).error).toBeNull()
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('token 用量脚注：SSE 末块 usage 累计显示（万位缩写 k）', async () => {
    setKey()
    clearSession(DOC.id)
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        bodyResponse({ choices: [{ message: { content: '好' } }], usage: { prompt_tokens: 12000, completion_tokens: 800 } }),
      ),
    )
    const c = renderEl(<AiPanel doc={DOC} selection={{ tab: 'canvas' }} onApplyDoc={vi.fn()} onClose={noop} />)
    await type(c.querySelector('.ai-panel-form textarea') as HTMLTextAreaElement, '嗨')
    await act(async () => {
      ;[...c.querySelectorAll('button')].find((b) => b.textContent === '发送')!.click()
    })
    await flushUntil(() => c.querySelector('.ai-panel-usage') !== null)
    expect(c.querySelector('.ai-panel-usage')?.textContent).toContain('12.0k')
    expect(c.querySelector('.ai-panel-usage')?.textContent).toContain('800')
    expect(getSession(DOC.id).usage).toEqual({ promptTokens: 12000, completionTokens: 800 })
  })
})

describe('撞限续跑（轮数预算）', () => {
  function setKey(): void {
    localStorage.setItem(AI_SETTINGS_KEY, JSON.stringify(defaultAiSettings()))
    const stored = JSON.parse(localStorage.getItem(AI_SETTINGS_KEY)!)
    stored.profiles.deepseek.apiKey = 'sk-t'
    localStorage.setItem(AI_SETTINGS_KEY, JSON.stringify(stored))
  }

  it('撞限后恢复条出现，「▶ 继续」以现有历史续跑（不插新 user 消息，turnCapHit 复位）', async () => {
    setKey()
    clearSession(DOC.id)
    let call = 0
    const fetchMock = vi.fn(async () => {
      call += 1
      if (call <= 32) {
        // agent 模式轮数上限 32：前 32 次请求全部回 tool_calls，直至循环撞限
        return bodyResponse({
          choices: [
            {
              message: {
                content: '',
                tool_calls: [{ index: 0, id: `c${call}`, type: 'function', function: { name: 'read_doc', arguments: '{}' } }],
              },
            },
          ],
        })
      }
      return bodyResponse({ choices: [{ message: { content: '接着跑完了。' } }] })
    })
    vi.stubGlobal('fetch', fetchMock)
    const c = renderEl(<AiPanel doc={DOC} selection={{ tab: 'canvas' }} onApplyDoc={vi.fn()} onClose={noop} />)
    await act(async () => {
      ;[...c.querySelectorAll<HTMLButtonElement>('.ai-mode-tab')].find((b) => b.textContent === 'agent')!.click()
    })
    await type(c.querySelector('.ai-panel-form textarea') as HTMLTextAreaElement, '改点什么')
    await act(async () => {
      ;[...c.querySelectorAll('button')].find((b) => b.textContent === '发送')!.click()
    })
    await flushUntil(() => c.querySelector('.ai-panel-capbar') !== null)
    expect(c.querySelector('.ai-panel-capbar')?.textContent).toContain('轮数上限')
    expect(getSession(DOC.id).turnCapHit).toBe(true)

    await act(async () => {
      ;(c.querySelector('.ai-panel-cap-run') as HTMLButtonElement).click()
    })
    await flushUntil(() => c.textContent!.includes('接着跑完了。'))
    expect(getSession(DOC.id).turnCapHit).toBe(false)
    // user 消息没有因续跑翻倍；恢复条已消失
    expect(getSession(DOC.id).messages.filter((m) => m.role === 'user')).toHaveLength(1)
    expect(c.querySelector('.ai-panel-capbar')).toBeNull()
    // 首轮 32 次请求（撞限）+ 续跑 1 次（文本收尾）
    expect(fetchMock).toHaveBeenCalledTimes(33)
  })
})
