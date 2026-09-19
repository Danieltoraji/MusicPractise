/**
 * 组件定义的运行时形态：每个组件类型实现统一契约 ——
 * events（对外事件）/ commands（可被逻辑调用的命令）/ bindings（随题注入），
 * 命令处理是纯函数（状态进、状态+效果出），便于测试与未来服务端重放。
 */
import type { ComponentInstance, Note } from '../engine/level'
import type { Json } from '../engine/expr'

export type Effect =
  | { type: 'audio.play'; notes: Note[]; tempo?: number; mode?: 'chord' | 'seq' }
  | { type: 'timer.start'; ms: number; repeat: boolean }
  | { type: 'timer.stop' }
  | { type: 'none' }

export interface ContractDoc {
  type: string
  displayName: string
  category: 'music' | 'ui' | 'hidden'
  /** 事件名 → 负载说明 */
  events: Record<string, string>
  /** 命令名 → 参数说明（写操作，可被逻辑调用） */
  commands: Record<string, string>
  /** 查询方法名 → 返回值说明（读操作，assign 右侧调用，如 v.x = input1.getValue()） */
  queries?: Record<string, string>
  /** 绑定槽位 → 值类型说明 */
  bindings?: Record<string, string>
  /** 可读状态（编辑器展示用；表达式 v1 经事件即可覆盖） */
  state?: Record<string, string>
  /** props 说明（自由文本；propsSchema 正式化在编辑器阶段） */
  propsDoc?: string
}

export interface ComponentDef<S = unknown> {
  contract: ContractDoc
  initialState(spec: ComponentInstance): S
  applyBinding(state: S, key: string, value: Json): S
  applyCommand(state: S, command: string, args: Record<string, Json>): { state: S; effects?: Effect[] }
  /** 查询方法（contract.queries 中声明的方法在此实现）；未识别的方法名抛错 */
  query?(state: S, method: string, args: Json[]): Json
}

/**
 * 基座命令：所有实例继承、由 ComponentStore 统一实现（不进各组件 def）。
 * 状态位 __visible / __enabled 存在实例状态上（undefined = 可见/可用），视图层读取合并。
 */
export const BASE_COMMANDS = new Set(['setVisible', 'setEnabled'])

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
export interface TimerState {
  running: boolean
  count: number
  ms: number
}
export interface SliderState {
  value: number
  min: number
  max: number
}
export interface InputState {
  value: string
}
export interface FingeringState {
  highlights: Record<string, string>
  clearToken: number
}
export interface RhythmState {
  running: boolean
  beats: number
  bpm: number
  countIn: number
  /** 每次 start 递增：视图 effect 以此感知"重开一轮"（参数不变也要重排） */
  runId: number
}
export interface TunerState {
  running: boolean
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
    state: { text: 'string', tone: '"info"|"success"|"error"' },
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
    state: { text: 'string', enabled: 'boolean' },
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
    state: { options: 'string[]', revealed: 'number?' },
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
    state: { music: 'MusicDoc', highlights: 'Record<midi, "correct"|"wrong">' },
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
    // 内部命令：点击音符立即发出该音高（对比式试听），判定音效仍由关卡规则决定
    if (cmd === '__strike') {
      if (typeof args.midi !== 'number') return { state: s }
      return { state: s, effects: [{ type: 'audio.play', notes: [{ midi: args.midi, dur: '8n' }], mode: 'chord' }] }
    }
    return { state: s }
  },
}

