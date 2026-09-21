/**
 * 播放类命令（sound.play / synth.play）的音符可视化编辑器：
 * - 音符序列：NoteChipsEditor（音名/时值/频率换算，共用组件）
 * - synth 附加音色（wave）下拉；tempo/mode 数字与下拉
 * - notes 来自动态表达式（如 q.data.notes）时自动回落「高级」模式并保留原文
 * 解析/序列化为纯函数导出（可单测）。
 */
import { useMemo, useState } from 'react'
import { splitObjectLiteral } from './exprBridge'
import { SYNTH_WAVES } from '../../runtime/componentDef'
import { CallArgsEditor } from './controls'
import { NoteChipsEditor, type PlayNote } from './NoteChipsEditor'

export type { PlayNote } from './NoteChipsEditor'

// ---------------------------------------------------------------------------
// 纯函数：解析 / 序列化
// ---------------------------------------------------------------------------

export interface ParsedPlayArgs {
  /** notes 无法静态解析（动态表达式）→ 音符编辑器不可用，回落高级 */
  dynamic: boolean
  notes: PlayNote[]
  wave?: string
  tempo?: number
  mode?: 'chord' | 'seq'
  /** play 契约之外的键原样透传（如 attack/release/gain/cutoff 走高级编辑） */
  extraEntries: { key: string; source: string }[]
  /** notes 的原始源文本（dynamic 时回写用） */
  notesSource: string
  entries: { key: string; source: string }[]
}

/** 顶层逗号切分（引号/括号感知）；配对失败返回 null */
function splitTopLevel(src: string): string[] | null {
  const parts: string[] = []
  let depth = 0
  let quote: string | null = null
  let cur = ''
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]
    if (quote) {
      cur += ch
      if (ch === '\\') {
        cur += src[i + 1] ?? ''
        i++
      } else if (ch === quote) {
        quote = null
      }
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      cur += ch
      continue
    }
    if (ch === '{' || ch === '[' || ch === '(') {
      depth++
      cur += ch
      continue
    }
    if (ch === '}' || ch === ']' || ch === ')') {
      depth--
      cur += ch
      continue
    }
    if (ch === ',' && depth === 0) {
      parts.push(cur)
      cur = ''
      continue
    }
    cur += ch
  }
  if (depth !== 0 || quote !== null) return null
  parts.push(cur)
  return parts
}

