/**
 * 音频引擎：全局单例 AudioContext + smplr 采样钢琴。
 * 一切调度以 AudioContext.currentTime 为唯一时间基准。
 * 钢琴采样器（smplr）按需加载：首次 audio.play 才动态 import——首页与纯节奏/合成器关卡无需下载（批次11）。
 */
import type { SplendidGrandPiano } from 'smplr'
import type { Note } from '../engine/level'
import type { SoundInstrument } from './componentDef'

let ctx: AudioContext | null = null
let piano: SplendidGrandPiano | null = null
let pianoLoading: Promise<SplendidGrandPiano> | null = null
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

function ensurePiano(): Promise<SplendidGrandPiano> {
  if (piano) return Promise.resolve(piano)
  if (!pianoLoading) {
    pianoLoading = (async () => {
      const { SplendidGrandPiano: Piano } = await import('smplr')
      const p = new Piano(getCtx(), { destination: getMasterGain() })
      await p.ready
      piano = p
      return p
    })()
    pianoLoading.catch(() => {
      pianoLoading = null
    })
  }
  return pianoLoading
}

// 采样器注册表（批次13）：instrument → 已装载实例；全部接主总线，按需动态 import smplr
type AnySampler = { ready: Promise<unknown>; start(opts: { note: number; velocity: number; time: number; duration: number }): void }
const samplers = new Map<SoundInstrument, Promise<AnySampler>>()

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
        const s = new smplr.SplendidGrandPiano(c, { destination: dest })
        await s.ready
        return s as unknown as AnySampler
      }
    }
  })()
  loading.catch(() => samplers.delete(instrument))
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
  getCtx()
  const samplerReady = instrument === 'piano' ? ensurePiano() : ensureSampler(instrument)
  samplerReady
    .then((p) => {
      const t0 = getCtx().currentTime + 0.06
      const spb = 60 / Math.min(300, Math.max(20, tempo))
      for (const ev of events) {
        p.start({
          note: ev.midi,
          velocity: ev.vel,
          time: t0 + ev.startBeat * spb,
          duration: Math.min(ev.durBeats * spb + 0.4, 3.5),
        })
      }
    })
    .catch((err) => console.error('[audio] 钢琴音色加载失败', err))
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
 */
export function playSynth(notes: Note[], params: SynthParams): void {
  if (!Array.isArray(notes) || notes.length === 0) return
  const events = scheduleNoteEvents(notes)
  if (events.length === 0) return
  const c = getCtx()
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
}

/** 静停全部已排程/进行中的合成器声部（synth.stop 命令；换视图不自动调用——合成器与计时器同为逻辑侧资源） */
export function stopSynth(): void {
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
