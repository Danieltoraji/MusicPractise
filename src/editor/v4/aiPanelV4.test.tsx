// @vitest-environment jsdom
/**
 * v4 AI 面板（AiPanelV4）测试：实现 renderAiPanel 插槽的最小可用面板。
 *
 * mock 方式参考 src/ai/agent.test.ts / src/editor/ai/aiPanel.test.tsx：stub 全局 fetch（OpenAI 兼容 JSON 响应，
 * v4 agent 循环不启用流式），断言真实链路——发送 → 模型请求工具 → v4 按层工具执行 → 编辑器 onChange
 * 收到经 loadLevelDocV4 校验的文档、且撤销 tag 为 ai:<n>（一次 run 一条撤销步）。
 */
import { act, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { clearSession, getSession } from '../../ai/session'
import { AI_SETTINGS_KEY, defaultAiSettings } from '../../ai/settings'
import { minimalLevelDoc } from '../../engine/v4/fixtures'
import type { LevelDocV4 } from '../../engine/v4/model'
import { loadLevelDocV4 } from '../../library/validate'
import { AiPanelV4 } from './AiPanelV4'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const DOC = minimalLevelDoc()
const DOC_ID = DOC.id
const COPY_ID = `${DOC_ID}_copy`

interface Apply {
  doc: LevelDocV4
  tag?: string
}

const containers: HTMLElement[] = []
const roots: Root[] = []

function byTestId(container: HTMLElement, testId: string): HTMLElement {
  const el = container.querySelector(`[data-testid="${testId}"]`)
  if (!el) throw new Error(`找不到锚点 ${testId}`)
  return el as HTMLElement
}

/**
 * 最小宿主：模拟 EditorPageV4.update 语义——onChange(next, tag) 入撤销栈（tag 表达合并语义）
 * 并同步 revision 自增；面板 props 随 React 渲染更新。
 */
function makeHost(initial: LevelDocV4 = DOC): {
  revision: () => number
  applies: Apply[]
  render: () => React.ReactElement
} {
  const applies: Apply[] = []
  let revision = 0

  function Harness(): React.ReactElement {
    const [doc, setDoc] = useState<LevelDocV4>(initial)
    return (
      <AiPanelV4
        doc={doc}
        revision={revision}
        onChange={(next, tag) => {
          revision += 1
          applies.push({ doc: next, tag })
          setDoc(next)
        }}
      />
    )
  }

  return { revision: () => revision, applies, render: () => <Harness /> }
}

function render(ui: React.ReactElement): HTMLElement {
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
      await new Promise((resolve) => setTimeout(resolve, 10))
    })
  }
}

