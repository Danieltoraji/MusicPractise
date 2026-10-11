/**
 * 音频引擎：全局单例 AudioContext + smplr 采样钢琴。
 * 一切调度以 AudioContext.currentTime 为唯一时间基准。
 * 钢琴采样器（smplr）按需加载：首次 audio.play 才动态 import——首页与纯节奏/合成器关卡无需下载（批次11）。
 */
import type { SplendidGrandPiano } from 'smplr'
import type { Note } from '../engine/level'
import type { SoundInstrument } from './componentDef'

let ctx: AudioContext | null = null
let masterGain: GainNode | null = null

/** 主音量（0-1，默认 1）持久化键；惯例同 graph-theme 的裸 kebab 键 */
const MASTER_VOLUME_KEY = 'master-volume'

export function getMasterVolume(): number {
  try {
    const raw = localStorage.getItem(MASTER_VOLUME_KEY)
    // 缺键 ≠ 0：Number(null) 是 0，必须先判空再取默认 1
    if (raw === null) return 1
    const n = Number(raw)
    return Number.isFinite(n) && n >= 0 && n <= 1 ? n : 1
  } catch {
    return 1
  }
}

/** 设置主音量并实时应用到总线（0 静音 - 1 全响）；设置页滑条与播放中调用均可 */
export function setMasterVolume(v: number): void {
  const clamped = Math.min(1, Math.max(0, v))
  try {
    localStorage.setItem(MASTER_VOLUME_KEY, String(clamped))
  } catch {
    // 隐私模式等：仅本次会话生效
  }
  if (masterGain && ctx) masterGain.gain.setTargetAtTime(clamped, ctx.currentTime, 0.02)
}

/** 主音量总线（批次13）：三条发声链（钢琴/合成器/节拍点击）统一经此出声，支持全局音量 */
export function getMasterGain(): GainNode {
  const c = getCtx()
  if (!masterGain) {
    masterGain = c.createGain()
    masterGain.gain.value = getMasterVolume()
    masterGain.connect(c.destination)
  }
  return masterGain
}

export function getCtx(): AudioContext {
  if (!ctx) ctx = new AudioContext()
  if (ctx.state === 'suspended') void ctx.resume()
  return ctx
}

/** 任意首次用户手势时调用，解锁浏览器自动播放策略下的音频 */
export function unlockAudio(): void {
  getCtx()
}

/**
 * 挂起安全的时间基准：等待 AudioContext 进入 running 再返回。
 * 挂起时 currentTime 冻结——若直接在其上排程，多次 play 的音符会堆叠在同一冻结时刻，
 * 首次用户手势解锁后全部同时炸响（听音关卡进关自动播放 + 首击的「时序错乱」根因）。
 * state 不可读的伪造/异常上下文按 running 处理（测试替身直通）。
 */
async function ensureRunning(): Promise<AudioContext> {
  const c = getCtx()
  if (c.state !== 'suspended' && c.state !== 'interrupted') return c
  try {
    await c.resume()
  } catch {
    /* 无手势时 resume 会被拒绝：继续等 statechange（解锁即触发） */
  }
  if (c.state !== 'suspended' && c.state !== 'interrupted') return c
  await new Promise<void>((resolve) => {
    const onStateChange = (): void => {
      c.removeEventListener('statechange', onStateChange)
      resolve()
    }
    c.addEventListener('statechange', onStateChange)
  })
  return c
}

/**
 * 采样预加载（首击延迟根因：钢琴全音域 169 个采样文件，首次 play 才开始下载，
 * 首个音符要等全部就绪才出声）。关卡装载即调用，把下载提前到进关瞬间。幂等。
 */
export function preloadAudio(instruments: readonly SoundInstrument[] = ['piano']): void {
  for (const inst of new Set(instruments)) {
    if (inst === 'piano') void ensurePiano().catch(() => {})
    else void ensureSampler(inst).catch(() => {})
  }
}

