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

/** 节拍器短音（节奏 demo 用）：简单振荡器，无需采样 */
export function playClick(time: number, accent = false): void {
  const c = getCtx()
  const osc = c.createOscillator()
  const gain = c.createGain()
  osc.frequency.value = accent ? 1600 : 1000
  gain.gain.setValueAtTime(accent ? 0.5 : 0.3, time)
  gain.gain.exponentialRampToValueAtTime(0.001, time + 0.08)
  osc.connect(gain).connect(c.destination)
  osc.start(time)
  osc.stop(time + 0.1)
}
