// 合成器组件契约测试：play/setWave/stop 的效果产出、参数钳制与状态持久化
import { describe, expect, it } from 'vitest'
import type { ComponentInstance } from '../engine/level'
import { SYNTH_DEF } from './componentDef'
import { ComponentStore } from './store'

const spec = (props?: Record<string, unknown>): ComponentInstance =>
  ({ id: 'synth1', type: 'synth', ...(props ? { props } : {}) }) as ComponentInstance

describe('SYNTH_DEF（合成器契约）', () => {
  it('initialState：props 音色/音量；非法音色回退 sawtooth，音量钳 0-1', () => {
    expect(SYNTH_DEF.initialState(spec())).toMatchObject({ wave: 'sawtooth', gain: 0.35, lastPlay: null, playSeq: 0 })
    expect(SYNTH_DEF.initialState(spec({ wave: 'square', gain: 0.5 }))).toMatchObject({ wave: 'square', gain: 0.5 })
    expect(SYNTH_DEF.initialState(spec({ wave: 'laser', gain: 9 }))).toMatchObject({ wave: 'sawtooth', gain: 1 })
    expect(SYNTH_DEF.initialState(spec({ gain: -3 }))).toMatchObject({ gain: 0 })
  })

  it('play：产出 audio.synth 效果；未传 wave/gain 用状态值，传入则覆盖并持久化', () => {
    const s0 = SYNTH_DEF.initialState(spec({ wave: 'square', gain: 0.5 }))
    const r = SYNTH_DEF.applyCommand(s0, 'play', { notes: [{ midi: 60 }], tempo: 120 })
    expect(r.effects).toEqual([
      { type: 'audio.synth', notes: [{ midi: 60 }], wave: 'square', tempo: 120, mode: 'chord', attack: undefined, release: undefined, gain: 0.5, cutoff: undefined },
    ])
    expect(r.state).toMatchObject({ playSeq: 1, lastPlay: [{ midi: 60 }] })
    // 传入 wave：本次效果用传入值，且状态持久化（后续 play 沿用）
    const r2 = SYNTH_DEF.applyCommand(r.state, 'play', { notes: [{ midi: 64 }], wave: 'bell' })
    expect(r2.effects![0]).toMatchObject({ wave: 'bell' })
    expect(r2.state.wave).toBe('bell')
  })

  it('play 参数钳制：tempo/attack/release/gain/cutoff 越界收敛；mode 非法回退 chord', () => {
    const s0 = SYNTH_DEF.initialState(spec())
    const r = SYNTH_DEF.applyCommand(s0, 'play', {
      notes: [{ midi: 60 }],
      tempo: 9999,
      attack: 9,
      release: -1,
      gain: 5,
      cutoff: 99999,
      mode: 'loop',
    })
    expect(r.effects![0]).toMatchObject({ tempo: 300, attack: 2, release: 0, gain: 1, cutoff: 12000, mode: 'chord' })
  })

  it('play：notes 非数组时效果仍产出但音符为空，lastPlay 记 null', () => {
    const s0 = SYNTH_DEF.initialState(spec())
    const r = SYNTH_DEF.applyCommand(s0, 'play', { notes: 'C4' })
    expect(r.effects![0]).toMatchObject({ type: 'audio.synth', notes: [] })
    expect(r.state.lastPlay).toBeNull()
  })

  it('setWave / stop：切音色持久化；stop 产出 audio.synthStop 并清 lastPlay', () => {
    const s0 = SYNTH_DEF.initialState(spec({ wave: 'square' }))
    const r1 = SYNTH_DEF.applyCommand(s0, 'setWave', { wave: 'fm' })
    expect(r1.state.wave).toBe('fm')
    const r2 = SYNTH_DEF.applyCommand(s0, 'setWave', { wave: 'nope' })
    expect(r2.state.wave).toBe('square')
    const withPlay = SYNTH_DEF.applyCommand(s0, 'play', { notes: [{ midi: 60 }] })
    const r3 = SYNTH_DEF.applyCommand(withPlay.state, 'stop', {})
    expect(r3.effects).toEqual([{ type: 'audio.synthStop' }])
    expect(r3.state.lastPlay).toBeNull()
  })
})

describe('synth 经 ComponentStore（效果进 sink 统一执行通道）', () => {
  it('applyCommand 返回效果且 sink 收到 audio.synth / audio.synthStop', () => {
    const store = new ComponentStore()
    store.init([spec({ wave: 'bell' })])
    const sunk: unknown[] = []
    store.setEffectSink((_cid, effects) => sunk.push(...effects))
    const effects = store.applyCommand('synth1', 'play', { notes: [{ midi: 72 }] })
    expect(effects[0]).toMatchObject({ type: 'audio.synth', wave: 'bell' })
    expect(sunk).toHaveLength(1)
    const stopEffects = store.applyCommand('synth1', 'stop', {})
    expect(stopEffects[0]).toMatchObject({ type: 'audio.synthStop' })
    expect(sunk).toHaveLength(2)
  })

  it('未知音色 setWave 被 store 侧同样钳制（状态不损坏）', () => {
    const store = new ComponentStore()
    store.init([spec()])
    store.applyCommand('synth1', 'setWave', { wave: 42 })
    expect(store.snapshot('synth1').state).toMatchObject({ wave: 'sawtooth' })
  })
})
