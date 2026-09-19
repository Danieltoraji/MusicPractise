import { describe, expect, it, vi } from 'vitest'
import type { ComponentInstance } from '../engine/level'
import { ComponentStore } from './store'

const spec = (id: string, type: string, extra: Partial<ComponentInstance> = {}): ComponentInstance => ({
  id,
  type,
  ...extra,
})

describe('ComponentStore', () => {
  it('init 建立初始状态（label 来自 props.text）', () => {
    const store = new ComponentStore()
    store.init([spec('t1', 'label', { props: { text: '你好' } })])
    expect(store.snapshot('t1').state).toEqual({ text: '你好', tone: 'info' })
    expect(store.snapshot('t1').version).toBe(0)
  })

  it('applyCommand 变更状态并 bump 版本、通知订阅者', () => {
    const store = new ComponentStore()
    store.init([spec('b1', 'button', { props: { text: 'go', enabled: false } })])
    const listener = vi.fn()
    store.subscribe(listener)

    const before = store.snapshot('b1').version
    const effects = store.applyCommand('b1', 'setEnabled', { enabled: true })
    expect(effects).toEqual([])
    expect(store.snapshot('b1').state).toEqual({ text: 'go', enabled: true })
    expect(store.snapshot('b1').version).toBe(before + 1)
    expect(listener).toHaveBeenCalled()
  })

  it('基座命令：非契约组件的 setVisible/setEnabled 写状态位；契约组件自有命令优先', () => {
    const store = new ComponentStore()
    store.init([spec('l1', 'label'), spec('b1', 'button', { props: { text: 'go' } })])
    // label 无自有命令 → 基座拦截
    store.applyCommand('l1', 'setVisible', { visible: false })
    expect(store.snapshot('l1').state).toMatchObject({ __visible: false })
    store.applyCommand('l1', 'setEnabled', { enabled: false })
    expect(store.snapshot('l1').state).toMatchObject({ __enabled: false })
    // button 自带 setEnabled → 组件命令优先（写 enabled，不写 __enabled）
    store.applyCommand('b1', 'setEnabled', { enabled: false })
    expect(store.snapshot('b1').state).toEqual({ text: 'go', enabled: false })
    // setVisible 对 button 走基座（button 契约无 setVisible）
    store.applyCommand('b1', 'setVisible', { visible: false })
    expect(store.snapshot('b1').state).toMatchObject({ __visible: false, enabled: false })
  })

  it('query：契约查询方法读取组件状态；未实现查询抛错', () => {
    const store = new ComponentStore()
    store.init([spec('i1', 'input'), spec('s1', 'sound')])
    expect(store.query('i1', 'getValue', [])).toBe('')
    store.applyCommand('i1', 'setValue', { value: 'abc' })
    expect(store.query('i1', 'getValue', [])).toBe('abc')
    expect(() => store.query('s1', 'getValue', [])).toThrow(/不支持查询/)
    expect(() => store.query('ghost', 'getValue', [])).toThrow(/不存在/)
  })

  it('sound.play 产出 audio.play 效果（含 tempo 与 mode）', () => {
    const store = new ComponentStore()
    store.init([spec('s1', 'sound')])
    const effects = store.applyCommand('s1', 'play', { notes: [{ midi: 60 }], tempo: 120 })
    expect(effects).toEqual([{ type: 'audio.play', notes: [{ midi: 60 }], tempo: 120, mode: 'chord' }])
    const seq = store.applyCommand('s1', 'play', { notes: [{ midi: 60 }], mode: 'seq' })
    expect(seq).toEqual([{ type: 'audio.play', notes: [{ midi: 60 }], mode: 'seq' }])
  })

  it('timer：start 产出效果、__tick 更新计数、stop 停止', () => {
    const store = new ComponentStore()
    store.init([spec('t1', 'timer')])
    const effects = store.applyCommand('t1', 'start', { ms: 500, repeat: true })
    expect(effects).toEqual([{ type: 'timer.start', ms: 500, repeat: true }])
    expect(store.snapshot('t1').state).toMatchObject({ running: true, count: 0 })
    store.applyCommand('t1', '__tick', { count: 1 })
    expect(store.snapshot('t1').state).toMatchObject({ count: 1 })
    const stop = store.applyCommand('t1', 'stop', {})
    expect(stop).toEqual([{ type: 'timer.stop' }])
    expect(store.snapshot('t1').state).toMatchObject({ running: false })
  })

  it('applyBinding 走组件定义（choice.options）', () => {
    const store = new ComponentStore()
    store.init([spec('c1', 'choice')])
    store.applyBinding('c1', 'options', ['甲', '乙'])
    expect(store.snapshot('c1').state).toEqual({ options: ['甲', '乙'], revealed: null })
  })

  it('resetAll 回到初始状态', () => {
    const store = new ComponentStore()
    store.init([
      spec('l1', 'label'),
      spec('b1', 'button', { props: { text: 'x', enabled: true } }),
    ])
    store.applyCommand('l1', 'show', { text: 'changed', tone: 'error' })
    store.applyCommand('b1', 'setText', { text: 'changed' })
    store.resetAll()
    expect(store.snapshot('l1').state).toEqual({ text: '', tone: 'info' })
    expect(store.snapshot('b1').state).toEqual({ text: 'x', enabled: true })
  })

  it('未知组件类型降级为占位 def（不抛错，命令 no-op）', () => {
    const store = new ComponentStore()
    expect(() => store.init([spec('u1', 'hoverboard')])).not.toThrow()
    expect(() => store.applyCommand('u1', 'launch', {})).not.toThrow()
  })

  it('staff/fingering __strike 产出单击音符效果（点击即发该音）', () => {
    const store = new ComponentStore()
    store.init([spec('st1', 'staff'), spec('k1', 'fingering')])
    const expected = (midi: number) => [{ type: 'audio.play', notes: [{ midi, dur: '8n' }], mode: 'chord' }]
    expect(store.applyCommand('st1', '__strike', { midi: 64 })).toEqual(expected(64))
    expect(store.applyCommand('k1', '__strike', { midi: 60 })).toEqual(expected(60))
    expect(store.applyCommand('st1', '__strike', {})).toEqual([]) // 非 midi 参数静默忽略
  })

  it('不存在的组件 id 抛错（运行器会兜底）', () => {
    const store = new ComponentStore()
    store.init([])
    expect(() => store.applyCommand('nope', 'show', {})).toThrow()
  })

  it('snapshot 对不存在的 id 返回稳定引用', () => {
    const store = new ComponentStore()
    expect(store.snapshot('ghost')).toBe(store.snapshot('ghost'))
  })
})