/** 字符串字面量 → 值（'x' / "x"）；非字面量返回 null */
function stringLiteral(src: string): string | null {
  const m = /^["']([\s\S]*)["']$/.exec(src.trim())
  return m ? m[1] : null
}

/** 数字字面量 → 值 */
function numberLiteral(src: string): number | null {
  const t = src.trim()
  if (!/^-?\d+(\.\d+)?$/.test(t)) return null
  return Number(t)
}

/** 标识符字面量 → 值（chord / seq / true …） */
function identLiteral(src: string): string | null {
  const t = src.trim()
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(t) ? t : null
}

/** 解析 `[{midi: 60, dur: '4n'}, …]` 形态的音符数组；任何不符返回 null */
export function parseNoteList(src: string): PlayNote[] | null {  const t = src.trim()
  if (!t.startsWith('[') || !t.endsWith(']')) return null
  const inner = t.slice(1, -1)
  if (inner.trim() === '') return []
  const parts = splitTopLevel(inner)
  if (parts === null) return null
  const out: PlayNote[] = []
  for (const part of parts) {
    const entries = splitObjectLiteral(part.trim())
    if (entries === null) return null
    let midi: number | null = null
    let dur = '4n'
    for (const e of entries) {
      if (e.key === 'midi') midi = numberLiteral(e.source)
      else if (e.key === 'dur') dur = stringLiteral(e.source) ?? dur
      // 其它键（vel 等）原样保留在序列化时…… 为简化：仅支持 midi/dur，出现其它键视为不可编辑
      else return null
    }
    if (midi === null || !Number.isFinite(midi)) return null
    out.push({ midi: Math.round(midi), dur })
  }
  return out
}

export function serializeNoteList(notes: PlayNote[]): string {
  return `[${notes.map((n) => `{midi: ${n.midi}, dur: '${n.dur}'}`).join(', ')}]`
}

/** 解析 play 参数（args[0] 的对象字面量）；结构不符返回 null（调用方回落高级） */
export function parsePlayArgs(args: string[]): ParsedPlayArgs | null {
  if (!Array.isArray(args) || args.length !== 1) return null
  const entries = splitObjectLiteral(args[0] ?? '')
  if (entries === null) return null
  const parsed: ParsedPlayArgs = {
    dynamic: false,
    notes: [],
    wave: undefined,
    tempo: undefined,
    mode: undefined,
    extraEntries: [],
    notesSource: '',
    entries,
  }
  for (const e of entries) {
    if (e.key === 'notes') {
      parsed.notesSource = e.source
      const list = parseNoteList(e.source)
      if (list === null) parsed.dynamic = true
      else parsed.notes = list
    } else if (e.key === 'wave') {
      parsed.wave = stringLiteral(e.source) ?? identLiteral(e.source) ?? undefined
    } else if (e.key === 'tempo') {
      parsed.tempo = numberLiteral(e.source) ?? undefined
    } else if (e.key === 'mode') {
      const m = stringLiteral(e.source) ?? identLiteral(e.source)
      parsed.mode = m === 'seq' ? 'seq' : m === 'chord' ? 'chord' : undefined
    } else {
      parsed.extraEntries.push(e)
    }
  }
  return parsed
}

/** 序列化回 args（单对象字面量）；extra 键原样拼回 */
export function serializePlayArgs(p: ParsedPlayArgs): string[] {
  const parts: string[] = []
  parts.push(p.dynamic ? `notes: ${p.notesSource}` : `notes: ${serializeNoteList(p.notes)}`)
  if (p.wave !== undefined) parts.push(`wave: '${p.wave}'`)
  if (p.tempo !== undefined) parts.push(`tempo: ${p.tempo}`)
  if (p.mode !== undefined) parts.push(`mode: '${p.mode}'`)
  for (const e of p.extraEntries) parts.push(`${e.key}: ${e.source}`)
  return [`{${parts.join(', ')}}`]
}

// ---------------------------------------------------------------------------
// UI
// ---------------------------------------------------------------------------

export function PlayArgsEditor(props: {
  args: string[]
  /** 组件类型：sound（notes/tempo/mode）或 synth（附加 wave） */
  kind: 'sound' | 'synth'
  ctx: { varNames: string[]; refPaths: string[] }
  onChange: (args: string[]) => void
}): React.ReactElement {
  const parsed = useMemo(() => parsePlayArgs(props.args), [props.args])
  const [advanced, setAdvanced] = useState(parsed === null)

  // 完全不可解析（动态表达式等）→ 只出高级模式
  if (parsed === null || advanced) {
    return (
      <div className="play-args">
        {parsed !== null && (
          <button type="button" onClick={() => setAdvanced(false)}>
            ← 基础模式（音符编辑）
          </button>
        )}
        {parsed === null && <div className="muted play-args-hint">notes 来自动态表达式，已保留原文（可用高级模式微调其它参数）</div>}
        <CallArgsEditor args={props.args} params={null} ctx={props.ctx} onChange={props.onChange} />
      </div>
    )
  }

  const write = (patch: Partial<ParsedPlayArgs>): void => {
    props.onChange(serializePlayArgs({ ...parsed, ...patch }))
  }

  return (
    <div className="play-args">
      <div className="play-notes">
        <span className="muted play-notes-label">音符序列</span>
        {parsed.dynamic ? (
          <span className="muted">notes 来自表达式（{parsed.notesSource}），如需图形编辑请改用字面量</span>
        ) : (
          <NoteChipsEditor notes={parsed.notes} onChange={(notes) => write({ notes })} />
        )}
      </div>
      <div className="play-params">
        <label>
          速度（BPM）
          <input
            type="number"
            value={parsed.tempo ?? 90}
            min={20}
            max={300}
            onChange={(e) => {
              const v = Number(e.target.value)
              if (Number.isFinite(v)) write({ tempo: Math.min(300, Math.max(20, v)) })
            }}
          />
        </label>
        <label>
          播放方式
          <select value={parsed.mode ?? 'chord'} onChange={(e) => write({ mode: e.target.value as 'chord' | 'seq' })}>
            <option value="chord">chord · 同时发声</option>
            <option value="seq">seq · 按时值连奏</option>
          </select>
        </label>
        {props.kind === 'synth' && (
          <label>
            音色（wave）
            <select value={parsed.wave ?? ''} onChange={(e) => write({ wave: e.target.value || undefined })}>
              <option value="">（用组件当前音色）</option>
              {SYNTH_WAVES.map((w) => (
                <option key={w} value={w}>{w}</option>
              ))}
            </select>
          </label>
        )}
      </div>
      <button type="button" className="link" onClick={() => setAdvanced(true)}>
        高级（原始参数）
      </button>
    </div>
  )
}
