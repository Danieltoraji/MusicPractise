// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { describe, expect, it } from 'vitest'
import type { LevelDoc } from '../engine/level'
import { checkExprText } from './EditorPage'
import { TableEditor } from './TableGrid'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const baseDoc = (): LevelDoc => ({
  schemaVersion: 3,
  kind: 'level',
  id: 'res_01J9A0A0A0A0A0A0A0A0A0A0A1',
  version: '0.1.0',
  meta: { title: '编辑器测试' },
  refs: [],
  content: {
    views: [{ id: 'main', name: '主视图' }],
    components: [{ id: 'staff1', type: 'staff', visible: true, view: 'main' }],
    logic: {
      logicVersion: 2,
      variables: { score: 0 },
      nodes: [
        { id: 'on_click', kind: 'on', event: 'staff1.noteClicked' },
        { id: 'add', kind: 'assign', target: 'score', value: { expr: 'v.score + 1' } },
      ],
      edges: [{ id: 'e1', from: 'on_click', to: 'add' }],
    },
    table: {
      columns: [
        { key: 'data', label: '数据' },
        { key: 'scoring', label: '分值' },
      ],
      rows: [{ data: { a: 1 }, scoring: { max: 10 } }],
    },
    flow: {},
  },
})

describe('TableEditor（jsdom 渲染）', () => {
  it('渲染数据表网格：列头（列名/类型）与行头（题号）', () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    let root!: Root
    act(() => {
      root = createRoot(container)
      root.render(<TableEditor doc={baseDoc()} onChange={() => {}} />)
    })
    try {
      expect(container.textContent).toContain('题目数据表')
      // 网格：行头题号 1（= v.__row 值）、列类型下拉、单元格输入
      expect(container.querySelectorAll('.tgrid tbody tr').length).toBeGreaterThanOrEqual(1)
      expect(container.querySelectorAll('.tgrid-type').length).toBeGreaterThanOrEqual(1)
      expect(container.querySelector('.tgrid-rownum')?.textContent).toBe('1')
      expect(container.querySelectorAll('input').length).toBeGreaterThanOrEqual(3)
    } finally {
      act(() => root.unmount())
      container.remove()
    }
  })

  it('notes 列单元格渲染五线谱迷你谱+弹窗编辑；类型切换与单元格提交走 onChange', () => {
    const doc = baseDoc()
    doc.content.table = {
      columns: [
        { key: 'title', label: '题面', type: 'text' },
        { key: 'notes', label: '示例音符', type: 'notes' },
        { key: 'locked', label: '是否加锁', type: 'boolean' },
      ],
      rows: [{ title: '行一', notes: [{ midi: 60, dur: '4n' }], locked: false }],
    }
    let current = doc
    const container = document.createElement('div')
    document.body.appendChild(container)
    let root!: Root
    const rerender = (): void => {
      act(() => root.render(<TableEditor doc={current} onChange={(n) => { current = n }} />))
    }
    act(() => {
      root = createRoot(container)
      rerender()
    })
    try {
      // notes 单元格：五线谱迷你预览（svg），不出现 JSON 文本（docs/27）
      const noteCell = container.querySelector('.tcell-notes')!
      expect(noteCell.querySelector('.tstaff .tstaff-svg svg')).not.toBeNull()
      expect(noteCell.textContent).not.toContain('midi')
      // 点击迷你谱 → 弹窗编辑器打开（谱面 + 工具条）；应用走 notesToCell 受控写回
      act(() => {
        ;(noteCell.querySelector('.tstaff') as HTMLElement).click()
      })
      const modal = container.querySelector('.staff-modal')!
      expect(modal).not.toBeNull()
      expect(modal.querySelectorAll('svg > g.vf-stavenote').length).toBe(1)
      act(() => {
        ;[...modal.querySelectorAll('button')].find((b) => b.textContent === '应用')!.click()
      })
      expect(current.content.table.rows[0].notes).toEqual([{ midi: 60, dur: '4n' }])
      // 文本单元格：输入即提交（受控写回）
      const textInput = container.querySelector('.tcell-text .tgrid-input') as HTMLInputElement
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!
      act(() => {
        setter.call(textInput, '改过的题面')
        textInput.dispatchEvent(new Event('input', { bubbles: true }))
      })
      expect(current.content.table.rows[0].title).toBe('改过的题面')
      // 布尔单元格：勾选提交
      const checkbox = container.querySelector('.tcell-boolean input') as HTMLInputElement
      act(() => {
        checkbox.click()
      })
      expect(current.content.table.rows[0].locked).toBe(true)
    } finally {
      act(() => root.unmount())
      container.remove()
    }
  })

  it('list 列单元格：摘要按钮 + 弹窗条目编辑（不再内联 chips/编辑 JSON）', () => {
    const doc = baseDoc()
    doc.content.table = {
      columns: [{ key: 'options', label: '选项', type: 'list' }],
      rows: [{ options: ['C 大调', 'G 大调'] }],
    }
    let current = doc
    const container = document.createElement('div')
    document.body.appendChild(container)
    let root!: Root
    const rerender = (): void => {
      act(() => root.render(<TableEditor doc={current} onChange={(n) => { current = n }} />))
    }
    act(() => {
      root = createRoot(container)
      rerender()
    })
    try {
      // 单元格是摘要按钮（内容 + 条数），不再出现内联输入或「编辑 JSON」
      const cell = container.querySelector('.tcell-list')!
      expect(cell.querySelector('.tlist-open')).not.toBeNull()
      expect(cell.querySelector('.tlist-summary')?.textContent).toContain('C 大调、G 大调')
      expect(cell.querySelector('input')).toBeNull()
      expect(cell.textContent).toContain('2 项')
      // 点击 → 弹窗（两条目）；添加一条并输入，应用后受控写回 string[]
      act(() => {
        ;(cell.querySelector('.tlist-open') as HTMLElement).click()
      })
      const modal = container.querySelector('.tlist-modal')!
      expect(modal.querySelectorAll('.tlist-row').length).toBe(2)
      act(() => {
        ;[...modal.querySelectorAll('button')].find((b) => b.textContent === '+ 添加条目')!.click()
      })
      const inputs = modal.querySelectorAll('.tlist-row input')
      expect(inputs.length).toBe(3)
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!
      act(() => {
        setter.call(inputs[2], 'D 大调')
        inputs[2].dispatchEvent(new Event('input', { bubbles: true }))
      })
      act(() => {
        ;[...modal.querySelectorAll('button')].find((b) => b.textContent === '应用')!.click()
      })
      expect(current.content.table.rows[0].options).toEqual(['C 大调', 'G 大调', 'D 大调'])
      expect(container.querySelector('.tlist-modal')).toBeNull()
    } finally {
      act(() => root.unmount())
      container.remove()
    }
  })

  it('list 列旧脏数据（数字数组）也进弹窗：条目文本化可编辑，无 JSON 死角', () => {
    const doc = baseDoc()
    doc.content.table = {
      columns: [{ key: 'options', label: '选项', type: 'list' }],
      rows: [{ options: [1, 2] }],
    }
    let current = doc
    const container = document.createElement('div')
    document.body.appendChild(container)
    let root!: Root
    const rerender = (): void => {
      act(() => root.render(<TableEditor doc={current} onChange={(n) => { current = n }} />))
    }
    act(() => {
      root = createRoot(container)
      rerender()
    })
    try {
      const cell = container.querySelector('.tcell-list')!
      expect(cell.textContent).not.toContain('编辑 JSON')
      act(() => {
        ;(cell.querySelector('.tlist-open') as HTMLElement).click()
      })
      const modal = container.querySelector('.tlist-modal')!
      const inputs = modal.querySelectorAll('.tlist-row input')
      expect(inputs.length).toBe(2)
      expect((inputs[0] as HTMLInputElement).value).toBe('1')
      act(() => {
        ;[...modal.querySelectorAll('button')].find((b) => b.textContent === '应用')!.click()
      })
      expect(current.content.table.rows[0].options).toEqual(['1', '2'])
    } finally {
      act(() => root.unmount())
      container.remove()
    }
  })

  it('notes 列非标准旧数据：琥珀修复按钮进五线谱弹窗，从文本导入后替换', () => {
    const doc = baseDoc()
    doc.content.table = {
      columns: [{ key: 'notes', label: '示例音符', type: 'notes' }],
      rows: [{ notes: 'C4:4n E4:4n' }], // 类型切换前遗留的字符串形态
    }
    let current = doc
    const container = document.createElement('div')
    document.body.appendChild(container)
    let root!: Root
    const rerender = (): void => {
      act(() => root.render(<TableEditor doc={current} onChange={(n) => { current = n }} />))
    }
    act(() => {
      root = createRoot(container)
      rerender()
    })
    try {
      const cell = container.querySelector('.tcell-notes')!
      // 不再是「编辑 JSON」兜底，而是琥珀修复入口
      expect(cell.textContent).not.toContain('编辑 JSON')
      expect(cell.querySelector('.tstaff-fix')).not.toBeNull()
      // 点击 → 五线谱弹窗（带不合规警示条与导入面板）
      act(() => {
        ;(cell.querySelector('.tstaff-fix') as HTMLElement).click()
      })
      const modal = container.querySelector('.staff-modal')!
      expect(modal).not.toBeNull()
      expect(modal.querySelector('.staff-import-warn')?.textContent).toContain('不是标准音符数组')
      // 展开导入面板，输入紧凑记法并导入
      const details = modal.querySelector('details.staff-import') as HTMLDetailsElement
      act(() => {
        details.open = true
      })
      const importInput = details.querySelector('input') as HTMLInputElement
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!
      act(() => {
        setter.call(importInput, 'C4 E4:8n')
        importInput.dispatchEvent(new Event('input', { bubbles: true }))
      })
      act(() => {
        ;[...details.querySelectorAll('button')].find((b) => b.textContent === '导入')!.click()
      })
      // 导入成功：谱面出现两个音符；非法记法则报错且不动草稿
      expect(modal.querySelectorAll('svg > g.vf-stavenote').length).toBe(2)
      act(() => {
        setter.call(importInput, 'C4 H9')
        importInput.dispatchEvent(new Event('input', { bubbles: true }))
      })
      act(() => {
        ;[...details.querySelectorAll('button')].find((b) => b.textContent === '导入')!.click()
      })
      expect(details.querySelector('.tone-error')?.textContent).toContain('无法解析')
      // 应用 → 原字符串被标准音符数组替换
      act(() => {
        ;[...modal.querySelectorAll('button')].find((b) => b.textContent === '应用')!.click()
      })
      expect(current.content.table.rows[0].notes).toEqual([
        { midi: 60, dur: '4n' },
        { midi: 64, dur: '8n' },
      ])
    } finally {
      act(() => root.unmount())
      container.remove()
    }
  })
})

