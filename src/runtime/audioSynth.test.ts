// playSynth / stopSynth 回归测试：用 mock AudioContext 记录自动化事件序列
// （评审 P2-7：包络时序类缺陷只有这种测试能捕获——P1-1 sustain 平顶缺失即由此类探针发现）
import { describe, expect, it, vi } from 'vitest'
import { getCtx, getMasterGain, playSynth, setMasterVolume, stopSynth } from './audio'

class FakeParam {
  events: Array<{ op: string; value?: number; time?: number }> = []
  value = 0
  setValueAtTime(v: number, t: number): void {
    this.events.push({ op: 'set', value: v, time: t })
    this.value = v
  }
  linearRampToValueAtTime(v: number, t: number): void {
    this.events.push({ op: 'linramp', value: v, time: t })
  }
  exponentialRampToValueAtTime(v: number, t: number): void {
    this.events.push({ op: 'expramp', value: v, time: t })
  }
  cancelScheduledValues(t: number): void {
    this.events.push({ op: 'cancel', time: t })
  }
  setTargetAtTime(v: number, t: number): void {
    this.events.push({ op: 'target', value: v, time: t })
    this.value = v
  }
}

class FakeNode {
  gain = new FakeParam()
  frequency = new FakeParam()
  type = ''
  startTime: number | null = null
  stopTime: number | null = null
  connectedTo: unknown = null
  connect(n: unknown): unknown {
    this.connectedTo = n
    return n
  }
  start(t?: number): void {
    this.startTime = t ?? -1
  }
  stop(t?: number): void {
    this.stopTime = t ?? -1
  }
}

class FakeCtx {
  static Now = 100
  currentTime = FakeCtx.Now
  destination = new FakeNode()
  oscs: FakeNode[] = []
  gains: FakeNode[] = []
  createOscillator(): FakeNode {
    const o = new FakeNode()
    this.oscs.push(o)
    return o
  }
  createGain(): FakeNode {
    const g = new FakeNode()
    this.gains.push(g)
    return g
  }
  createBiquadFilter(): FakeNode {
    return new FakeNode()
  }
  resume(): Promise<void> {
    return Promise.resolve()
  }
}

vi.stubGlobal('AudioContext', FakeCtx)

/** 包络增益节点 = 事件里含「指数衰减到 0.0001」（最终释放段）的 gain */
function envelopeGains(fake: FakeCtx): FakeNode[] {
  return fake.gains.filter((g) => g.gain.events.some((e) => e.op === 'expramp' && e.value === 0.0001))
}

