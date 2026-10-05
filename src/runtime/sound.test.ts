// sound 组件契约测试：instrument 装载与 play 效果透传（批次13 采样音色扩展）
import { describe, expect, it } from 'vitest'
import type { ComponentInstance } from '../engine/level'
import { SOUND_DEF } from './componentDef'

const spec = (props?: Record<string, unknown>): ComponentInstance =>
  ({ id: 'sound1', type: 'sound', ...(props ? { props } : {}) }) as ComponentInstance

describe('SOUND_DEF instrument（批次13）', () => {
  it('缺省钢琴：无 props 时 instrument 兜底 piano，旧关卡行为不变', () => {
    const s = SOUND_DEF.initialState(spec())
    expect(s.instrument).toBe('piano')
    const r = SOUND_DEF.applyCommand(s, 'play', { notes: [{ midi: 60 }] })
    expect(r.effects?.[0]).toEqual({ type: 'audio.play', notes: [{ midi: 60 }], tempo: undefined, instrument: 'piano' })
  })

  it('props.instrument 装载进状态并随 play 下发（电钢/木琴）；非法值回落钢琴', () => {
    const ep = SOUND_DEF.initialState(spec({ instrument: 'electric-piano' }))
    expect(ep.instrument).toBe('electric-piano')
    const r = SOUND_DEF.applyCommand(ep, 'play', { notes: [{ midi: 64 }], tempo: 120 })
    expect(r.effects?.[0]).toMatchObject({ type: 'audio.play', instrument: 'electric-piano' })

    const mallet = SOUND_DEF.initialState(spec({ instrument: 'mallet' }))
    expect(mallet.instrument).toBe('mallet')

    const bad = SOUND_DEF.initialState(spec({ instrument: 'honky-tonk' }))
    expect(bad.instrument).toBe('piano')
  })
})
