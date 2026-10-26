/**
 * v4 播放层 React 宿主胶水（docs/52 W3 / docs/53 §10–§11）：
 * - `useV4Snapshot`：把 V4Session 的 subscribe/getSnapshot 接到 useSyncExternalStore；
 * - `createV4SessionHost`：V4SessionHost 的真实实现——音频 effects 走 audioHost，
 *   onFinished/onRunEvent/预算/计时器/随机源可注入（测试与编辑器预览共用）；
 * - `preloadV4Audio`：v4 文档的采样预热（扫描 shell 组件与各题型 surface 组件）。
 *
 * 边界：本模块只做「会话 ↔ 宿主环境」接线，不持有 React 状态、不改内核；
 * 关卡内所有流程/题目语义在 `V4Session`（src/runtime/v4/session.ts）。
 */
import { useSyncExternalStore } from 'react'
import type { ComponentInstanceV4, LevelDocV4, RunResult } from '../../engine/v4/model'
import { preloadAudio } from '../audio'
import { nowSeconds, runAudioEffects } from '../audioHost'
import { isSoundInstrument, type Effect, type SoundInstrument } from '../componentDef'
import type { TimerApi, V4Budgets, V4RunEvent, V4Session, V4SessionHost, V4Snapshot } from './session'

/** 副作用来源（与 V4SessionHost.runEffects 的 origin 同构） */
export interface V4EffectOrigin {
  layer: 'shell' | 'surface'
  componentId: string
  callId?: number
}

export type V4EffectsRunner = (effects: Effect[], origin: V4EffectOrigin) => void

export interface V4SessionHostOptions {
  /** 结算回调（每轮一次；幂等由 session 保证：首个 finish 生效） */
  onFinished(result: RunResult): void
  /** 运行副作用（缺省播到真实音频通道 audioHost.runAudioEffects） */
  runEffects?: V4EffectsRunner
  /** 运行事件（error/warning/finish/restart…）：运行日志/调试面板用 */
  onRunEvent?(event: V4RunEvent): void
  getNowSeconds?(): number
  budgets?: Partial<V4Budgets>
  timer?: TimerApi
  random?: () => number
  debug?: V4SessionHost['debug']
}

const NOOP_SUBSCRIBE = (): (() => void) => () => {}
const NOOP_EFFECTS: V4EffectsRunner = () => {}
const NOOP_RESULT = (): null => null

/**
 * React 订阅入口：会话快照（shell/view/surface/progress/result/running）变化时重渲染。
 * 允许 `session` 为 null（session 在 effect 里创建，首帧占位）。
 */
export function useV4Snapshot(session: V4Session | null): V4Snapshot | null {
  const subscribe = session ? session.subscribe : NOOP_SUBSCRIBE
  // getSnapshot 每次渲染可闭包（返回值是 session 内部缓存快照，引用稳定）；session 为空时恒 null。
  return useSyncExternalStore(subscribe, session ? () => session.getSnapshot() : NOOP_RESULT)
}

/** 音频时钟优先（与 audioHost 同一 AudioContext）；无音频环境（jsdom/SSR）退回单调时钟 */
function safeNowSeconds(): number {
  try {
    return nowSeconds()
  } catch {
    return performance.now() / 1000
  }
}

/**
 * 构造 V4SessionHost：把「宿主环境能做的事」显式接线。
 * - 默认 effects → `audioHost.runAudioEffects`（与 v3 播放同一音频通道）；
 * - 默认 getNowSeconds → 音频时钟（now() 表达式与音频排程同基准）。
 * 注意：onFinished 由调用方保证稳定或自行用 ref 包裹（LevelRunnerV4 用 ref，避免重建 session）。
 */
export function createV4SessionHost(options: V4SessionHostOptions): V4SessionHost {
  const runEffects = options.runEffects ?? ((effects: Effect[]) => runAudioEffects(effects))
  const host: V4SessionHost = {
    onFinished: (result) => options.onFinished(result),
    runEffects: (effects, origin) => runEffects(effects, origin),
    getNowSeconds: options.getNowSeconds ?? safeNowSeconds,
  }
  if (options.onRunEvent) host.onRunEvent = options.onRunEvent
  if (options.budgets) host.budgets = options.budgets
  if (options.timer) host.timer = options.timer
  if (options.random) host.random = options.random
  if (options.debug) host.debug = options.debug
  return host
}

/** 扫描一组组件实例，收集需要预热的采样音色（v3 preloadLevelAudio 的 v4 局部实现） */
function collectInstruments(components: readonly ComponentInstanceV4[] | undefined, into: Set<SoundInstrument>): void {
  for (const component of components ?? []) {
    if (component.type === 'staff' || component.type === 'fingering') {
      // 五线谱点击试听 / 键盘点击试听固定走钢琴（与 v3 同口径）
      into.add('piano')
      continue
    }
    if (component.type !== 'sound') continue
    const props = (component.props ?? {}) as Record<string, unknown>
    into.add(isSoundInstrument(props.instrument) ? props.instrument : 'piano')
  }
}

/**
 * v4 关卡装载预热：shell 常驻组件 + 全部题型 surface 组件一次性扫描；
 * 进关即开始下载采样（不依赖用户手势），首个音符不再等待。
 */
export function preloadV4Audio(doc: LevelDocV4): void {
  const instruments = new Set<SoundInstrument>()
  collectInstruments(doc.content.shell.components, instruments)
  for (const type of doc.content.types) collectInstruments(type.surface?.components, instruments)
  if (instruments.size > 0) preloadAudio([...instruments])
}

/** 测试/无头环境常用：不播声音的 runEffects（保留导出避免各处重复字面量） */
export const SILENT_EFFECTS: V4EffectsRunner = NOOP_EFFECTS
