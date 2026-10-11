/**
 * 音频效果宿主（批次9 从 LevelRunner 抽出）：把引擎产出的 audio.* 效果播到真实音频通道。
 * 游玩页（LevelRunner）与编辑器调试会话（debugRun）共用——调试画面要「正常游玩」的听感。
 */
import type { LevelDoc } from '../engine/level'
import type { Effect, SoundInstrument } from './componentDef'
import { isSoundInstrument } from './componentDef'
import { getCtx, playNotes, playSynth, preloadAudio, stopAllAudio, stopSynth } from './audio'

export function runAudioEffects(effects: Effect[]): void {
  for (const eff of effects) {
    if (eff.type === 'audio.play') playNotes(eff.notes, eff.tempo, eff.instrument)
    else if (eff.type === 'audio.synth')
      playSynth(eff.notes, {
        wave: eff.wave,
        tempo: eff.tempo,
        attack: eff.attack,
        release: eff.release,
        gain: eff.gain,
        cutoff: eff.cutoff,
      })
    else if (eff.type === 'audio.synthStop') stopSynth()
    else if (eff.type === 'audio.stop') stopAllAudio()
  }
}

/**
 * 关卡装载预热：扫描组件清单提前加载采样音色（首击延迟根因——钢琴全音域 169 个采样
 * 文件，此前首次 play 才开始下载，首个音符要等全部就绪）。staff/fingering 的点击试听
 * 固定走钢琴；sound 组件按 props.instrument 精确预热。下载不依赖用户手势，进关即开始。
 */
export function preloadLevelAudio(doc: LevelDoc): void {
  const instruments = new Set<SoundInstrument>()
  for (const c of doc.content.components) {
    if (c.type === 'staff' || c.type === 'fingering') {
      instruments.add('piano')
      continue
    }
    if (c.type === 'sound') {
      const inst = (c.props ?? {}) as Record<string, unknown>
      instruments.add(isSoundInstrument(inst.instrument) ? inst.instrument : 'piano')
    }
  }
  if (instruments.size > 0) preloadAudio([...instruments])
}

/** 供宿主取音频时钟（wait/定时相关表达式用），与播放同一上下文 */
export function nowSeconds(): number {
  return getCtx().currentTime
}
