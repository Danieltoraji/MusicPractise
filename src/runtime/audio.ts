/**
 * 音频引擎：全局单例 AudioContext + smplr 采样钢琴。
 * 一切调度以 AudioContext.currentTime 为唯一时间基准。
 */
import { SplendidGrandPiano } from 'smplr'
import type { Note } from '../engine/level'

let ctx: AudioContext | null = null
let piano: SplendidGrandPiano | null = null
let pianoLoading: Promise<SplendidGrandPiano> | null = null

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
      const p = new SplendidGrandPiano(getCtx(), {})
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

/** 时值记法（"4n"、"2n."…）→ 秒 */
export function durToSeconds(dur: string, tempo = 90): number {
  const dotted = dur.endsWith('.')
  const base = dotted ? dur.slice(0, -1) : dur
  const map: Record<string, number> = { '1n': 4, '2n': 2, '4n': 1, '8n': 0.5, '16n': 0.25, '32n': 0.125 }
  const quarters = map[base]
  if (quarters === undefined) {
    console.warn(`[audio] 未知时值 "${dur}"，按四分音符处理`)
    return 60 / tempo
  }
  return (quarters * 60) / tempo * (dotted ? 1.5 : 1)
}

/**
 * 播放一组音符。
 * - chord（缺省）：25ms 微琶音，适合和弦
 * - seq：按每个音的 dur 在 tempo 网格上逐音排程（旋律播放，听写类关卡用）
 * velocity 为 MIDI 尺度 1-127（smplr 语义）。
 */
export function playNotes(notes: Note[], tempo = 90, mode: 'chord' | 'seq' = 'chord'): void {
  if (!Array.isArray(notes) || notes.length === 0) return
  getCtx()
  ensurePiano()
    .then((p) => {
      const t0 = getCtx().currentTime + 0.06
      let t = t0
      notes.forEach((n, i) => {
        if (typeof n?.midi !== 'number') return
        // smplr 的 velocity 是 0-127 MIDI 尺度；0 会被速度分层拒绝导致静音，钳到 1
        const vel = typeof n.vel === 'number' ? Math.min(127, Math.max(1, Math.round(n.vel))) : 100
        if (mode === 'seq') {
          const dur = durToSeconds(n.dur ?? '4n', tempo)
          p.start({ note: n.midi, velocity: vel, time: t, duration: Math.min(dur + 0.4, 3.5) })
          t += dur
        } else {
          const dur = Math.min(durToSeconds(n.dur ?? '4n', tempo) + 0.5, 3.5)
          p.start({ note: n.midi, velocity: vel, time: t0 + i * 0.025, duration: dur })
        }
      })
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
  osc.connect(gain).connect(c.destination)
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
  mode?: 'chord' | 'seq'
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
function synthVoice(c: AudioContext, midi: number, vel: number, t: number, dur: number, p: Required<Omit<SynthParams, 'tempo' | 'mode' | 'cutoff'>> & { cutoff: number; fmRatio?: number; fmIndex?: number; decay?: boolean }): void {
  const freq = midiToFreq(midi)
  // velocity（1-127）映射到 0.5-1 的增益系数
  const peak = Math.max(0.001, p.gain * (0.5 + 0.5 * (Math.min(127, Math.max(1, vel)) / 127)))
  const holdEnd = Math.max(t + p.attack + 0.03, t + dur)
  const end = holdEnd + p.release

  const env = c.createGain()
  env.gain.setValueAtTime(0.0001, t)
  env.gain.linearRampToValueAtTime(peak, t + Math.max(0.001, p.attack))
  // 可持续音色保持电平；钟/拨弦类自然衰减
  if (p.decay) env.gain.exponentialRampToValueAtTime(Math.max(0.0002, peak * 0.15), holdEnd)
  else env.gain.setValueAtTime(peak, Math.min(t + p.attack + 0.001, holdEnd))
  env.gain.exponentialRampToValueAtTime(0.0001, end)

  let inNode: AudioNode = env
  if (p.cutoff > 0) {
    const filter = c.createBiquadFilter()
    filter.type = 'lowpass'
    filter.frequency.value = Math.min(12000, Math.max(40, p.cutoff))
    filter.connect(env)
    inNode = filter
  }
  env.connect(c.destination)

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
 * 合成器播放：与 playNotes 相同的 chord/seq 排程语义，声部为振荡器包络。
 * wave 不认识时回退 sawtooth；音色缺省参数见 SYNTH_VOICE_DEFAULTS。
 */
export function playSynth(notes: Note[], params: SynthParams): void {
  if (!Array.isArray(notes) || notes.length === 0) return
  const c = getCtx()
  const base = (SYNTH_VOICE_DEFAULTS as Record<string, (typeof SYNTH_VOICE_DEFAULTS)[SynthWave]>)[params.wave] ?? SYNTH_VOICE_DEFAULTS.sawtooth
  const attack = Math.min(2, Math.max(0, params.attack ?? base.attack))
  const release = Math.min(2.5, Math.max(0.01, params.release ?? base.release))
  const gain = Math.min(1, Math.max(0, params.gain ?? 0.35)) * base.gainMul
  const tempo = Math.min(300, Math.max(20, params.tempo ?? 90))
  const cutoff = Math.min(12000, Math.max(0, params.cutoff ?? 0))
  pruneSynthVoices(c)
  const t0 = c.currentTime + 0.05
  let t = t0
  notes.forEach((n, i) => {
    if (typeof n?.midi !== 'number') return
    const vel = typeof n.vel === 'number' ? Math.min(127, Math.max(1, Math.round(n.vel))) : 100
    if (params.mode === 'seq') {
      const dur = Math.min(3, durToSeconds(n.dur ?? '4n', tempo))
      synthVoice(c, n.midi, vel, t, dur, { ...base, wave: params.wave, attack, release, gain, cutoff })
      t += dur
    } else {
      const dur = Math.min(3, durToSeconds(n.dur ?? '4n', tempo) + 0.3)
      synthVoice(c, n.midi, vel, t0 + i * 0.02, dur, { ...base, wave: params.wave, attack, release, gain, cutoff })
    }
  })
}

/** 静停全部已排程/进行中的合成器声部（synth.stop 命令；换视图不自动调用——合成器与计时器同为逻辑侧资源） */
export function stopSynth(): void {
  if (!ctx) return
  const now = ctx.currentTime
  for (const v of synthVoices) {
    try {
      v.gain.gain.cancelScheduledValues(now)
      v.gain.gain.setValueAtTime(Math.max(0.0001, v.gain.gain.value || 0.0001), now)
      v.gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.05)
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