/**
 * 钢琴采样器：与 ensureSampler('piano') 同一注册表实例——统一管理预热与 sound.stop 静停
 * （此前钢琴走独立单例，stopAllAudio 遍历注册表时看不到它，stop 停不掉钢琴声部）。
 */
function ensurePiano(): Promise<SplendidGrandPiano> {
  return ensureSampler('piano') as unknown as Promise<SplendidGrandPiano>
}

// 采样器注册表（批次13）：instrument → 已装载实例；全部接主总线，按需动态 import smplr
type AnySampler = { ready: Promise<unknown>; start(opts: { note: number; velocity: number; time: number; duration: number }): void; stop(): void }
const samplers = new Map<SoundInstrument, Promise<AnySampler>>()

/** 播放代数：stopAllAudio 递增后，仍在等待解锁排程的播放链静默作废（幽灵音防线） */
let playNotesGen = 0

function ensureSampler(instrument: SoundInstrument): Promise<AnySampler> {
  const cached = samplers.get(instrument)
  if (cached) return cached
  const loading = (async () => {
    const smplr = await import('smplr')
    const c = getCtx()
    const dest = getMasterGain()
    switch (instrument) {
      case 'electric-piano': {
        const s = new smplr.ElectricPiano(c, { destination: dest, instrument: 'WurlitzerEP200' })
        await s.ready
        return s as unknown as AnySampler
      }
      case 'mallet': {
        const s = new smplr.Mallet(c, { destination: dest, instrument: 'Vibraphone - Hard Mallets' })
        await s.ready
        return s as unknown as AnySampler
      }
      default: {
        // piano：SplendidGrandPiano（与 ensurePiano 同一路径）
        const s = new smplr.SplendidGrandPiano(c, { destination: dest })
        await s.ready
        return s as unknown as AnySampler
      }
    }
  })()
  loading.catch((err: unknown) => {
    // 装载失败既无声音也无 UI 提示，至少留一条排查线索（「点了没声音」的常见根因）
    console.warn(`[audio] 采样音色 "${instrument}" 装载失败`, err)
    samplers.delete(instrument)
  })
  samplers.set(instrument, loading)
  return loading
}

/** 时值记法（"4n"、"2n."…）→ 四分音符拍数（tempo 无关） */
export function durToQuarters(dur: string): number {
  const dotted = dur.endsWith('.')
  const base = dotted ? dur.slice(0, -1) : dur
  const map: Record<string, number> = { '1n': 4, '2n': 2, '4n': 1, '8n': 0.5, '16n': 0.25, '32n': 0.125 }
  const quarters = map[base]
  if (quarters === undefined) {
    console.warn(`[audio] 未知时值 "${dur}"，按四分音符处理`)
    return 1
  }
  return quarters * (dotted ? 1.5 : 1)
}

/** 时值记法（"4n"、"2n."…）→ 秒 */
export function durToSeconds(dur: string, tempo = 90): number {
  return (durToQuarters(dur) * 60) / tempo
}

export interface ScheduledNote {
  midi: number
  vel: number
  /** 起始拍（相对播放起点；四分音符 = 1 拍） */
  startBeat: number
  durBeats: number
}

/**
 * 音符串 → 排程事件（docs/27 时序模型）：t 缺省接在前一音之后（旋律连排），
 * 相同 t 同时响；休止符（rest / 缺 midi）只占时值推进游标不发声。
 * 纯函数：与 AudioContext 无关，供钢琴/合成器两条播放通道共用与单测。
 */
