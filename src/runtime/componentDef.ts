/**
 * 组件定义的运行时形态：每个组件类型实现统一契约 ——
 * events（对外事件）/ commands（可被逻辑调用的命令）/ bindings（随题注入），
 * 命令处理是纯函数（状态进、状态+效果出），便于测试与未来服务端重放。
 */
import type { ComponentInstance, Note } from '../engine/level'
import type { Json } from '../engine/expr'

export type Effect = { type: 'audio.play'; notes: Note[] } | { type: 'none' }

export interface ContractDoc {
  type: string
  displayName: string
  category: 'music' | 'ui' | 'hidden'
  /** 事件名 → 负载说明 */
  events: Record<string, string>
  /** 命令名 → 参数说明 */
  commands: Record<string, string>
  /** 绑定槽位 → 值类型说明 */
  bindings?: Record<string, string>
}

export interface ComponentDef<S = unknown> {
  contract: ContractDoc
  initialState(spec: ComponentInstance): S
  applyBinding(state: S, key: string, value: Json): S
  applyCommand(state: S, command: string, args: Record<string, Json>): { state: S; effects?: Effect[] }
}

type Tone = 'info' | 'success' | 'error'

export interface LabelState {
  text: string
  tone: Tone
}
export interface ButtonState {
  text: string
  enabled: boolean
}
export interface ChoiceState {
  options: string[]
  revealed: number | null
}
export interface StaffState {
  music: Json | null
  highlights: Record<string, string>
  clearToken: number
}
export interface SoundState {
  lastPlay: Json | null
}

const str = (v: Json | undefined, dflt: string): string => (typeof v === 'string' ? v : dflt)
const bool = (v: Json | undefined, dflt: boolean): boolean => (typeof v === 'boolean' ? v : dflt)

export const LABEL_DEF: ComponentDef<LabelState> = {
  contract: {
    type: 'label',
    displayName: '文本',
    category: 'ui',
    events: {},
    commands: { show: '{ text: string, tone?: "info"|"success"|"error" }' },
  },
  initialState: (spec) => ({ text: str(spec.props && (spec.props as Record<string, Json>).text, ''), tone: 'info' }),
  applyBinding: (s) => s,
  applyCommand: (s, cmd, args) => {
    if (cmd !== 'show') return { state: s }
    return {
      state: {
        text: str(args.text, s.text),
        tone: (args.tone === 'success' || args.tone === 'error' ? args.tone : 'info') as Tone,
      },
    }
  },
}

export const BUTTON_DEF: ComponentDef<ButtonState> = {
  contract: {
    type: 'button',
    displayName: '按钮',
    category: 'ui',
    events: { clicked: '无负载' },
    commands: { setEnabled: '{ enabled: boolean }', setText: '{ text: string }' },
  },
  initialState: (spec) => {
    const p = (spec.props ?? {}) as Record<string, Json>
    return { text: str(p.text, '按钮'), enabled: bool(p.enabled, true) }
  },
  applyBinding: (s) => s,
  applyCommand: (s, cmd, args) => {
    if (cmd === 'setEnabled') return { state: { ...s, enabled: bool(args.enabled, s.enabled) } }
    if (cmd === 'setText') return { state: { ...s, text: str(args.text, s.text) } }
    return { state: s }
  },
}

export const CHOICE_DEF: ComponentDef<ChoiceState> = {
  contract: {
    type: 'choice',
    displayName: '选择器',
    category: 'ui',
    events: { chosen: '{ index: number, value: string }' },
    commands: { reveal: '{ correctIndex: number }', reset: '无参数' },
    bindings: { options: 'string[]' },
  },
  initialState: () => ({ options: [], revealed: null }),
  applyBinding: (s, key, value) => {
    if (key === 'options' && Array.isArray(value)) {
      return { options: value.map((o) => (typeof o === 'string' ? o : JSON.stringify(o))), revealed: null }
    }
    return s
  },
  applyCommand: (s, cmd, args) => {
    if (cmd === 'reveal') {
      const idx = typeof args.correctIndex === 'number' ? args.correctIndex : null
      return { state: { ...s, revealed: idx } }
    }
    if (cmd === 'reset') return { state: { ...s, revealed: null } }
    return { state: s }
  },
}

export const STAFF_DEF: ComponentDef<StaffState> = {
  contract: {
    type: 'staff',
    displayName: '五线谱',
    category: 'music',
    events: { noteClicked: '{ midi: number, name: string }' },
    commands: { highlight: '{ target: number(midi), style: "correct"|"wrong" }', clear: '无参数' },
    bindings: { music: 'MusicDoc' },
  },
  initialState: () => ({ music: null, highlights: {}, clearToken: 0 }),
  applyBinding: (s, key, value) => {
    if (key === 'music') return { ...s, music: value }
    return s
  },
  applyCommand: (s, cmd, args) => {
    if (cmd === 'highlight') {
      if (typeof args.target !== 'number') return { state: s }
      const style = args.style === 'wrong' ? 'wrong' : 'correct'
      return { state: { ...s, highlights: { ...s.highlights, [String(args.target)]: style } } }
    }
    if (cmd === 'clear') return { state: { ...s, highlights: {}, clearToken: s.clearToken + 1 } }
    return { state: s }
  },
}

export const SOUND_DEF: ComponentDef<SoundState> = {
  contract: {
    type: 'sound',
    displayName: '发声器',
    category: 'music',
    events: { playDone: '无负载' },
    commands: { play: '{ notes: Note[] }', stop: '无参数' },
  },
  initialState: () => ({ lastPlay: null }),
  applyBinding: (s) => s,
  applyCommand: (s, cmd, args) => {
    if (cmd === 'play') {
      const notes = Array.isArray(args.notes) ? (args.notes as unknown as Note[]) : []
      return { state: { lastPlay: args.notes ?? null }, effects: [{ type: 'audio.play', notes }] }
    }
    return { state: s }
  },
}
