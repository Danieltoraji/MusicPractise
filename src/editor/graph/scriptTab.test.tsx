// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { LevelDoc } from '../../engine/level'
import { ScriptTab } from './ScriptTab'

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

afterEach(() => {
  roots.splice(0).forEach((r) => act(() => r.unmount()))
  containers.splice(0).forEach((c) => c.remove())
})

const baseDoc = (id = 'res_x'): LevelDoc =>
  ({
    schemaVersion: 1,
    kind: 'level',
    id,
    version: '0.1.0',
    meta: { title: '脚本页测试' },
    refs: [],
    content: {
      components: [{ id: 'sound1', type: 'sound', visible: false }],
      logic: {
        logicVersion: 2,
        variables: { score: 0 },
        nodes: [
          { id: 'on1', kind: 'on', event: 'level.started' },
          { id: 'as1', kind: 'assign', target: 'score', value: { expr: '0' } },
        ],
        edges: [{ id: 'e1', from: 'on1', to: 'as1' }],
      },
      questions: [{ id: 'q1', data: {}, scoring: { max: 10 } }],
      flow: {},
    },
  }) as unknown as LevelDoc

const textarea = (container: HTMLElement): HTMLTextAreaElement => container.querySelector('.script-editor')!

describe('ScriptTab（jsdom）', () => {
  it('进入即生成脚本（含事件处理器与变量保留说明）', () => {
    const container = renderEl(<ScriptTab doc={baseDoc('res_s1')} onChange={() => {}} />)
    const ta = textarea(container)
    expect(ta.value).toContain('on level.started {')
    expect(ta.value).toContain('v.score = 0')
  })

  it('编辑后应用：脚本解析回 IR 并回写 doc（变量保留、节点重建）', () => {
    let doc = baseDoc('res_s2')
    const onChange = vi.fn((next: LevelDoc) => {
      doc = next
    })
    const container = renderEl(<ScriptTab doc={doc} onChange={onChange} />)
    const ta = textarea(container)
    const nextText = `${ta.value}\non app:extra {\n  wait (250)\n}`
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')!.set!
      setter.call(ta, nextText)
      ta.dispatchEvent(new Event('input', { bubbles: true }))
    })
    const applyBtn = [...container.querySelectorAll('button')].find((b) => b.textContent === '应用到节点图')!
    act(() => (applyBtn as HTMLElement).click())
    expect(onChange).toHaveBeenCalled()
    const logic = doc.content.logic
    expect(logic.nodes.some((n) => n.kind === 'on' && n.event === 'app:extra')).toBe(true)
    expect(logic.nodes.some((n) => n.kind === 'wait')).toBe(true)
    // 变量保留
    expect(logic.variables).toEqual({ score: 0 })
    // id 前缀 s（脚本来源可辨识）
    expect(logic.nodes.every((n) => n.id.startsWith('s'))).toBe(true)
    // 应用提示出现
    expect(container.textContent).toContain('已应用')
  })

  it('语法错误：显示行列错误且 doc 不被修改', () => {
    const doc = baseDoc('res_s3')
    const onChange = vi.fn()
    const container = renderEl(<ScriptTab doc={doc} onChange={onChange} />)
    const ta = textarea(container)
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')!.set!
      setter.call(ta, `${ta.value}\non app:bad {\n  v.x = \n}`)
      ta.dispatchEvent(new Event('input', { bubbles: true }))
    })
    const applyBtn = [...container.querySelectorAll('button')].find((b) => b.textContent === '应用到节点图')!
    act(() => (applyBtn as HTMLElement).click())
    expect(onChange).not.toHaveBeenCalled()
    const err = container.querySelector('.script-error')
    expect(err?.textContent).toContain('解析失败')
    expect(err?.textContent).toMatch(/第 \d+ 行/)
  })

  it('P1 回归：本地脏文本 + 外部 IR 变更 → 重挂后草稿保留、陈旧黄条双按钮出现；重新生成对齐新 IR 且黄条消失', () => {
    let doc = baseDoc('res_s4')
    const onChange = vi.fn((next: LevelDoc) => {
      doc = next
    })
    const container = renderEl(<ScriptTab doc={doc} onChange={onChange} />)
    const ta = textarea(container)
    // 本地编辑（脏）
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')!.set!
      setter.call(ta, `${ta.value}\n// local edit`)
      ta.dispatchEvent(new Event('input', { bubbles: true }))
    })
    // 外部 IR 变更（模拟节点图改动）：卸载重挂新 doc（与父组件 key=hash 行为一致）
    const changed = {
      ...doc,
      content: {
        ...doc.content,
        logic: {
          ...doc.content.logic,
          nodes: [...doc.content.logic.nodes, { id: 'on2', kind: 'on', event: 'app:tick' }],
        },
      },
    } as LevelDoc
    // Tab 切换 = 卸载重挂：用新 container 模拟（同 root 重渲染不会重新初始化 state）
    const container2 = renderEl(<ScriptTab doc={changed} onChange={onChange} />)
    // 草稿跨 Tab 存活
    expect(textarea(container2).value).toContain('// local edit')
    // 陈旧黄条 + 双按钮出现
    expect(container2.querySelector('.script-stale')).toBeTruthy()
    const buttons = [...container2.querySelectorAll('.script-stale button')].map((b) => b.textContent)
    expect(buttons).toEqual(['重新生成（对齐节点图）', '仍要应用当前文本（覆盖节点图）'])
    // 重新生成 → 对齐新 IR、黄条消失
    const regenBtn = [...container2.querySelectorAll('.script-stale button')].find((b) => b.textContent!.includes('重新生成'))!
    act(() => (regenBtn as HTMLElement).click())
    expect(textarea(container2).value).toContain('on app:tick')
    expect(container2.querySelector('.script-stale')).toBeNull()
  })

  it('P1 回归：陈旧但文本干净 → 黄条出现且应用按钮禁用（防一键静默覆盖新 IR）', () => {
    // 第一阶段：挂载生成基线缓存；第二阶段：外部改 IR 后同 id 重挂 → 判定陈旧
    const changed = {
      ...baseDoc('res_s5'),
      content: {
        ...baseDoc('res_s5').content,
        logic: {
          ...baseDoc('res_s5').content.logic,
          nodes: [...baseDoc('res_s5').content.logic.nodes, { id: 'on2', kind: 'on', event: 'app:tick' }],
        },
      },
    } as LevelDoc
    const first = renderEl(<ScriptTab doc={baseDoc('res_s5')} onChange={() => {}} />)
    // Tab 切换 = 卸载重挂（新 container）：重新判定 irStale
    void first
    const container2 = renderEl(<ScriptTab doc={changed} onChange={() => {}} />)
    console.log('[s5-debug]', JSON.stringify(container2.textContent.slice(0, 150)))
    expect(container2.querySelector('.script-stale')).toBeTruthy()
    const applyBtn = [...container2.querySelectorAll('button')].find((b) => b.textContent === '应用到节点图') as HTMLButtonElement
    expect(applyBtn.disabled).toBe(true)
  })

  it('P0 回归：非结构化图（多路径汇入）进入脚本页不白屏，显示可读降级错误并禁用编辑', () => {
    // branch 两臂汇到 Z，Z 语义上再往下走——generateScript 对「多路径汇入」抛错
    const doc = baseDoc('res_s6')
    const logic = doc.content.logic as unknown as { nodes: unknown[]; edges: unknown[] }
    logic.nodes = [
      { id: 'on1', kind: 'on', event: 'level.started' },
      { id: 'br', kind: 'branch', cond: 'v.go' },
      { id: 'c1', kind: 'call', target: 'sound1', method: 'play', args: [] },
      { id: 'c2', kind: 'call', target: 'sound1', method: 'stop', args: [] },
      { id: 'z1', kind: 'assign', target: 'score', value: { expr: '2' } },
    ]
    logic.edges = [
      { id: 'e1', from: 'on1', to: 'br' },
      { id: 'e2', from: 'br', to: 'c1', port: 'true' },
      { id: 'e3', from: 'br', to: 'c2', port: 'false' },
      { id: 'e4', from: 'c1', to: 'z1' },
      { id: 'e5', from: 'c2', to: 'z1' },
      { id: 'e6', from: 'z1', to: 'c1' }, // Z 回跳臂内 = 跨结构汇入，generateScript 抛错
    ]
    const container = renderEl(<ScriptTab doc={doc} onChange={() => {}} />)
    // 不白屏：降级错误卡可读
    expect(container.querySelector('.script-error')?.textContent).toContain('超出伪代码')
    // 编辑区禁用、应用禁用
    expect((textarea(container) as HTMLTextAreaElement).disabled).toBe(true)
    const applyBtn = [...container.querySelectorAll('button')].find((b) => b.textContent === '应用到节点图') as HTMLButtonElement
    expect(applyBtn.disabled).toBe(true)
  })

  it('Tab 键插入两空格', () => {
    const container = renderEl(<ScriptTab doc={baseDoc('res_s1')} onChange={() => {}} />)
    const ta = textarea(container)
    act(() => {
      ta.focus()
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')!.set!
      setter.call(ta, 'abc')
      ta.dispatchEvent(new Event('input', { bubbles: true }))
      ta.setSelectionRange(3, 3)
      ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }))
    })
    expect(ta.value).toBe('abc  ')
    expect(ta.selectionStart).toBe(5)
  })
})
