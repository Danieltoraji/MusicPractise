/**
 * v4 无头试跑（docs/52 W2.5）：不依赖 DOM，按剧本注入 shell/surface 事件，
 * 收集每题返回、结算、牌堆与运行日志；可固定 seed 复现。
 *
 * 用途：AI run_level 工具、样例 golden、数据变更属性测试、编辑器调试面板自检。
 */
import type { Json } from '../../engine/expr'
import {
  cloneLevelDocV4,
  type DeckItem,
  type LevelDocV4,
  type QuestionResult,
  type RunResult,
} from '../../engine/v4/model'
import { V4Session, type V4QuestionLogEntry, type V4RunEvent, type V4SessionHost } from './session'

export type HarnessWhen = 'immediate' | 'surface' | 'shellWait' | 'result' | 'finished'

export type HarnessAction =
  | { kind: 'surface'; component: string; event: string; payload?: Json }
  | { kind: 'shell'; component: string; event: string; payload?: Json }
  | { kind: 'wait'; ms: number }

export interface HarnessStep {
  /** 执行动作前等待的运行状态（默认 immediate） */
  when?: HarnessWhen
  action: HarnessAction
}

export interface HarnessOptions {
  /** 固定牌堆 seed（覆盖文档 run.seed；不传则沿用文档配置） */
  seed?: number | string | null
  script?: HarnessStep[]
  /** 结束等待上限（默认 3000ms） */
  timeoutMs?: number
}

export interface HarnessReport {
  ok: boolean
  error?: string
  /** 流程是否自然结束（running=false）；超时未结束 = false */
  finished: boolean
  result: RunResult | null
  score: number | null
  passed: boolean | null
  questions: V4QuestionLogEntry[]
  lastResult: QuestionResult | null
  deck: DeckItem[]
  seed: number
  logs: V4RunEvent[]
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function waitFor(predicate: () => boolean, label: string, timeoutMs: number): Promise<boolean> {
  const start = Date.now()
  while (Date.now() - start <= timeoutMs) {
    if (predicate()) return true
    await sleep(3)
  }
  void label
  return false
}

/** 无头跑一关 v4 文档；返回报告（不抛异常，错误放进 report.error） */
export async function runLevelHeadless(doc: LevelDocV4, options: HarnessOptions = {}): Promise<HarnessReport> {
  const timeoutMs = options.timeoutMs ?? 3000
  const working = cloneLevelDocV4(doc)
  if (options.seed !== undefined) working.content.run.seed = options.seed

  const logs: V4RunEvent[] = []
  const host: V4SessionHost = {
    onFinished() {
      // 结算结果从 session 快照读取（避免重复状态）
    },
    runEffects() {
      // 无头环境不播声音
    },
    onRunEvent(event) {
      logs.push(event)
    },
  }
  const session = new V4Session(working, host)
  const report: HarnessReport = {
    ok: false,
    finished: false,
    result: null,
    score: null,
    passed: null,
    questions: [],
    lastResult: null,
    deck: [],
    seed: 0,
    logs,
  }
  try {
    session.start()
    for (const step of options.script ?? []) {
      const when = step.when ?? 'immediate'
      if (when !== 'immediate') {
        const ready = await waitFor(
          () => {
            const snapshot = session.getSnapshot()
            if (when === 'surface') return snapshot.surface !== null
            if (when === 'shellWait') return session.waitingShellEvents.length > 0
            if (when === 'result') return snapshot.result !== null
            return !session.isRunning
          },
          `harness 等待 ${when}`,
          timeoutMs,
        )
        if (!ready) throw new Error(`剧本等待超时（${when}）`)
      }
      const action = step.action
      if (action.kind === 'surface') {
        session.dispatchSurfaceEvent(action.component, action.event, action.payload ?? {})
      } else if (action.kind === 'shell') {
        session.dispatchShellEvent(action.component, action.event, action.payload ?? {})
      } else {
        await sleep(action.ms)
      }
    }
    const finished = await waitFor(() => !session.isRunning, 'harness 等待流程结束', timeoutMs)
    report.finished = finished
    if (!finished) report.error = `流程在 ${timeoutMs}ms 内未结束`
    report.deck = session.deck
    report.seed = session.seed
    report.questions = [...session.questionResults]
    report.lastResult = report.questions.length > 0 ? report.questions[report.questions.length - 1].result : null
    report.result = session.getSnapshot().result
    report.score = report.result ? report.result.score : null
    report.passed = report.result ? report.result.passed : null
    report.ok = finished && report.error === undefined
  } catch (err) {
    report.error = err instanceof Error ? err.message : String(err)
    report.deck = session.deck
    report.seed = session.seed
    report.questions = [...session.questionResults]
    report.result = session.getSnapshot().result
    report.score = report.result ? report.result.score : null
    report.passed = report.result ? report.result.passed : null
  } finally {
    session.dispose()
  }
  return report
}