describe('checkExprText（表达式实时校验）', () => {
  it('合法表达式返回 null', () => {
    expect(checkExprText('v.score + 1')).toBeNull()
    expect(checkExprText('')).toBeNull()
    expect(checkExprText('{notes: [{midi: 60}]}')).toBeNull()
  })
  it('语法错误返回消息', () => {
    expect(checkExprText('v.score +')).not.toBeNull()
  })
})

describe('FlowEditor（批次10 推进与过关）', () => {
  /** 挂 TableEditor 并模拟 EditorPage 的重渲染：onChange 更新 doc 后立即以新 props 重渲染 */
  function renderFlow(initial: LevelDoc): { c: HTMLElement; doc: () => LevelDoc; restore: () => void } {
    let doc = initial
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    const rerender = (): void => {
      act(() => {
        root.render(<TableEditor doc={doc} onChange={(next) => { doc = next; rerender() }} />)
      })
    }
    rerender()
    return { c: container, doc: () => doc, restore: () => { act(() => root.unmount()); container.remove() } }
  }

  /** 受控 input 赋值 */
  function type(el: HTMLInputElement, value: string): void {
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!
      setter.call(el, value)
      el.dispatchEvent(new Event('input', { bubbles: true }))
    })
  }

  /** React onBlur 在 jsdom 需以冒泡的 focusout 派发（仓库惯例，variablesPanel.test 同款） */
  function blur(el: HTMLElement): void {
    act(() => el.dispatchEvent(new FocusEvent('focusout', { bubbles: true })))
  }

  it('渲染编辑条：顺序下拉/题数/过关条件勾选 + 摘要', () => {
    const doc = baseDoc()
    doc.content.flow = { order: 'sequential', pass: { expr: 'v.score >= 10' } }
    const { c, restore } = renderFlow(doc)
    try {
      expect(c.textContent).toContain('推进与过关')
      const sel = c.querySelector('.flow-editor select') as HTMLSelectElement
      expect(sel.value).toBe('sequential')
      const check = c.querySelector('.flow-field-check input') as HTMLInputElement
      expect(check.checked).toBe(true)
      // 勾选态显示条件构造器与摘要
      expect(c.querySelector('.flow-pass .cond-b')).not.toBeNull()
      expect(c.querySelector('.flow-summary')?.textContent).toContain('v.score >= 10')
    } finally {
      restore()
    }
  })

  it('切换顺序回写；题数清空失焦 = 删键（全部）', () => {
    const { c, doc, restore } = renderFlow(baseDoc())
    try {
      const sel = c.querySelector('.flow-editor select') as HTMLSelectElement
      act(() => {
        sel.value = 'shuffle'
        sel.dispatchEvent(new Event('change', { bubbles: true }))
      })
      expect(doc().content.flow?.order).toBe('shuffle')

      const countInput = c.querySelector('.flow-field input[type="number"]') as HTMLInputElement
      expect(countInput.value).toBe('') // baseDoc 无 count → placeholder 全部
      type(countInput, '5')
      blur(countInput)
      expect(doc().content.flow?.count).toBe(5)
      type(countInput, '')
      blur(countInput)
      expect('count' in (doc().content.flow ?? {})).toBe(false)
    } finally {
      restore()
    }
  })

  it('B4 回归：同值失焦不写 doc——「本局题数」聚焦再失焦不再把未修改的关卡标脏', () => {
    const initial = baseDoc()
    initial.content.flow = { count: 5 }
    const { c, doc, restore } = renderFlow(initial)
    try {
      const countInput = c.querySelector('.flow-field input[type="number"]') as HTMLInputElement
      expect(countInput.value).toBe('5')
      const before = doc()
      blur(countInput) // 未修改任何值直接失焦
      expect(doc()).toBe(before) // onChange 未被调用（修复前：无脑 patchFlow → 标脏并入撤销栈）
    } finally {
      restore()
    }
  })

  it('取消勾选 = 删除 pass 键；重新勾选给种子表达式', () => {
    const initial = baseDoc()
    initial.content.flow = { pass: { expr: 'v.score >= 10' } }
    const { c, doc, restore } = renderFlow(initial)
    try {
      const check = c.querySelector('.flow-field-check input') as HTMLInputElement
      act(() => { check.click() })
      expect('pass' in (doc().content.flow ?? {})).toBe(false)
      expect(c.querySelector('.flow-pass')).toBeNull()

      act(() => { check.click() })
      expect((doc().content.flow?.pass as { expr: string }).expr).toContain('v.score')
    } finally {
      restore()
    }
  })

  it('高级模式非法表达式：红字提示且不写 doc', () => {
    const initial = baseDoc()
    initial.content.flow = { pass: { expr: 'v.score >= 10' } }
    const { c, doc, restore } = renderFlow(initial)
    try {
      const adv = [...c.querySelectorAll('.flow-pass .opv-modes button')].find((b) => b.textContent === '高级') as HTMLElement
      act(() => adv.dispatchEvent(new MouseEvent('click', { bubbles: true })))
      const exprInput = c.querySelector('.flow-pass input') as HTMLInputElement
      type(exprInput, 'v.score >= ')
      blur(exprInput)
      expect(c.querySelector('.flow-editor .tone-error')?.textContent).not.toBeNull()
      expect((doc().content.flow?.pass as { expr: string }).expr).toBe('v.score >= 10') // doc 未被污染
    } finally {
      restore()
    }
  })
})
