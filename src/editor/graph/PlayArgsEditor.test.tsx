// 播放参数可视化编辑器（sound/synth.play）：解析/序列化纯函数 + 组件交互
// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'
import { parseNoteList, parsePlayArgs, serializePlayArgs, serializeNoteList, PlayArgsEditor } from './PlayArgsEditor'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const roots: Root[] = []
const containers: HTMLElement[] = []

function renderEl(ui: React.ReactElement): HTMLElement {
  const container = document.createElement('div')
  document.body.appendChild(container)
  let root!: Root
  act(() => {
    root = createRoot(container)
    root.render(ui)
  })
  roots.push(root)
  containers.push(container)
  return container
}

afterEach(() => {
  roots.splice(0).forEach((r) => act(() => r.unmount()))
  containers.splice(0).forEach((c) => c.remove())
})

describe('parseNoteList / serializeNoteList', () => {
  it('音符数组解析（midi/dur）', () => {
    expect(parseNoteList("[{midi: 60, dur: '4n'}, {midi: 64}]")).toEqual([
      { midi: 60, dur: '4n' },
      { midi: 64, dur: '4n' },
    ])
    expect(parseNoteList('[]')).toEqual([])
    expect(parseNoteList("[{midi: 60, vel: 100}]")).toBeNull() // 未知键不可编辑
    expect(parseNoteList('q.data.notes')).toBeNull()
    expect(parseNoteList('[{midi: x}]')).toBeNull()
    expect(serializeNoteList([{ midi: 60, dur: '4n' }, { midi: 64, dur: '8n' }])).toBe("[{midi: 60, dur: '4n'}, {midi: 64, dur: '8n'}]")
  })
})

describe('parsePlayArgs / serializePlayArgs', () => {
  it('完整解析：notes/wave/tempo/mode + 未知键透传', () => {
    const p = parsePlayArgs(["{notes: [{midi: 60, dur: '4n'}], wave: 'fm', tempo: 96, mode: 'seq', gain: 0.5}"])
    expect(p).not.toBeNull()
    expect(p!.dynamic).toBe(false)
    expect(p!.notes).toEqual([{ midi: 60, dur: '4n' }])
    expect(p!.wave).toBe('fm')
    expect(p!.tempo).toBe(96)
    expect(p!.mode).toBe('seq')
    expect(p!.extraEntries).toEqual([{ key: 'gain', source: '0.5' }])
    const args = serializePlayArgs(p!)
    expect(args[0]).toContain('notes: [{midi: 60, dur: \'4n\'}]')
    expect(args[0]).toContain("wave: 'fm'")
    expect(args[0]).toContain('gain: 0.5')
  })

  it('动态 notes 表达式：dynamic=true 且原文保留', () => {
    const p = parsePlayArgs(["{notes: q.data.notes, tempo: 90}"])
    expect(p!.dynamic).toBe(true)
    expect(p!.notesSource).toBe('q.data.notes')
    const args = serializePlayArgs(p!)
    expect(args[0]).toContain('notes: q.data.notes')
  })

  it('缺参/非对象回落 null', () => {
    expect(parsePlayArgs([])).toBeNull()
    expect(parsePlayArgs(['5'])).toBeNull()
  })
})

describe('PlayArgsEditor 组件', () => {
  it('渲染音符 chips 与参数控件；删除音符正确回写', () => {
    const writes: string[][] = []
    const c = renderEl(
      <PlayArgsEditor
        args={["{notes: [{midi: 60, dur: '4n'}, {midi: 64, dur: '8n'}], wave: 'sine', tempo: 100}"]}
        kind="synth"
        ctx={{ varNames: [], refPaths: [] }}
        onChange={(a) => writes.push(a)}
      />,
    )
    expect(c.textContent).toContain('音符序列')
    expect(c.querySelectorAll('.play-note:not(.play-note-add):not(.play-note-freq)')).toHaveLength(2)
    const selVals = [...c.querySelectorAll('.play-params select')].map((s) => (s as HTMLSelectElement).value)
    console.log('PARAM SELS:', JSON.stringify(selVals), '| kind marker in DOM:', c.textContent?.includes('音色（wave）'))
    expect(selVals.some((v) => v === 'sine')).toBe(true)
    // 删除第一个音符（midi 60）：回写只剩余 midi 64
    act(() => (c.querySelectorAll('.play-note .play-note-del')[0] as HTMLElement).click())
    expect(writes.at(-1)![0]).toBe("{notes: [{midi: 64, dur: '8n'}], wave: 'sine', tempo: 100}")
  })

  it('动态 notes：回落高级模式并提示', () => {
    const c = renderEl(<PlayArgsEditor args={["{notes: q.data.notes}"]} kind="sound" ctx={{ varNames: [], refPaths: [] }} onChange={() => {}} />)
    expect(c.textContent).toContain('来自表达式')
    expect(c.textContent).toContain('高级')
  })
})
