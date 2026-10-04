/**
 * 五线谱视图（批次11 Bundle 瘦身拆分）：VexFlow 渲染与 tonal 音名换算约几百 KB，
 * 从 views.tsx 拆出按需加载——只有关卡真的用到 staff 组件时才下载。
 * 对外形状与拆分前完全一致（StaffView/toStaveNotes）。
 */
import { useEffect, useRef } from 'react'
import { Accidental, Dot, Formatter, Renderer, Stave, StaveNote, Voice } from 'vexflow'
import { Note } from 'tonal'
import type { MusicDoc } from '../engine/level'
import type { Json } from '../engine/expr'
import type { StaffState } from '../runtime/componentDef'
import { boxStyle, useComponentState, type ViewProps } from './views'

const DUR_MAP: Record<string, string> = { '1n': 'w', '2n': 'h', '4n': 'q', '8n': '8', '16n': '16', '32n': '32' }
const HIGHLIGHT_FILL: Record<string, string> = { correct: '#16a34a', wrong: '#dc2626' }

/** MusicDoc → VexFlow 音符数组（纯函数，便于单测：音位/附点/升降号/休止符） */
export function toStaveNotes(doc: MusicDoc): StaveNote[] {
  const clef = doc.clef ?? 'treble'
  return doc.notes.map((n) => {
    // 音位由 StaveNote 自身的 clef 决定（与 Stave 上画的谱号无关），必须显式传入
    const dur = n.dur ?? '4n'
    const dotted = dur.endsWith('.')
    const base = DUR_MAP[dotted ? dur.slice(0, -1) : dur] ?? 'q'
    if (n.rest === true || typeof n.midi !== 'number') {
      // 休止符：VexFlow 记法 duration 'qr'（keys 仅为占位，渲染忽略）
      const rest = new StaveNote({ keys: ['b/4'], duration: `${base}r`, clef })
      if (dotted) rest.addModifier(new Dot(), 0)
      return rest
    }
    const info = Note.get(Note.fromMidi(n.midi) ?? 'C4')
    const sn = new StaveNote({
      keys: [`${info.letter.toLowerCase()}${info.acc ?? ''}/${info.oct}`],
      duration: base,
      clef,
    })
    if (info.acc) sn.addModifier(new Accidental(info.acc), 0)
    if (dotted) sn.addModifier(new Dot(), 0)
    return sn
  })
}

export function StaffView({ spec, store, emit }: ViewProps) {
  const { music, highlights, clearToken } = useComponentState<StaffState>(store, spec.id)
  const containerRef = useRef<HTMLDivElement>(null)
  const clickable = ((spec.props ?? {}) as Record<string, Json>).clickable !== false

  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    el.innerHTML = ''
    const w = spec.layout?.w ?? 720
    const h = spec.layout?.h ?? 160
    const hasMusic = music !== null && music !== undefined && Array.isArray((music as { notes?: unknown }).notes)
    const doc = hasMusic ? (music as unknown as MusicDoc) : null

    // 谱架始终绘制：行数据尚未装载（预览/首帧）也呈现五线谱形态，而不是空白盒
    const renderer = new Renderer(el, Renderer.Backends.SVG)
    renderer.resize(w, h)
    const rc = renderer.getContext()
    const stave = new Stave(10, Math.max(10, h / 2 - 50), w - 30)
    stave.addClef(doc?.clef ?? 'treble')
    if (doc?.timeSig) stave.addTimeSignature(`${doc.timeSig[0]}/${doc.timeSig[1]}`)
    stave.setContext(rc).draw()
    if (!doc) return

    const staveNotes = toStaveNotes(doc)

    const voice = new Voice({ numBeats: Math.max(1, staveNotes.length), beatValue: 4 }).setStrict(false)
    voice.addTickables(staveNotes)
    new Formatter().joinVoices([voice]).format([voice], Math.max(120, w - 120))
    voice.draw(rc, stave)

    // 命中区域：VexFlow 5 不再暴露 attrs.el；voice.draw 按顺序把每个音符画成
    // SVG 根下的 g.vf-stavenote，用 DOM 顺序与 notes[] 对齐（v1 仅支持单声部）。
    // 休止符也是 vf-stavenote（无音头）：数量对不齐时整体跳过命中区，防错位
    const noteGroups = el.querySelectorAll('svg > g.vf-stavenote')
    if (noteGroups.length === doc.notes.length) {
      noteGroups.forEach((svgEl, i) => {
        const midi = doc.notes[i]?.midi
        if (typeof midi !== 'number') return
        if (!svgEl) return
        svgEl.setAttribute('data-midi', String(midi))
        if (!clickable) return
        ;(svgEl as HTMLElement).style.cursor = 'pointer'
        svgEl.addEventListener('click', () => {
          store.applyCommand(spec.id, '__strike', { midi })
          emit('noteClicked', { midi, name: Note.fromMidi(midi) })
        })
        // 触屏/精确指针热区垫（批次12）：音头太小难命中——在 g 内加透明外扩矩形，
        // 点击冒泡到 g 的既有 listener（零重复处理）。getBBox jsdom 无实现，守卫跳过
        const svgGroup = svgEl as SVGGElement
        if (typeof svgGroup.getBBox !== 'function') return
        try {
          const bb = svgGroup.getBBox()
          const pad = Math.min(18, Math.max(8, bb.width * 0.3))
          const padEl = document.createElementNS('http://www.w3.org/2000/svg', 'rect')
          padEl.setAttribute('x', String(bb.x - pad))
          padEl.setAttribute('y', String(bb.y - pad))
          padEl.setAttribute('width', String(bb.width + pad * 2))
          padEl.setAttribute('height', String(bb.height + pad * 2))
          padEl.setAttribute('fill', 'transparent')
          padEl.setAttribute('pointer-events', 'all')
          padEl.setAttribute('data-hitpad', String(midi))
          svgEl.appendChild(padEl)
        } catch {
          // getBBox 失败（隐藏容器等）：无垫，音头本体仍可点
        }
      })
    }

    // 高亮样式
    for (const [midiStr, style] of Object.entries(highlights ?? {})) {
      const fill = HIGHLIGHT_FILL[style] ?? '#f59e0b'
      noteGroups.forEach((svgEl, i) => {
        if (doc.notes[i]?.midi !== Number(midiStr)) return
        svgEl.querySelectorAll('.vf-notehead').forEach((head) => {
          head.setAttribute('fill', fill)
          head.setAttribute('stroke', fill)
        })
      })
    }
  }, [music, highlights, clearToken, spec.layout?.w, spec.layout?.h, clickable, emit])

  return <div ref={containerRef} style={boxStyle(spec)} className="comp-staff" />
}
