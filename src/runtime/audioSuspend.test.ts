// 冻结时钟回归：在挂起（suspended）的 AudioContext 上直接排程，多次 play 的音符会
// 堆叠在同一冻结时刻，首次手势解锁后全部同时炸响——听音点击关卡「进关自动播放 +
// 首击」时序错乱的执行器侧根因。修复后：挂起期间不排程，解锁后在 running 时钟上
// 按音符串时序重排（docs/27 语义不变）。smplr 用 mock 挡住真实采样下载。
import { beforeEach, describe, expect, it, vi } from 'vitest'

interface StartRecord {
  kind: string
  note: number
  time: number
  velocity?: number
}
const starts: StartRecord[] = []
const created: string[] = []

vi.mock('smplr', () => {
  const make = (kind: string): unknown =>
    class FakeSampler {
      ready = Promise.resolve()
      constructor() {
        created.push(kind)
      }
      start(opts: { note: number; velocity: number; time: number }): void {
        starts.push({ kind, note: opts.note, time: opts.time, velocity: opts.velocity })
      }
      stop(): void {
        for (let i = starts.length - 1; i >= 0; i--) if (starts[i].kind === kind) starts.splice(i, 1)
      }
    }
  return { SplendidGrandPiano: make('piano'), ElectricPiano: make('electric-piano'), Mallet: make('mallet') }
})