export function scheduleNoteEvents(notes: Note[]): ScheduledNote[] {
  const out: ScheduledNote[] = []
  let cursor = 0
  for (const n of Array.isArray(notes) ? notes : []) {
    if (n === null || typeof n !== 'object') continue
    const durBeats = durToQuarters(n.dur ?? '4n')
    const tBeat = n.t
    const hasT = typeof tBeat === 'number' && Number.isFinite(tBeat)
    if (n.rest === true || typeof n.midi !== 'number') {
      cursor = hasT ? Math.max(cursor, tBeat + durBeats) : cursor + durBeats
      continue
    }
    const vel = typeof n.vel === 'number' ? Math.min(127, Math.max(1, Math.round(n.vel))) : 100
    out.push({ midi: n.midi, vel, startBeat: hasT ? tBeat : cursor, durBeats })
    cursor = hasT ? Math.max(cursor, tBeat + durBeats) : cursor + durBeats
  }
  return out
}

/**
 * 播放一组音符（钢琴）：时序完全由音符串表达——t 缺省接排、相同 t 同时、休止符占位。
 * duration 在时值之外延长 0.4s 余韵（钢琴自然衰减），上限 3.5s。
 */
export function playNotes(notes: Note[], tempo = 90, instrument: SoundInstrument = 'piano'): void {
  if (!Array.isArray(notes) || notes.length === 0) return
  const events = scheduleNoteEvents(notes)
  if (events.length === 0) return
  const gen = ++playNotesGen
  getCtx()
  const samplerReady = instrument === 'piano' ? ensurePiano() : ensureSampler(instrument)
  samplerReady
    .then(async (sampler) => {
      const c = await ensureRunning()
      if (gen !== playNotesGen) return // 排队期间发生过 stopAllAudio：作废本轮
      const t0 = c.currentTime + 0.06
      const spb = 60 / Math.min(300, Math.max(20, tempo))
      for (const ev of events) {
        sampler.start({
          note: ev.midi,
          velocity: ev.vel,
          time: t0 + ev.startBeat * spb,
          duration: Math.min(ev.durBeats * spb + 0.4, 3.5),
        })
      }
    })
    .catch((err) => console.error('[audio] 钢琴音色加载失败', err))
}

/** 静停全部音频（sound.stop 命令）：作废排队中的播放 + 停掉全部采样器与合成器声部 */
export function stopAllAudio(): void {
  playNotesGen++
  stopSynth()
  for (const p of samplers.values()) {
    void p.then((s) => {
      try {
        s.stop()
      } catch {
        /* 实例未就绪/已释放忽略 */
      }
    })
  }
}

/** 节拍器短音（节奏组件用）：简单振荡器，无需采样。返回停用函数（换轮/清理时静停单轮已排程音） */
export function playClick(time: number, accent = false): () => void {
  const c = getCtx()
  const osc = c.createOscillator()
  const gain = c.createGain()
  osc.frequency.value = accent ? 1600 : 1000
  gain.gain.setValueAtTime(accent ? 0.5 : 0.3, time)
  gain.gain.exponentialRampToValueAtTime(0.001, time + 0.08)
  osc.connect(gain).connect(getMasterGain())
  osc.start(time)
  osc.stop(time + 0.1)
  return () => {
    try {
      osc.stop()
    } catch {
      /* 已停止的节点忽略 */
    }
  }
}

// ---------------------------------------------------------------------------
// 合成器声部（synth 组件用）：纯振荡器 + 包络，无采样加载、即点即响
// ---------------------------------------------------------------------------

export type SynthWave = 'sine' | 'triangle' | 'square' | 'sawtooth' | 'fm' | 'bell'

export interface SynthParams {
  wave: string
  tempo?: number
  /** 攻击/释放（秒）；音量 0-1；低通截止 Hz（0/缺省 = 不滤波） */
  attack?: number
  release?: number
  gain?: number
  cutoff?: number
}

/** 各音色的声部缺省：包络手感 + FM 调制参数（componentDef 的契约文档与此对应） */
const SYNTH_VOICE_DEFAULTS: Record<
  SynthWave,
  { attack: number; release: number; gainMul: number; decay?: boolean; fmRatio?: number; fmIndex?: number }