async function setInput(container: HTMLElement, value: string): Promise<void> {
  await act(async () => {
    const input = byTestId(container, 'v4-ai-input') as HTMLTextAreaElement
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')!.set!
    setter.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

function click(container: HTMLElement, testId: string): void {
  act(() => {
    byTestId(container, testId).click()
  })
}

function setApiKey(): void {
  const settings = defaultAiSettings()
  settings.profiles.deepseek.apiKey = 'sk-test'
  localStorage.setItem(AI_SETTINGS_KEY, JSON.stringify(settings))
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), { status, headers: { 'Content-Type': 'application/json' } })
}

interface FetchBody {
  messages: { role: string; content: string }[]
  tools?: { function: { name: string } }[]
}

function fetchBody(fetchMock: ReturnType<typeof vi.fn>, index: number): FetchBody {
  const call = fetchMock.mock.calls[index] as unknown as [string, { body: string }]
  return JSON.parse(call[1].body) as FetchBody
}

beforeEach(() => {
  localStorage.clear()
  clearSession(DOC_ID)
  clearSession(COPY_ID)
})

afterEach(() => {
  roots.splice(0).forEach((root) => act(() => root.unmount()))
  containers.splice(0).forEach((container) => container.remove())
  vi.unstubAllGlobals()
  clearSession(DOC_ID)
  clearSession(COPY_ID)
})

describe('AiPanelV4（jsdom）', () => {
  it('agent 模式：发送 → 工具调用 → onChange 收到合法文档且 tag 为 ai:<n>（一次 run 一条撤销步）', async () => {
    setApiKey()
    const host = makeHost()
    const responses: unknown[] = [
      {
        choices: [
          {
            message: {
              content: '',
              tool_calls: [
                {
                  id: 'call_1',
                  type: 'function',
                  function: { name: 'edit_meta', arguments: JSON.stringify({ patch: { title: 'AI 新标题' } }) },
                },
                {
                  id: 'call_2',
                  type: 'function',
                  function: { name: 'edit_meta', arguments: JSON.stringify({ patch: { description: 'AI 说明' } }) },
                },
              ],
            },
          },
        ],
      },
      { choices: [{ message: { content: '已改好标题和说明。' } }] },
    ]
    const fetchMock = vi.fn(async () => jsonResponse(responses.shift()))
    vi.stubGlobal('fetch', fetchMock)

    const container = render(host.render())
    await flushUntil(() => container.querySelector('[data-testid="v4-ai-input"]') !== null)
    click(container, 'v4-ai-mode-agent')
    await setInput(container, '把标题和说明改掉')
    click(container, 'v4-ai-send')
    await flushUntil(() => host.applies.length === 2 && !getSession(DOC_ID).busy)

    // 1) 写入经 v4 工具管线落地：文档合法、内容生效
    expect(host.applies).toHaveLength(2)
    expect(host.applies.map((apply) => apply.tag)).toEqual(['ai:1', 'ai:1'])
    const applied = host.applies[host.applies.length - 1].doc
    expect(loadLevelDocV4(applied).ok).toBe(true)
    expect(applied.meta.title).toBe('AI 新标题')
    expect(applied.meta.description).toBe('AI 说明')

    // 2) 工具调用与工具结果折叠展示
    expect(container.textContent).toContain('调用工具：edit_meta')
    expect(container.querySelectorAll('[data-testid="v4-ai-msg-tool"]')).toHaveLength(2)
    expect(container.textContent).toContain('已改好标题和说明。')

    // 3) agent 模式下发写工具（第一轮请求）；第二轮请求为工具结果回填
    const first = fetchBody(fetchMock, 0)
    expect(first.tools?.map((tool) => tool.function.name)).toContain('edit_meta')
    expect(first.tools?.map((tool) => tool.function.name)).toContain('run_level')
    const second = fetchBody(fetchMock, 1)
    expect(second.messages.at(-1)?.role).toBe('tool')
  })

  it('ask 模式：只下发只读工具，不产生任何文档写入', async () => {
    setApiKey()
    const host = makeHost()
    const fetchMock = vi.fn(async () => jsonResponse({ choices: [{ message: { content: '这是只读回答。' } }] }))
    vi.stubGlobal('fetch', fetchMock)

    const container = render(host.render())
    await flushUntil(() => container.querySelector('[data-testid="v4-ai-input"]') !== null)
    await setInput(container, '这个关卡有哪些题型？')
    click(container, 'v4-ai-send')
    await flushUntil(() => !getSession(DOC_ID).busy && getSession(DOC_ID).messages.length >= 2)

    expect(host.applies).toHaveLength(0)
    const toolNames = fetchBody(fetchMock, 0).tools?.map((tool) => tool.function.name) ?? []
    expect(toolNames).toContain('read_doc')
    expect(toolNames).not.toContain('edit_meta')
    expect(toolNames).not.toContain('edit_table')
    expect(container.textContent).toContain('这是只读回答。')
  })

  it('run_level 工具在面板链路里可用：工具结果折叠展示 score/passed', async () => {
    setApiKey()
    const host = makeHost()
    const responses: unknown[] = [
      {
        choices: [
          {
            message: {
              content: '',
              tool_calls: [
                {
                  id: 'call_run',
                  type: 'function',
                  function: { name: 'run_level', arguments: '{}' },
                },
              ],
            },
          },
        ],
      },
      { choices: [{ message: { content: '试跑完成：score=0，未通过。' } }] },
    ]
    const fetchMock = vi.fn(async () => jsonResponse(responses.shift()))
    vi.stubGlobal('fetch', fetchMock)

    const container = render(host.render())
    await flushUntil(() => container.querySelector('[data-testid="v4-ai-input"]') !== null)
    click(container, 'v4-ai-mode-agent')
    await setInput(container, '试跑一下这个关卡')
    click(container, 'v4-ai-send')
    await flushUntil(() => !getSession(DOC_ID).busy && getSession(DOC_ID).messages.some((msg) => msg.role === 'tool'))

    const toolMsg = getSession(DOC_ID).messages.find((msg) => msg.role === 'tool')
    expect(toolMsg?.content).toContain('流程已结束')
    expect(toolMsg?.content).toContain('score=0 passed=false')
    expect(byTestId(container, 'v4-ai-msg-tool').textContent).toContain('run_level')
    expect(host.applies).toHaveLength(0) // 只读诊断不产生文档写入
  })

  it('错误可读：HTTP 500 映射为中文错误 + 重试/关闭按钮', async () => {
    setApiKey()
    const host = makeHost()
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ error: { message: 'upstream boom' } }, 500)))

    const container = render(host.render())
    await flushUntil(() => container.querySelector('[data-testid="v4-ai-input"]') !== null)
    await setInput(container, '改标题')
    click(container, 'v4-ai-send')
    await flushUntil(() => getSession(DOC_ID).error !== null && !getSession(DOC_ID).busy)

    const errorText = byTestId(container, 'v4-ai-error-text').textContent ?? ''
    expect(errorText).toContain('供应商服务端错误（500）')
    expect(errorText).toContain('upstream boom')
    expect(byTestId(container, 'v4-ai-retry')).toBeTruthy()

    click(container, 'v4-ai-error-close')
    await flushUntil(() => getSession(DOC_ID).error === null)
    expect(container.querySelector('[data-testid="v4-ai-error"]')).toBeNull()
  })

  it('停止：运行中「停止」中断本轮，错误显示「已停止」且输入区恢复', async () => {
    setApiKey()
    const host = makeHost()
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_url: unknown, init?: { signal?: AbortSignal }) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')))
          }),
      ),
    )

    const container = render(host.render())
    await flushUntil(() => container.querySelector('[data-testid="v4-ai-input"]') !== null)
    click(container, 'v4-ai-mode-agent')
    await setInput(container, '改标题')
    click(container, 'v4-ai-send')
    await flushUntil(() => getSession(DOC_ID).busy)
    expect(container.querySelector('[data-testid="v4-ai-stop"]')).toBeTruthy()

    click(container, 'v4-ai-stop')
    await flushUntil(() => !getSession(DOC_ID).busy)

    expect(getSession(DOC_ID).error).toContain('已停止')
    expect(byTestId(container, 'v4-ai-error-text').textContent).toContain('已停止')
    expect(container.querySelector('[data-testid="v4-ai-send"]')).toBeTruthy()
  })

  it('未配置 Key：显示前往设置引导且发送禁用', async () => {
    const host = makeHost()
    const container = render(host.render())
    await flushUntil(() => container.querySelector('[data-testid="v4-ai-input"]') !== null)
    expect(byTestId(container, 'v4-ai-nokey').textContent).toContain('前往设置')
    expect((byTestId(container, 'v4-ai-send') as HTMLButtonElement).disabled).toBe(true)
    expect(host.applies).toHaveLength(0)
  })

  it('文档身份迁移（另存副本换 id）：会话随 doc.id 迁移到新 id', async () => {
    setApiKey()
    const applies: Apply[] = []
    let revision = 0
    let setDocExternal: ((doc: LevelDocV4) => void) | null = null

    function Wrapper(): React.ReactElement {
      const [doc, setDoc] = useState<LevelDocV4>(DOC)
      setDocExternal = setDoc
      return (
        <AiPanelV4
          doc={doc}
          revision={revision}
          onChange={(next, tag) => {
            revision += 1
            applies.push({ doc: next, tag })
            setDoc(next)
          }}
        />
      )
    }

    const fetchMock = vi.fn(async () => jsonResponse({ choices: [{ message: { content: '好的。' } }] }))
    vi.stubGlobal('fetch', fetchMock)

    const container = render(<Wrapper />)
    await flushUntil(() => container.querySelector('[data-testid="v4-ai-input"]') !== null)
    await setInput(container, '你好')
    click(container, 'v4-ai-send')
    await flushUntil(() => !getSession(DOC_ID).busy && getSession(DOC_ID).messages.length >= 2)
    const messageCount = getSession(DOC_ID).messages.length

    // 内置示例另存副本：同一面板实例收到新 doc.id（宿主换 id 后重渲染）
    await act(async () => {
      setDocExternal?.({ ...DOC, id: COPY_ID })
      await new Promise((resolve) => setTimeout(resolve, 40))
    })

    expect(getSession(COPY_ID).messages.length).toBe(messageCount)
    expect(getSession(DOC_ID).messages.length).toBe(0)
  })
})
