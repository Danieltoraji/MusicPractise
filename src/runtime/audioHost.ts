/**
 * 音频效果宿主（批次9 从 LevelRunner 抽出）：把引擎产出的 audio.* 效果播到真实音频通道。
 * 游玩页（LevelRunner）与编辑器调试会话（debugRun）共用——调试画面要「正常游玩」的听感。
 */
import type { Effect } from './componentDef'
import { getCtx, playNotes, playSynth, stopSynth } from './audio'

export function runAudioEffects(effects: Effect[]): void {
  for (const eff of effects) {
    if (eff.type === 'audio.play') playNotes(eff.notes, eff.tempo)
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
  }
}

/** 供宿主取音频时钟（wait/定时相关表达式用），与播放同一上下文 */
export function nowSeconds(): number {
  return getCtx().currentTime
}
