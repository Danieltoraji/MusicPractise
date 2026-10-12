// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ComponentInstance } from '../engine/level'
import { ComponentStore } from '../runtime/store'
import { ButtonView, ChoiceView, FingeringView, RhythmView, SoundView, SynthView } from './views'
import { StaffView } from './staffViews'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const roots: Root[] = []
const containers: HTMLElement[] = []

function renderEl(ui: React.ReactElement): HTMLElement {
  const container = document.createElement('div')
  document.body.appendChild(container)
  containers.push(container)
  let root!: Root
  act(() => {
    root = createRoot(container)
    root.render(ui)
  })
  roots.push(root)
  return container
}

afterEach(() => {
  roots.splice(0).forEach((r) => act(() => r.unmount()))
  containers.splice(0).forEach((c) => c.remove())
})

describe('组件视图（jsdom 冒烟）', () => {
  it('StaffView 渲染 SVG 并按顺序挂 data-midi', () => {
    const store = new ComponentStore()
    const spec: ComponentInstance = {
      id: 'staff1',
      type: 'staff',
      layout: { x: 0, y: 0, w: 720, h: 160 },
      props: { clickable: true },
    }
    store.init([spec])
    store.applyCommand('staff1', 'setMusic', { music: { notes: [{ midi: 60 }, { midi: 64 }], clef: 'treble' } })
    const container = renderEl(<StaffView spec={spec} store={store} emit={() => {}} />)
    const groups = container.querySelectorAll('[data-midi]')
    expect([...groups].map((g) => g.getAttribute('data-midi'))).toEqual(['60', '64'])
    expect(container.querySelector('svg')).not.toBeNull()
  })

  it('StaffView 无行数据（音乐为 null）时仍渲染空谱架（画布预览/首帧不空白，docs/26 回归）', () => {
    const store = new ComponentStore()
    const spec: ComponentInstance = { id: 'staff1', type: 'staff', layout: { x: 0, y: 0, w: 720, h: 160 } }
    store.init([spec])
    const container = renderEl(<StaffView spec={spec} store={store} emit={() => {}} />)
    expect(container.querySelector('svg')).not.toBeNull()
    expect(container.querySelectorAll('[data-midi]')).toHaveLength(0)
  })

  it('ChoiceView 点击发 chosen；reveal 后锁定并标记对错', () => {
    const store = new ComponentStore()
    const spec: ComponentInstance = { id: 'choice1', type: 'choice', layout: { x: 0, y: 0, w: 720, h: 220 } }
    store.init([spec])
    store.applyCommand('choice1', 'setOptions', { options: ['甲', '乙', '丙'] })
    const emit = vi.fn()
    const container = renderEl(<ChoiceView spec={spec} store={store} emit={emit} />)

    const items = container.querySelectorAll('.choice-item')
    expect(items).toHaveLength(3)
    act(() => {
      ;(items[1] as HTMLElement).dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(emit).toHaveBeenCalledWith('chosen', { index: 1, value: '乙' })

    act(() => {
      store.applyCommand('choice1', 'reveal', { correctIndex: 2 })
    })
    const after = container.querySelectorAll('.choice-item')
    expect(after[2].className).toContain('is-correct')
    expect(after[1].className).toContain('is-wrong')
    expect((after[0] as HTMLButtonElement).disabled).toBe(true)
  })

  it('ChoiceView 换题（options 更新）清除已锁定状态', () => {
    const store = new ComponentStore()
    const spec: ComponentInstance = { id: 'choice1', type: 'choice', layout: { x: 0, y: 0, w: 720, h: 220 } }
    store.init([spec])
    store.applyCommand('choice1', 'setOptions', { options: ['A', 'B'] })
    const container = renderEl(<ChoiceView spec={spec} store={store} emit={() => {}} />)
    act(() => {
      store.applyCommand('choice1', 'reveal', { correctIndex: 0 })
    })
    expect((container.querySelector('.choice-item') as HTMLButtonElement).disabled).toBe(true)

    act(() => {
      store.applyCommand('choice1', 'setOptions', { options: ['X', 'Y', 'Z'] })
    })
    const renewed = container.querySelectorAll('.choice-item')
    expect(renewed).toHaveLength(3)
    expect((renewed[0] as HTMLButtonElement).disabled).toBe(false)
  })

  it('FingeringView 渲染黑白键并挂 data-midi，点击发 keyClicked、高亮生效', () => {
    const store = new ComponentStore()
    const spec: ComponentInstance = {
      id: 'k1',
      type: 'fingering',
      layout: { x: 0, y: 0, w: 720, h: 180 },
      props: { lowMidi: 60, highMidi: 64 }, // 60..64：白 60/62/64，黑 61/63
    }
    store.init([spec])
    const emit = vi.fn()
    const container = renderEl(<FingeringView spec={spec} store={store} emit={emit} />)

    expect(container.querySelectorAll('.key')).toHaveLength(5)
    expect(container.querySelectorAll('.key.white')).toHaveLength(3)
    expect(container.querySelectorAll('.key.black')).toHaveLength(2)
    expect(container.querySelectorAll('[data-midi="61"]')).toHaveLength(1)

    act(() => {
      ;(container.querySelector('[data-midi="60"]') as HTMLElement).dispatchEvent(
        new MouseEvent('click', { bubbles: true }),
      )
    })
    expect(emit).toHaveBeenCalledWith('keyClicked', { midi: 60, name: 'C4' })

    act(() => {
      store.applyCommand('k1', 'highlight', { target: 60, style: 'correct' })
    })
    expect(container.querySelector('[data-midi="60"]')!.className).toContain('correct')
  })

  it('ButtonView 禁用时不发 clicked，启用后可发', () => {
    const store = new ComponentStore()
    const spec: ComponentInstance = { id: 'b1', type: 'button', layout: { x: 0, y: 0, w: 140, h: 48 }, props: { text: 'go', enabled: false } }
    store.init([spec])
    const emit = vi.fn()
    const container = renderEl(<ButtonView spec={spec} store={store} emit={emit} />)

    const btn = container.querySelector('button') as HTMLButtonElement
    expect(btn.disabled).toBe(true)
    act(() => {
      btn.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(emit).not.toHaveBeenCalled()

    act(() => {
      store.applyCommand('b1', 'setEnabled', { enabled: true })
    })
    act(() => {
      btn.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(emit).toHaveBeenCalledWith('clicked')
  })
})

describe('SynthView（合成器面板）', () => {
  it('渲染音色名与音量；play 命令后出现播放态动画', () => {
    const store = new ComponentStore()
    const spec = { id: 'synth1', type: 'synth', layout: { x: 0, y: 0, w: 200, h: 90 }, props: { wave: 'bell' } } as ComponentInstance
    store.init([spec])
    const c = renderEl(<SynthView spec={spec} store={store} emit={() => {}} />)
    expect(c.textContent).toContain('钟琴 · 空灵')
    expect(c.textContent).toContain('点击琴键可试音')
    expect(c.querySelector('.comp-synth.is-playing')).toBeNull()
    act(() => store.applyCommand('synth1', 'play', { notes: [{ midi: 60 }] }))
    expect(c.querySelector('.comp-synth.is-playing')).toBeTruthy()
    expect(c.textContent).toContain('1 音')
  })
})

describe('SoundView（发声器面板）', () => {
  it('渲染采样音色标识；lastPlay 变化触发播放态', () => {
    const store = new ComponentStore()
    const spec = { id: 'sound1', type: 'sound', layout: { x: 0, y: 0, w: 200, h: 90 } } as ComponentInstance
    store.init([spec])
    const c = renderEl(<SoundView spec={spec} store={store} emit={() => {}} />)
    expect(c.textContent).toContain('采样音色 · 钢琴')
    expect(c.querySelector('.comp-sound.is-playing')).toBeNull()
    act(() => store.applyCommand('sound1', 'play', { notes: [{ midi: 60 }] }))
    expect(c.querySelector('.comp-sound.is-playing')).toBeTruthy()
    expect(c.textContent).toContain('1 音')
  })
})

describe('触屏/指针修复（批次12）', () => {
  /** jsdom 无 SVG getBBox——给 g 元素挂桩返回固定包围盒 */
  function stubGetBBox(): void {
    Object.defineProperty(SVGElement.prototype, 'getBBox', {
      configurable: true,
      value: function () {
        return { x: 40, y: 20, width: 20, height: 24 }
      },
    })
  }

  function unstubGetBBox(): void {
    delete (SVGElement.prototype as unknown as { getBBox?: unknown }).getBBox
  }

  it('StaffView 热区垫：透明外扩 rect 生成且点击垫触发 noteClicked', () => {
    stubGetBBox()
    try {
      const store = new ComponentStore()
      const spec: ComponentInstance = {
        id: 'staff1',
        type: 'staff',
        layout: { x: 0, y: 0, w: 720, h: 160 },
        props: { clickable: true },
      }
      store.init([spec])
      store.applyCommand('staff1', 'setMusic', { music: { notes: [{ midi: 60 }], clef: 'treble' } })
      const onNote = vi.fn()
      const container = renderEl(<StaffView spec={spec} store={store} emit={onNote} />)

      const pad = container.querySelector('rect[data-hitpad="60"]') as SVGRectElement
      expect(pad).not.toBeNull()
      expect(pad.getAttribute('fill')).toBe('transparent')
      // stroke 是 SVG 可继承属性：不显式关掉会继承音符组的黑色描边，把热区画成黑框
      expect(pad.getAttribute('stroke')).toBe('none')
      expect(Number(pad.getAttribute('width'))).toBeGreaterThan(20) // 有外扩

      // 点击垫（冒泡到 g 的 listener）
      const strikeSpy = vi.spyOn(store, 'applyCommand')
      pad.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      expect(strikeSpy).toHaveBeenCalledWith('staff1', '__strike', { midi: 60 })
      expect(onNote).toHaveBeenCalledWith('noteClicked', { midi: 60, name: 'C4' })
    } finally {
      unstubGetBBox()
    }
  })

  it('FingeringView 滑奏：按下发声、拖划换键连发、松手补发 click 被抑制', () => {
    const store = new ComponentStore()
    const spec: ComponentInstance = {
      id: 'k1',
      type: 'fingering',
      layout: { x: 0, y: 0, w: 400, h: 120 },
    }
    store.init([spec])
    const emits: unknown[] = []
    const container = renderEl(<FingeringView spec={spec} store={store} emit={(event, payload) => emits.push({ event, payload })} />)
    const keyOf = (midi: string): HTMLElement => container.querySelector(`[data-midi="${midi}"]`) as HTMLElement
    const keyA = keyOf('60')
    const keyB = keyOf('62')
    expect(keyA).toBeTruthy()
    expect(keyB).toBeTruthy()

    // 按下 A：立即发声（钢琴语义）。jsdom 无 PointerEvent——MouseEvent 补 isPrimary
    const pointerOf = (type: string): Event => {
      const ev = new MouseEvent(type, { bubbles: true })
      Object.defineProperty(ev, 'isPrimary', { value: true })
      return ev
    }
    act(() => {
      keyA.dispatchEvent(pointerOf('pointerdown'))
    })
    expect(emits.at(-1)).toMatchObject({ event: 'keyClicked', payload: { midi: 60 } })

    // 拖到 B（elementFromPoint 桩指向 B）：换键发声
    const origFromPoint = document.elementFromPoint
    document.elementFromPoint = () => keyB
    try {
      act(() => {
        keyA.dispatchEvent(pointerOf('pointermove'))
      })
      expect(emits.at(-1)).toMatchObject({ event: 'keyClicked', payload: { midi: 62 } })

      // 松手（pointerup）→ 浏览器对起始键补发 click：应被抑制
      act(() => {
        keyA.dispatchEvent(pointerOf('pointerup'))
      })
      const countAfterUp = emits.length
      act(() => {
        keyA.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      })
      expect(emits.length).toBe(countAfterUp)
    } finally {
      document.elementFromPoint = origFromPoint
    }
  })

  it('FingeringView 普通单击不受影响：click 发声一次', () => {
    const store = new ComponentStore()
    const spec: ComponentInstance = { id: 'k1', type: 'fingering', layout: { x: 0, y: 0, w: 400, h: 120 } }
    store.init([spec])
    const emits: unknown[] = []
    const container = renderEl(<FingeringView spec={spec} store={store} emit={(event, payload) => emits.push({ event, payload })} />)
    const key = container.querySelector('[data-midi="60"]') as HTMLElement
    act(() => {
      key.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(emits).toHaveLength(1)
    expect(emits[0]).toMatchObject({ event: 'keyClicked', payload: { midi: 60 } })
  })
})

describe('SynthView 面板键盘（批次13 交互化）', () => {
  function renderSynth(): { c: HTMLElement; strikeSpy: ReturnType<typeof vi.spyOn> } {
    const store = new ComponentStore()
    const spec: ComponentInstance = { id: 'synth1', type: 'synth', layout: { x: 0, y: 0, w: 260, h: 200 } }
    store.init([spec])
    const strikeSpy = vi.spyOn(store, 'applyCommand')
    const c = renderEl(<SynthView spec={spec} store={store} emit={() => {}} />)
    return { c, strikeSpy }
  }

  it('渲染 C4-B4 迷你键盘（7 白键 + 5 黑键），data-midi 60-71', () => {
    const { c } = renderSynth()
    expect(c.querySelectorAll('.synth-keys .key.white')).toHaveLength(7)
    expect(c.querySelectorAll('.synth-keys .key.black')).toHaveLength(5)
    expect(c.querySelector('.synth-keys [data-midi="60"]')).toBeTruthy()
    expect(c.querySelector('.synth-keys [data-midi="71"]')).toBeTruthy()
  })

  it('点击琴键调 __strike（当前音色发声）', () => {
    const { c, strikeSpy } = renderSynth()
    const key = c.querySelector('.synth-keys [data-midi="64"]') as HTMLElement
    act(() => key.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    expect(strikeSpy).toHaveBeenCalledWith('synth1', '__strike', { midi: 64 })
  })
})

// ---------------------------------------------------------------------------
// RhythmView 挂起上下文安全排程（docs/33 遗留复核）：与执行器同一不变量——
// 音频排程必须在 running 时钟上进行；解锁前不预排、盲拍不放行、打板垫显示「未开始」
// ---------------------------------------------------------------------------

class RhythmFakeNode {
  gain = { setValueAtTime: () => {}, exponentialRampToValueAtTime: () => {} }
  frequency = { value: 0 }
  type = ''
  startTime: number | null = null
  connect(n: unknown): unknown {
    return n
  }
  start(t?: number): void {
    this.startTime = t ?? -1
  }
  stop(): void {}
}

/** 挂起时 currentTime 冻结在 100；unlock() 模拟首次手势，时钟跳 250 继续（同 audioSuspend.test） */
class RhythmFakeCtx {
  state: string
  currentTime = 100
  destination = new RhythmFakeNode()
  oscs: RhythmFakeNode[] = []
  private resolvers: Array<() => void> = []
  constructor(state = 'suspended') {
    this.state = state
  }
  resume(): Promise<void> {
    return new Promise((resolve) => {
      this.resolvers.push(() => {
        this.state = 'running'
        this.currentTime = 250
        resolve()
      })
    })
  }
  unlock(): void {
    this.resolvers.forEach((r) => r())
    this.resolvers = []
  }
  addEventListener(): void {}
  removeEventListener(): void {}
  createOscillator(): RhythmFakeNode {
    const o = new RhythmFakeNode()
    this.oscs.push(o)
    return o
  }
  createGain(): RhythmFakeNode {
    return new RhythmFakeNode()
  }
}

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

describe('RhythmView 挂起上下文安全排程（docs/33 遗留复核）', () => {
  // audio 模块的 ctx 是单例：两用例共享同一实例（A 结束后处于 running@250，B 直接复用）
  let ctx: RhythmFakeCtx

  it('挂起时 start：不预排、盲拍不放行、UI 显示未开始；解锁后整轮精排且 tap 相对 t0', async () => {
    ctx = new RhythmFakeCtx('suspended')
    // jsdom 无 rAF（tick 循环用）：setTimeout 桩替代，cancel 对齐 clearTimeout
    vi.stubGlobal('requestAnimationFrame', (cb: (t: number) => void): number => window.setTimeout(() => cb(1000), 0))
    vi.stubGlobal('cancelAnimationFrame', (h: number) => window.clearTimeout(h))
    vi.stubGlobal(
      'AudioContext',
      function () {
        return ctx
      },
    )
    try {
      const store = new ComponentStore()
      const spec: ComponentInstance = { id: 'r1', type: 'rhythm', layout: { x: 0, y: 0, w: 400, h: 120 } }
      store.init([spec])
      const events: Array<{ event: string; payload?: unknown }> = []
      const c = renderEl(<RhythmView spec={spec} store={store} emit={(event, payload) => events.push({ event, payload })} />)
      act(() => {
        store.applyCommand('r1', 'start', { bpm: 60, beats: 4, countInBeats: 2 })
      })
      await flush()
      // 挂起：整轮不预排（旧实现在冻结的 100.2 上排满 6 个 click，解锁瞬间齐爆）
      expect(ctx.oscs.filter((o) => o.startTime !== null)).toHaveLength(0)
      // 打板垫诚实显示未开始；解锁前盲拍不放行（旧实现会以恒定负值进入判分）
      const pad = c.querySelector('.tap-pad') as HTMLElement
      expect(pad.textContent).toBe('未开始')
      expect(pad.className).not.toContain('live')
      act(() => {
        pad.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }))
      })
      expect(events.filter((e) => e.event === 'tap')).toHaveLength(0)

      act(() => {
        ctx.unlock()
      })
      await flush()
      await flush()
      // count-in 2 + 节拍 4 = 6 个 click，全部落在解锁后的时钟上：250.2 起、spb=1s 间距
      const sorted = [...ctx.oscs].sort((a, b) => (a.startTime ?? 0) - (b.startTime ?? 0))
      expect(sorted).toHaveLength(6)
      expect(sorted[0].startTime).toBeCloseTo(250.2, 5)
      expect(sorted[1].startTime).toBeCloseTo(251.2, 5)
      expect(sorted[2].startTime).toBeCloseTo(252.2, 5) // t0 = 250 + 2×1 + 0.2
      expect(sorted[5].startTime).toBeCloseTo(255.2, 5)
      // 锚定后 UI 进入 TAP 态；tap 放行且相对 t0（时钟停在 250 → 预备拍负值 -2.2）
      expect((c.querySelector('.tap-pad') as HTMLElement).textContent).toBe('TAP')
      act(() => {
        ;(c.querySelector('.tap-pad') as HTMLElement).dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }))
      })
      const taps = events.filter((e) => e.event === 'tap')
      expect(taps).toHaveLength(1)
      expect((taps[0]!.payload as { t: number }).t).toBeCloseTo(-2.2, 5)
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('running 上下文 start：立即整轮排程（既有语义回归），UI 直接 TAP', async () => {
    // ctx 复用上一用例解锁后的单例（state=running、currentTime=250）
    const before = ctx.oscs.length
    vi.stubGlobal('requestAnimationFrame', (cb: (t: number) => void): number => window.setTimeout(() => cb(1000), 0))
    vi.stubGlobal('cancelAnimationFrame', (h: number) => window.clearTimeout(h))
    vi.stubGlobal(
      'AudioContext',
      function () {
        return ctx
      },
    )
    try {
      const store = new ComponentStore()
      const spec: ComponentInstance = { id: 'r2', type: 'rhythm', layout: { x: 0, y: 0, w: 400, h: 120 } }
      store.init([spec])
      const c = renderEl(<RhythmView spec={spec} store={store} emit={() => {}} />)
      act(() => {
        store.applyCommand('r2', 'start', { bpm: 120, beats: 2, countInBeats: 1 })
      })
      await flush()
      const starts = ctx.oscs.slice(before).map((o) => o.startTime).filter((t): t is number => t !== null)
      expect(starts).toHaveLength(3) // 1 预备 + 2 节拍，无解锁等待
      expect(Math.min(...starts)).toBeCloseTo(250.2, 5)
      expect((c.querySelector('.tap-pad') as HTMLElement).textContent).toBe('TAP')
    } finally {
      vi.unstubAllGlobals()
    }
  })
})