export const SOUND_DEF: ComponentDef<SoundState> = {
  contract: {
    type: 'sound',
    displayName: '发声器',
    category: 'music',
    events: {},
    commands: { play: '{ notes: Note[], tempo?: number, mode?: "chord"|"seq" }', stop: '无参数' },
    state: { lastPlay: 'Json' },
  },
  initialState: () => ({ lastPlay: null }),
  applyBinding: (s) => s,
  applyCommand: (s, cmd, args) => {
    if (cmd === 'play') {
      const notes = Array.isArray(args.notes) ? (args.notes as unknown as Note[]) : []
      // tempo 钳到常规音乐区间，防止 60/0=Infinity 把后续音符排到无穷远
      const tempo = typeof args.tempo === 'number' ? Math.min(300, Math.max(20, args.tempo)) : undefined
      if (args.mode !== undefined && args.mode !== 'chord' && args.mode !== 'seq') {
        console.warn(`[sound] 未知播放模式 "${String(args.mode)}"，按 chord 处理`)
      }
      const mode = args.mode === 'seq' ? 'seq' : 'chord'
      return {
        state: { lastPlay: args.notes ?? null },
        effects: [{ type: 'audio.play', notes, tempo, mode }],
      }
    }
    return { state: s }
  },
}

export const TIMER_DEF: ComponentDef<TimerState> = {
  contract: {
    type: 'timer',
    displayName: '计时器',
    category: 'hidden',
    events: { tick: '{ count: number }' },
    // __tick 为运行器内部命令（约定：双下划线前缀 = 内部，不承诺给 UGC）
    commands: { start: '{ ms: number, repeat?: boolean }', stop: '无参数' },
    queries: { getCount: 'number（已触发的 tick 计数）' },
    state: { running: 'boolean', count: 'number', ms: 'number' },
  },
  initialState: () => ({ running: false, count: 0, ms: 0 }),
  applyBinding: (s) => s,
  applyCommand: (s, cmd, args) => {
    if (cmd === 'start') {
      // 下界 1ms 防零/负；上界 24h（setTimeout 规范对 >2^31-1 会立即触发）
      const ms = typeof args.ms === 'number' ? Math.min(24 * 60 * 60 * 1000, Math.max(1, args.ms)) : 1000
      const repeat = args.repeat === true
      return { state: { ...s, running: true, count: 0, ms }, effects: [{ type: 'timer.start', ms, repeat }] }
    }
    if (cmd === 'stop') return { state: { ...s, running: false }, effects: [{ type: 'timer.stop' }] }
    if (cmd === '__tick') return { state: { ...s, count: typeof args.count === 'number' ? args.count : s.count + 1 } }
    return { state: s }
  },
  query: (s, method) => {
    if (method === 'getCount') return s.count
    throw new Error(`timer 没有查询方法 "${method}"`)
  },
}

export const SLIDER_DEF: ComponentDef<SliderState> = {
  contract: {
    type: 'slider',
    displayName: '滑块',
    category: 'ui',
    events: { changed: '{ value: number }' },
    commands: { setValue: '{ value: number }' },
    queries: { getValue: 'number（当前值）' },
    state: { value: 'number' },
  },
  initialState: (spec) => {
    const p = (spec.props ?? {}) as Record<string, Json>
    const min = typeof p.min === 'number' ? p.min : 0
    const max = typeof p.max === 'number' ? p.max : 100
    const initial = typeof p.initial === 'number' ? p.initial : min
    return { value: Math.min(max, Math.max(min, initial)), min, max }
  },
  applyBinding: (s) => s,
  applyCommand: (s, cmd, args) => {
    if (cmd === 'setValue' || cmd === '__set') {
      if (typeof args.value !== 'number') return { state: s }
      // 逻辑 setValue 与视图输入统一钳制，保证状态与 DOM 显示一致
      return { state: { ...s, value: Math.min(s.max, Math.max(s.min, args.value)) } }
    }
    return { state: s }
  },
  query: (s, method) => {
    if (method === 'getValue') return s.value
    throw new Error(`slider 没有查询方法 "${method}"`)
  },
}

export const INPUT_DEF: ComponentDef<InputState> = {
  contract: {
    type: 'input',
    displayName: '输入框',
    category: 'ui',
    events: { submitted: '{ value: string }' },
    commands: { setValue: '{ value: string }', clear: '无参数' },
    queries: { getValue: 'string（当前输入值）' },
    state: { value: 'string' },
  },
  initialState: () => ({ value: '' }),
  applyBinding: (s) => s,
  applyCommand: (s, cmd, args) => {
    if (cmd === 'setValue') return { state: { ...s, value: str(args.value, s.value) } }
    if (cmd === 'clear') return { state: { ...s, value: '' } }
    return { state: s }
  },
  query: (s, method) => {
    if (method === 'getValue') return s.value
    throw new Error(`input 没有查询方法 "${method}"`)
  },
}