describe('playSynth / stopSynth（mock AudioContext 回归）', () => {
  it('可持续音色：sustain 平顶事件落在 holdEnd，release 从 holdEnd 起算（P1-1 回归）', () => {
    const fake = getCtx() as unknown as FakeCtx
    playSynth([{ midi: 60 }], { wave: 'sine', tempo: 90, gain: 0.3 })
    const envs = envelopeGains(fake)
    expect(envs).toHaveLength(1)
    const ev = envs[0].gain.events
    // 4n@90bpm ≈ 0.667s：t0=100.05 → holdEnd≈100.717，存在 holdEnd 处的平顶 set 事件
    const holdSet = ev.find((e) => e.op === 'set' && (e.time ?? 0) > 100.5)
    expect(holdSet).toBeTruthy()
    // 释放段：holdEnd 之后才指数衰减到 0.0001
    const release = ev.find((e) => e.op === 'expramp' && e.value === 0.0001)
    expect(release!.time!).toBeCloseTo((holdSet!.time ?? 0) + 0.2, 5)
  })

  it('衰减音色（bell）：holdEnd 前指数衰减到低位，再接释放段', () => {
    const fake = getCtx() as unknown as FakeCtx
    playSynth([{ midi: 60 }], { wave: 'bell', gain: 0.3 })
    const env = envelopeGains(fake).at(-1)!
    const ramps = env.gain.events.filter((e) => e.op === 'expramp')
    // 第一段 expRamp 是 holdEnd 前的自然衰减（到峰值的低位），第二段是释放
    expect(ramps.length).toBeGreaterThanOrEqual(2)
    expect(ramps[ramps.length - 1].value).toBe(0.0001)
    expect(ramps[ramps.length - 2].time!).toBeLessThan(ramps[ramps.length - 1].time!)
  })

  it('接排排程：无 t 音符按 dur 连奏（与 playNotes 同语义，docs/27）', () => {
    const fake = getCtx() as unknown as FakeCtx
    const before = fake.oscs.length
    playSynth(
      [{ midi: 60 }, { midi: 64 }, { midi: 67 }],
      { wave: 'square', tempo: 90 },
    )
    const starts = fake.oscs.slice(before).map((o) => o.startTime).filter((t): t is number => t !== null)
    expect(starts).toHaveLength(3)
    const spb = 60 / 90 // 四分音符 = 1 拍
    expect(starts[1] - starts[0]).toBeCloseTo(spb, 5)
    expect(starts[2] - starts[1]).toBeCloseTo(spb, 5)
  })

  it('t 起始拍：相同 t 同时响；休止符占位推进游标（docs/27）', () => {
    const fake = getCtx() as unknown as FakeCtx
    const before = fake.oscs.length
    playSynth(
      [{ midi: 60, t: 0 }, { midi: 64, t: 0 }, { rest: true, dur: '4n' }, { midi: 67 }],
      { wave: 'square', tempo: 90 },
    )
    const starts = fake.oscs.slice(before).map((o) => o.startTime).filter((t): t is number => t !== null)
    expect(starts).toHaveLength(3) // 休止符不发声
    const spb = 60 / 90
    expect(starts[0]).toBe(starts[1]) // 相同 t = 和弦
    expect(starts[2] - starts[0]).toBeCloseTo(2 * spb, 5) // 休止 1 拍后第 2 拍起
  })

  it('stopSynth：全部声部取消调度 + 50ms 淡出 + 短停振；二次调用无副作用', () => {
    const fake = getCtx() as unknown as FakeCtx
    playSynth([{ midi: 60 }, { midi: 64 }], { wave: 'sine' })
    const envs = envelopeGains(fake)
    expect(envs.length).toBeGreaterThanOrEqual(2)
    stopSynth()
    for (const g of envs) {
      const ev = g.gain.events
      expect(ev.some((e) => e.op === 'cancel' && (e.time ?? 0) === 100)).toBe(true)
      const fade = ev.find((e) => e.op === 'expramp' && e.value === 0.0001 && (e.time ?? 0) === 100.05)
      expect(fade).toBeTruthy()
    }
    expect(fake.oscs.filter((o) => o.stopTime !== null && o.stopTime <= 100.08).length).toBeGreaterThan(0)
    // 注册表已清空：再 stop 不产生新事件
    const afterFirst = envs.map((g) => g.gain.events.length)
    stopSynth()
    expect(envs.map((g) => g.gain.events.length)).toEqual(afterFirst)
  })
})

describe('主音量总线（批次13）', () => {
  it('setMasterVolume 持久化并实时应用到总线增益', () => {
    const store = new Map<string, string>()
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => store.set(k, v),
      removeItem: (k: string) => store.delete(k),
    })
    try {
      const g = getMasterGain() as unknown as FakeNode
      setMasterVolume(0.4)
      expect(g.gain.value).toBeCloseTo(0.4)
      expect(store.get('master-volume')).toBe('0.4')
      setMasterVolume(0.75)
      expect(g.gain.value).toBeCloseTo(0.75)
      // gain 事件里有 target 应用（实时生效而非等下次创建）
      expect(g.gain.events.some((e) => e.op === 'target' && e.value === 0.75)).toBe(true)
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('playSynth 的包络输出接到主总线而非 destination', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => null,
      setItem: () => {},
      removeItem: () => {},
    })
    try {
      const fake = getCtx() as unknown as FakeCtx
      playSynth([{ midi: 60, dur: '4n' }], { wave: 'sine' })
      const env = envelopeGains(fake)[0]
      expect(env).toBeTruthy()
      // env → master → destination 的两级链
      const master = env.connectedTo as FakeNode
      expect(master).toBeTruthy()
      expect(master.connectedTo).toBe(fake.destination)
    } finally {
      vi.unstubAllGlobals()
    }
  })
})