class FakeParam {
  value = 0
  setValueAtTime(): void {}
  linearRampToValueAtTime(): void {}
  exponentialRampToValueAtTime(): void {}
  cancelScheduledValues(): void {}
  setTargetAtTime(): void {}
}
class FakeNode {
  gain = new FakeParam()
  frequency = new FakeParam()
  pan = new FakeParam()
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

/**
 * 可控上下文：挂起时时钟冻结在 100；resume() 返回 pending（无手势被拒绝的浏览器语义），
 * unlock() 模拟用户手势解锁——时钟跳到 250 继续走。
 */
class FakeCtx {
  state: string
  currentTime = 100
  destination = new FakeNode()
  oscs: FakeNode[] = []
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
  createGain(): FakeNode {
    return new FakeNode()
  }
  createOscillator(): FakeNode {
    const o = new FakeNode()
    this.oscs.push(o)
    return o
  }
}

/**
 * smplr 各采样器构造时会调用一串 context.create*（stereoPanner/channelSplitter/
 * waveShaper…，钢琴只用其中几个）——Proxy 兜底：任意 create* 返回通用 FakeNode，
 * 免得测试替身逐个追新。
 */
function asFakeCtx(c: FakeCtx): FakeCtx {
  return new Proxy(c, {
    get(target, prop, recv) {
      if (prop in target) return Reflect.get(target, prop, recv)
      if (typeof prop === 'string' && prop.startsWith('create')) return () => new FakeNode()
      return undefined
    },
  })
}

let theCtx: FakeCtx
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

async function loadAudio(ctx: FakeCtx): Promise<typeof import('./audio')> {
  theCtx = asFakeCtx(ctx)
  // getCtx 里是 new AudioContext()：普通构造函数返回单例对象（箭头函数不可 new）
  vi.stubGlobal('AudioContext', function () {
    return theCtx
  })
  return import('./audio')
}

beforeEach(() => {
  starts.length = 0
  created.length = 0
  vi.resetModules()
  vi.unstubAllGlobals()
})

describe('挂起上下文的排程安全（时序错乱回归）', () => {
  it('playNotes：挂起期间不排程；解锁后在 running 时钟上按序重排', async () => {
    const audio = await loadAudio(new FakeCtx('suspended'))
    audio.playNotes(
      [
        { midi: 60, dur: '4n' },
        { midi: 62, dur: '4n' },
        { midi: 64, dur: '2n' },
      ],
      90,
    )
    await tick()
    // 旧实现在冻结的 100.06 上排好全部音符——手势解锁瞬间三音同时炸响
    expect(starts).toHaveLength(0)
    theCtx.unlock()
    await tick()
    expect(starts).toHaveLength(3)
    const spb = 60 / 90
    for (const s of starts) expect(s.time).toBeGreaterThan(200) // 全部落在解锁后的时钟（≈250.06 起）
    expect(starts[1].time - starts[0].time).toBeCloseTo(spb, 5) // 旋律连排语义不变
    expect(starts[2].time - starts[0].time).toBeCloseTo(2 * spb, 5)
  })

  it('playSynth：同样等解锁再排程（挂起时声部为零）', async () => {
    const audio = await loadAudio(new FakeCtx('suspended'))
    const queue = audio.playSynth([{ midi: 60, dur: '4n' }, { midi: 64 }], { wave: 'sine', tempo: 90 })
    await tick()
    expect(theCtx.oscs.filter((o) => o.startTime !== null)).toHaveLength(0)
    theCtx.unlock()
    await queue
    const oscStarts = theCtx.oscs.map((o) => o.startTime).filter((t): t is number => t !== null)
    expect(oscStarts.length).toBeGreaterThanOrEqual(2) // FM/载波等声部节点全部就位
    for (const t of oscStarts) expect(t).toBeGreaterThan(200)
  })

  it('stopAllAudio：作废仍在排队（等待解锁）的播放，且不楔死后续播放', async () => {
    const audio = await loadAudio(new FakeCtx('suspended'))
    audio.playNotes([{ midi: 60 }], 90)
    await tick()
    audio.stopAllAudio()
    theCtx.unlock()
    await tick()
    expect(starts).toHaveLength(0) // 排队中的幽灵音被作废
    audio.playNotes([{ midi: 72 }], 90)
    await tick()
    expect(starts).toHaveLength(1) // stop 之后的新播放正常
    expect(starts[0].note).toBe(72)
    expect(starts[0].time).toBeCloseTo(250.06, 2)
  })

  it('running 上下文行为不变：立即排程（≈now+0.06）', async () => {
    const audio = await loadAudio(new FakeCtx('running'))
    audio.playNotes([{ midi: 60 }], 90)
    await tick()
    expect(starts).toHaveLength(1)
    expect(starts[0].time).toBeCloseTo(100.06, 2)
  })
})

describe('音色透传与预热（首击延迟回归）', () => {
  it('runAudioEffects：effect.instrument 透传给采样器（此前被丢弃、全部回落钢琴）', async () => {
    const { runAudioEffects } = await import('./audioHost')
    await loadAudio(new FakeCtx('running'))
    runAudioEffects([{ type: 'audio.play', notes: [{ midi: 64 }], instrument: 'mallet' }])
    await tick()
    expect(starts).toHaveLength(1)
    expect(starts[0].kind).toBe('mallet')
  })

  it('runAudioEffects：audio.stop 停掉已排程声部', async () => {
    const { runAudioEffects } = await import('./audioHost')
    await loadAudio(new FakeCtx('running'))
    runAudioEffects([{ type: 'audio.play', notes: [{ midi: 64 }] }])
    await tick()
    expect(starts).toHaveLength(1)
    runAudioEffects([{ type: 'audio.stop' }])
    await tick()
    expect(starts).toHaveLength(0)
  })

  it('preloadLevelAudio：staff/fingering 预热钢琴', async () => {
    const { preloadLevelAudio } = await import('./audioHost')
    await loadAudio(new FakeCtx('running'))
    const doc = {
      content: {
        components: [
          { id: 'staff1', type: 'staff' },
          { id: 'k1', type: 'fingering' },
        ],
      },
    } as never
    preloadLevelAudio(doc)
    await tick()
    expect(created).toEqual(['piano'])
  })

  it('preloadLevelAudio：sound 按 props.instrument 预热；未知音色回落钢琴', async () => {
    const { preloadLevelAudio } = await import('./audioHost')
    await loadAudio(new FakeCtx('running'))
    // 顺序两次单音色扫描：resetModules 的 mock 下「同模块并发动态导入」会落到真实 smplr
    // （vitest 怪癖；浏览器共享同一模块记录无此问题），故不制造并发链
    preloadLevelAudio({
      content: { components: [{ id: 'sound1', type: 'sound', props: { instrument: 'electric-piano' } }] },
    } as never)
    await tick()
    expect(created).toEqual(['electric-piano'])
    preloadLevelAudio({
      content: { components: [{ id: 'sound2', type: 'sound', props: { instrument: 'honky-tonk' } }] },
    } as never)
    await tick()
    expect(created).toEqual(['electric-piano', 'piano']) // honky-tonk 非法 → piano 兜底
  })

  it('preloadAudio：幂等（同音色只装载一次）', async () => {
    const audio = await loadAudio(new FakeCtx('running'))
    audio.preloadAudio(['piano', 'piano'])
    audio.preloadAudio(['piano'])
    await tick()
    expect(created.filter((k) => k === 'piano')).toHaveLength(1)
  })
})