export const FINGERING_DEF: ComponentDef<FingeringState> = {
  contract: {
    type: 'fingering',
    displayName: '指法/键盘',
    category: 'music',
    events: { keyClicked: '{ midi: number, name: string }' },
    commands: { highlight: '{ target: number(midi), style: "correct"|"wrong" }', clear: '无参数' },
    propsDoc: 'props: { lowMidi: number, highMidi: number }（键盘音域，缺省 48..72）',
    state: { highlights: 'Record<midi, "correct"|"wrong">' },
  },
  initialState: () => ({ highlights: {}, clearToken: 0 }),
  applyBinding: (s) => s,
  applyCommand: (s, cmd, args) => {
    if (cmd === 'highlight') {
      if (typeof args.target !== 'number') return { state: s }
      const style = args.style === 'wrong' ? 'wrong' : 'correct'
      return { state: { ...s, highlights: { ...s.highlights, [String(args.target)]: style } } }
    }
    if (cmd === 'clear') return { state: { ...s, highlights: {}, clearToken: s.clearToken + 1 } }
    if (cmd === '__strike') {
      if (typeof args.midi !== 'number') return { state: s }
      return { state: s, effects: [{ type: 'audio.play', notes: [{ midi: args.midi, dur: '8n' }], mode: 'chord' }] }
    }
    return { state: s }
  },
}

export const RHYTHM_DEF: ComponentDef<RhythmState> = {
  contract: {
    type: 'rhythm',
    displayName: '节奏训练',
    category: 'music',
    events: {
      tap: '{ t: number }（相对起拍的秒数，预备拍期间为负）',
      roundDone: '{ duration: number }（一轮结束）',
    },
    commands: { start: '{ bpm: number, beats?: number, countInBeats?: number }', stop: '无参数' },
    state: { running: 'boolean', beats: 'number', bpm: 'number', countIn: 'number', runId: 'number' },
    propsDoc: 'props: { countInBeats?: number }（预备拍数量缺省值，start 参数可覆盖）',
  },
  initialState: (spec) => {
    const p = (spec.props ?? {}) as Record<string, Json>
    return { running: false, beats: 8, bpm: 80, countIn: typeof p.countInBeats === 'number' ? p.countInBeats : 4, runId: 0 }
  },
  applyBinding: (s) => s,
  applyCommand: (s, cmd, args) => {
    if (cmd === 'start') {
      const bpm = typeof args.bpm === 'number' ? Math.min(300, Math.max(20, args.bpm)) : 80
      const beats = typeof args.beats === 'number' ? Math.min(64, Math.max(1, Math.round(args.beats))) : 8
      const countIn = typeof args.countInBeats === 'number' ? Math.min(16, Math.max(0, Math.round(args.countInBeats))) : s.countIn
      // runId 每次 start +1：驱动视图 effect 重排，即便参数与上一轮完全相同
      return { state: { ...s, running: true, beats, bpm, countIn, runId: s.runId + 1 } }
    }
    if (cmd === 'stop') return { state: { ...s, running: false } }
    return { state: s }
  },
}

export const TUNER_DEF: ComponentDef<TunerState> = {
  contract: {
    type: 'tuner',
    displayName: '校音器',
    category: 'music',
    events: { pitch: '{ freq: number, midi: number, cents: number, clarity: number }（约 10Hz 节流）' },
    commands: { start: '无参数（请求麦克风）', stop: '无参数' },
    state: { running: 'boolean' },
  },
  initialState: () => ({ running: false }),
  applyBinding: (s) => s,
  applyCommand: (s, cmd) => {
    if (cmd === 'start') return { state: { ...s, running: true } }
    if (cmd === 'stop') return { state: { ...s, running: false } }
    return { state: s }
  },
}
