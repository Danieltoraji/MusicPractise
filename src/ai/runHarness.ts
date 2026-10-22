/**
 * 无头试运行驱动（批次3）：不依赖 DOM/React，直接 LevelSession 跑当前关卡。
 * 剧本化注入组件事件（与 UI 点击同路径）→ 收集 LogicRunEvent/变量终态/结算结果 →
 * 产出可读报告回喂 AI。流程：loadLevelDoc 预检 → start → 逐步 dispatch（步间真实等待，
 * 供 wait 节点/timer 走完）→ dispose。外层超时兜底卡死。
 */

import type { LevelDoc } from '../engine/level'
import type { Json } from '../engine/expr'
import type { LogicRunEvent, SessionHost } from '../runtime/levelSession'
import { LevelSession } from '../runtime/levelSession'
import type { Effect } from '../runtime/componentDef'
import { loadLevelDoc } from '../library/validate'

export interface RunEventStep {
  /** 组件事件全名，如 keys1.keyClicked / button1.clicked */
  event: string
  /** 事件负载（如 { midi: 60 }） */
  payload?: Json
  /** 本步执行后等待的毫秒数（让 wait 节点/timer/级联事件走完；默认 120） */
  waitMs?: number
}

export interface RunReport {
  /** 装载/运行是否成功走完（逻辑错误不算失败——它们是报告的一部分） */
  ran: boolean
  /** 装载被拒绝时的错误（此时未运行） */
  loadErrors?: string[]
  errors: { message: string; nodeId?: string; event?: string }[]
  commands: string[]
  rowsVisited: number[]
  viewsVisited: string[]
  finished: { score: Json; passed: boolean } | null
  finalVars: Record<string, Json>
  steps: number
  durationMs: number
  timedOut: boolean
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** GraphEngine dispatch 是 fire-and-forget async：排空微任务（同 tutorial.test 的 flush） */
const flush = async (): Promise<void> => {
  for (let i = 0; i < 50; i++) await Promise.resolve()
}

export async function runLevelHeadless(
  doc: LevelDoc,
  opts: { events?: RunEventStep[]; timeoutMs?: number } = {},
): Promise<RunReport> {
  const report: RunReport = {
    ran: false,
    errors: [],
    commands: [],
    rowsVisited: [],
    viewsVisited: [],
    finished: null,
    finalVars: {},
    steps: 0,
    durationMs: 0,
    timedOut: false,
  }
  const started = Date.now()
  const check = loadLevelDoc(structuredClone(doc))
  if (!check.ok) {
    report.loadErrors = check.errors
    return report
  }
  const runDoc = check.doc
  // F12（docs/40）：超时「中止」此前只放弃等待——session 继续在后台跑且不 dispose。
  // 外层持引用，超时侧主动 dispose 终止计时器/音频
  let activeSession: LevelSession | null = null

  const run = async (): Promise<void> => {
    const events: LogicRunEvent[] = []
    const effects: Effect[] = []
    const host: SessionHost = {
      onRow: (index) => report.rowsVisited.push(index),
      onView: (id) => report.viewsVisited.push(id),
      onFinished: (r) => {
        report.finished = r
      },
      runEffects: (efs) => effects.push(...efs),
      onLogicEvent: (e) => events.push(e),
    }
    const session = new LevelSession(runDoc, host)
    activeSession = session
    try {
      session.start()
      await flush()
      for (const step of opts.events ?? []) {
        report.steps += 1
        session.dispatch(step.event, step.payload ?? {})
        await flush()
        await sleep(Math.min(step.waitMs ?? 120, 2000))
        await flush()
      }
      await flush()
      // 终态必须在 dispose 前采集——engine.reset 会把变量复位
      report.finalVars = { ...session.engine.vars } as Record<string, Json>
    } finally {
      if (activeSession === session) activeSession = null
      session.dispose()
    }
    for (const e of events) {
      if (e.kind === 'error') report.errors.push({ message: e.message, nodeId: e.nodeId, event: e.event })
      else report.commands.push(e.path)
    }
  }

  const timeoutMs = opts.timeoutMs ?? 5000
  try {
    await Promise.race([
      run(),
      sleep(timeoutMs).then(() => {
        report.timedOut = true
        activeSession?.dispose()
      }),
    ])
    report.ran = !report.timedOut
  } finally {
    report.durationMs = Date.now() - started
  }
  return report
}

/** 报告 → 可读中文文本（回喂模型/面板展示）。unmatchedEvents=注入了但关卡没有任何 on 处理器的事件（调用方静态对照） */
export function formatRunReport(
  r: RunReport,
  opts: { events?: RunEventStep[]; timeoutMs?: number; unmatchedEvents?: string[] } = {},
): string {
  if (r.loadErrors) {
    return `试运行未能开始——关卡未通过装载校验：\n${r.loadErrors.map((e) => `- ${e}`).join('\n')}`
  }
  const lines: string[] = []
  lines.push(
    r.timedOut
      ? `⚠ 试运行超时被中止（>${opts.timeoutMs ?? 5000}ms）——检查 wait/循环/事件环。`
      : `试运行完成（${r.durationMs}ms，注入 ${r.steps} 个事件）。`,
  )
  lines.push(`视图轨迹：${r.viewsVisited.join(' → ') || '无'}`)
  lines.push(`题目行轨迹：${r.rowsVisited.join(' → ') || '无'}（共 ${r.rowsVisited.length} 行）`)
  if (r.finished) {
    lines.push(`结算：score=${JSON.stringify(r.finished.score)}，passed=${r.finished.passed}`)
  } else {
    lines.push('结算：未触发（没有走到 level.finish / 末题推进）')
  }
  if (r.errors.length === 0) {
    lines.push('运行错误：无')
  } else {
    lines.push(`运行错误 ${r.errors.length} 条：`)
    for (const e of r.errors.slice(0, 12)) {
      lines.push(`- ${e.nodeId ? `(节点 ${e.nodeId})` : ''}${e.event ? `[${e.event}]` : ''} ${e.message}`)
    }
    if (r.errors.length > 12) lines.push(`…（其余 ${r.errors.length - 12} 条略）`)
  }
  if (opts.unmatchedEvents && opts.unmatchedEvents.length > 0) {
    lines.push('⚠ 以下注入事件没有任何处理器命中（组件不存在或事件名未注册——用 read_doc 核对组件 id 与事件/命令清单；不含题目 logicPatch 动态处理器）：')
    for (const ev of opts.unmatchedEvents) lines.push(`- ${ev}`)
  }
  lines.push(`命令轨迹：${r.commands.length} 条${r.commands.length > 0 ? `（最近：${r.commands.slice(-6).join('、')}）` : ''}`)
  const varKeys = Object.keys(r.finalVars)
  if (varKeys.length > 0) {
    lines.push(
      `变量终态：${varKeys.map((k) => `${k}=${JSON.stringify(r.finalVars[k])}`).join(', ')}`,
    )
  }
  return lines.join('\n')
}