> = {
  sine: { attack: 0.02, release: 0.2, gainMul: 1 },
  triangle: { attack: 0.008, release: 0.18, gainMul: 0.9 },
  square: { attack: 0.004, release: 0.1, gainMul: 0.5 },
  sawtooth: { attack: 0.004, release: 0.12, gainMul: 0.55 },
  fm: { attack: 0.004, release: 0.35, gainMul: 0.8, fmRatio: 2, fmIndex: 3 },
  bell: { attack: 0.002, release: 0.9, gainMul: 0.65, decay: true, fmRatio: 3.5, fmIndex: 5 },
}

/** 已排程的合成器声部（stopSynth 静停 + 过期修剪） */
const synthVoices: { oscs: OscillatorNode[]; gain: GainNode; until: number }[] = []

/** 合成器播放代数：stopSynth 递增，排队中（等待解锁）的播放静默作废 */
let synthGen = 0

function midiToFreq(midi: number): number {
  return 440 * Math.pow(2, (midi - 69) / 12)
}

function pruneSynthVoices(c: AudioContext): void {
  const now = c.currentTime
  for (let i = synthVoices.length - 1; i >= 0; i--) {
    if (synthVoices[i].until < now) synthVoices.splice(i, 1)
  }
}

/** 生成单个声部：载波（FM 音色附加调制器）→ 可选低通 → 包络增益 → 输出 */
function synthVoice(c: AudioContext, midi: number, vel: number, t: number, dur: number, p: Required<Omit<SynthParams, 'tempo' | 'cutoff'>> & { cutoff: number; fmRatio?: number; fmIndex?: number; decay?: boolean }): void {
  const freq = midiToFreq(midi)
  // velocity（1-127）映射到 0.5-1 的增益系数
  const peak = Math.max(0.001, p.gain * (0.5 + 0.5 * (Math.min(127, Math.max(1, vel)) / 127)))
  const holdEnd = Math.max(t + p.attack + 0.03, t + dur)
  const end = holdEnd + p.release

  const env = c.createGain()
  env.gain.setValueAtTime(0.0001, t)
  env.gain.linearRampToValueAtTime(peak, t + Math.max(0.001, p.attack))
  // 可持续音色：setValue 在 holdEnd 保持电平（平顶 sustain），release 从 holdEnd 起算（评审 P1-1：
  // 若把 setValue 放在 attack 尾，指数释放会从 attack 后即开始插值，长音尾部近乎无声）；
  // 钟/拨弦类自然衰减：holdEnd 前完成指数衰减
  if (p.decay) env.gain.exponentialRampToValueAtTime(Math.max(0.0002, peak * 0.15), holdEnd)
  else env.gain.setValueAtTime(peak, holdEnd)
  env.gain.exponentialRampToValueAtTime(0.0001, end)

  let inNode: AudioNode = env
  if (p.cutoff > 0) {
    const filter = c.createBiquadFilter()
    filter.type = 'lowpass'
    filter.frequency.value = Math.min(12000, Math.max(40, p.cutoff))
    filter.connect(env)
    inNode = filter
  }
  env.connect(getMasterGain())

  const oscs: OscillatorNode[] = []
  const carrier = c.createOscillator()
  carrier.type = p.wave === 'fm' || p.wave === 'bell' ? 'sine' : (['sine', 'triangle', 'square', 'sawtooth'].includes(p.wave) ? (p.wave as OscillatorType) : 'sawtooth')
  carrier.frequency.value = freq
  if (p.fmRatio && p.fmIndex) {
    const mod = c.createOscillator()
    mod.type = 'sine'
    mod.frequency.value = freq * p.fmRatio
    const modGain = c.createGain()
    // 调制指数随时间衰减：起音明亮、随音头变纯（电钢/钟的"叮"感来源）
    modGain.gain.setValueAtTime(freq * p.fmIndex, t)
    modGain.gain.exponentialRampToValueAtTime(freq * 0.2, holdEnd)
    mod.connect(modGain).connect(carrier.frequency)
    mod.start(t)
    mod.stop(end + 0.05)
    oscs.push(mod)
  }
  carrier.connect(inNode)
  carrier.start(t)
  carrier.stop(end + 0.05)
  oscs.push(carrier)

  synthVoices.push({ oscs, gain: env, until: end + 0.1 })
}

/**
 * 合成器播放：与 playNotes 相同的 t/dur 排程语义（docs/27），声部为振荡器包络。
 * wave 不认识时回退 sawtooth；音色缺省参数见 SYNTH_VOICE_DEFAULTS。
 * 同样经 ensureRunning 取时间基准（挂起的上下文上排程会在解锁瞬间全部炸响）。
 */
export function playSynth(notes: Note[], params: SynthParams): Promise<void> {
  const gen = ++synthGen
  const queue = (async (): Promise<void> => {
    if (!Array.isArray(notes) || notes.length === 0) return
    const events = scheduleNoteEvents(notes)
    if (events.length === 0) return
    const c = await ensureRunning()
    if (gen !== synthGen) return // 排队期间 stopSynth：作废本轮（挂起排队幽灵音防线）
    const base = (SYNTH_VOICE_DEFAULTS as Record<string, (typeof SYNTH_VOICE_DEFAULTS)[SynthWave]>)[params.wave] ?? SYNTH_VOICE_DEFAULTS.sawtooth
    const attack = Math.min(2, Math.max(0, params.attack ?? base.attack))
    const release = Math.min(2.5, Math.max(0.01, params.release ?? base.release))
    const gain = Math.min(1, Math.max(0, params.gain ?? 0.35)) * base.gainMul
    const tempo = Math.min(300, Math.max(20, params.tempo ?? 90))
    const spb = 60 / tempo
    const cutoff = Math.min(12000, Math.max(0, params.cutoff ?? 0))
    pruneSynthVoices(c)
    const t0 = c.currentTime + 0.05
    for (const ev of events) {
      synthVoice(c, ev.midi, ev.vel, t0 + ev.startBeat * spb, Math.min(3.5, ev.durBeats * spb), {
        ...base,
        wave: params.wave,
        attack,
        release,
        gain,
        cutoff,
      })
    }
  })()
  queue.catch((err) => console.error('[audio] 合成器播放失败', err))
  return queue
}

/** 静停全部已排程/进行中的合成器声部（synth.stop 命令；换视图不自动调用——合成器与计时器同为逻辑侧资源） */
export function stopSynth(): void {
  synthGen++ // 排队中（等待解锁）的 playSynth 一并作废
  if (!ctx) return
  const now = ctx.currentTime
  for (const v of synthVoices) {
    try {
      const param = v.gain.gain
      // 支持 cancelAndHoldAtTime 的浏览器保留当前电平做 50ms 淡出（评审 P2-1：
      // 纯 cancel 会让 ramp 中途的声部电平弹回旧事件值，产生回跳/爆音）
      if (typeof (param as unknown as { cancelAndHoldAtTime?: (t: number) => void }).cancelAndHoldAtTime === 'function') {
        ;(param as unknown as { cancelAndHoldAtTime: (t: number) => void }).cancelAndHoldAtTime(now)
        param.setValueAtTime(Math.max(0.0001, param.value || 0.0001), now)
      } else {
        param.cancelScheduledValues(now)
        param.setValueAtTime(Math.max(0.0001, param.value || 0.0001), now)
      }
      param.exponentialRampToValueAtTime(0.0001, now + 0.05)
      v.oscs.forEach((o) => {
        try {
          o.stop(now + 0.08)
        } catch {
          /* 已停止的节点忽略 */
        }
      })
    } catch {
      /* 已断开的节点忽略 */
    }
  }
  synthVoices.length = 0
}
