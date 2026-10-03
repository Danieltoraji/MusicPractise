/** 调试运行管理器（docs/30）集成测试：对真实教程关跑断点/单步/变量赋值/事件触发/实时日志 */
import { afterEach, describe, expect, it } from 'vitest'
import type { LevelDoc } from '../../engine/level'
import { loadLevelDoc } from '../../library/validate'
import {
  dispatchDebugEvent,
  getDebugSnapshot,
  restartDebug,
  resumeDebug,
  setDebugVar,
  startDebugRun,
  stepDebug,
  stopDebugRun,
  toggleDebugBreakpoint,
} from './debugRun'

import tutorialDoc from '../../sample/tutorial-hello.level.json'

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** 轮询等待快照满足条件（真实门控/定时器异步推进） */
async function waitFor(pred: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now()
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor 超时')
    await sleep(10)
  }
}

function loaded(): LevelDoc {
  const r = loadLevelDoc(tutorialDoc)
  expect(r.ok).toBe(true)
  return (r as { ok: true; doc: LevelDoc }).doc
}

/** 找 start_btn.clicked 处理器的首个后继节点（设断点用） */
function firstSuccessor(doc: LevelDoc, onEvent: string): string {
  const logic = doc.content.logic
  const on = logic.nodes.find((n) => n.kind === 'on' && n.event === onEvent)
  const edge = logic.edges.find((e) => e.from === on?.id)
  expect(edge).toBeTruthy()
  return edge!.to
}

describe('debugRun（编辑器调试会话）', () => {
  it('启动→断点命中→变量观察与赋值→继续→手动触发→停止', async () => {
    const doc = loaded()
    const bpNode = firstSuccessor(doc, 'start_btn.clicked')
    toggleDebugBreakpoint(bpNode)

    const err = await startDebugRun(doc)
    expect(err).toBeNull()
    let snap = getDebugSnapshot()
    expect(snap.mode).toBe('running')
    expect(snap.view).toBe('welcome')
    // 启动流程无错误
    expect(snap.events.some((e) => e.kind === 'error')).toBe(false)

    // 触发按钮点击 → 处理器在断点节点挂起
    expect(await dispatchDebugEvent('start_btn.clicked')).toBeNull()
    await waitFor(() => getDebugSnapshot().pausedAt === bpNode)
    snap = getDebugSnapshot()
    expect(snap.mode).toBe('paused')
    expect(snap.pausedEvent).toBe('start_btn.clicked')

    // 变量赋值窗口
    expect(setDebugVar('__row', 5)).toContain('系统变量')
    expect(setDebugVar('score', 7)).toBeNull()
    expect(getDebugSnapshot().vars.score).toBe(7)

    // 继续 → 处理器走完（视图推进由按钮逻辑决定）
    resumeDebug()
    await waitFor(() => getDebugSnapshot().mode === 'running')
    // 日志实时记录了命令轨迹
    await waitFor(() => getDebugSnapshot().events.some((e) => e.kind === 'command'))

    stopDebugRun()
    expect(getDebugSnapshot().mode).toBe('idle')
    toggleDebugBreakpoint(bpNode) // 清理断点（控制器跨用例共享）
    expect(getDebugSnapshot().breakpoints).not.toContain(bpNode)
  }, 15000)

  it('单步：逐步执行节点', async () => {
    const doc = loaded()
    // 断点设在 start_btn 处理器的首个后继（views.goto）
    const bpNode = firstSuccessor(doc, 'start_btn.clicked')
    toggleDebugBreakpoint(bpNode)
    await startDebugRun(doc)
    await waitFor(() => getDebugSnapshot().mode === 'running')
    expect(await dispatchDebugEvent('start_btn.clicked')).toBeNull()
    await waitFor(() => getDebugSnapshot().pausedAt === bpNode)

    // 单步：goto 后处理器结束，view.entered 处理器接力（pendingStep 跨处理器）→ 暂停在其节点上
    stepDebug()
    await waitFor(() => {
      const s = getDebugSnapshot()
      return s.pausedAt !== null && s.pausedAt !== bpNode
    })
    // 暂停的节点必须存在于文档（goto_step1 本身是该处理器末节点，无后继）
    const pausedAt = getDebugSnapshot().pausedAt!
    expect(doc.content.logic.nodes.some((n) => n.id === pausedAt)).toBe(true)
    toggleDebugBreakpoint(bpNode)
    resumeDebug()
    await waitFor(() => getDebugSnapshot().mode === 'running')
    stopDebugRun()
  }, 15000)

  it('停止后状态复位；断点跨会话保留', async () => {
    const doc = loaded()
    toggleDebugBreakpoint('some_node')
    await startDebugRun(doc)
    stopDebugRun()
    const snap = getDebugSnapshot()
    expect(snap.mode).toBe('idle')
    expect(snap.breakpoints).toContain('some_node')
    toggleDebugBreakpoint('some_node') // 清理
  })
})

describe('debugRun 可视化地基（批次9）', () => {
  afterEach(() => {
    stopDebugRun()
  })

  it('启动后快照暴露画面渲染源（doc/store/emitFor/sessionNo）；停止清空', async () => {
    const doc = loaded()
    await startDebugRun(doc)
    const snap = getDebugSnapshot()
    expect(snap.stage).not.toBeNull()
    expect(snap.stage!.doc.content.components.length).toBeGreaterThan(0)
    expect(snap.stage!.sessionNo).toBeGreaterThan(0)
    // rowData：启动装载第 0 行
    expect(snap.row).toBe(0)
    expect(snap.rowData).not.toBeNull()
    // emitFor 返回可派发函数（语义形状）
    expect(typeof snap.stage!.emitFor('x')).toBe('function')

    const no1 = snap.stage!.sessionNo
    stopDebugRun()
    expect(getDebugSnapshot().stage).toBeNull()

    // 再次启动 sessionNo 递增（React 据此重挂画面）
    await startDebugRun(doc)
    expect(getDebugSnapshot().stage!.sessionNo).toBe(no1 + 1)
  })

  it('restartDebug：变量复位重跑，断点保留', async () => {
    const doc = loaded()
    await startDebugRun(doc)
    expect(setDebugVar('score', 42)).toBeNull()
    expect(getDebugSnapshot().vars.score).toBe(42)
    // 断点保留（restart 不清控制器）
    toggleDebugBreakpoint('restart_bp')

    expect(restartDebug()).toBeNull()
    await waitFor(() => (getDebugSnapshot().vars.score ?? 0) !== 42)
    expect(getDebugSnapshot().mode).toBe('running')
    expect(getDebugSnapshot().breakpoints).toContain('restart_bp')
    toggleDebugBreakpoint('restart_bp')

    // 未运行时报错文案
    stopDebugRun()
    expect(restartDebug()).toContain('未运行')
  })

  it('断点挂起时计时器冻结，恢复后继续', async () => {
    // 用含 timer 的关卡：合成一个最小 timer 图（timer.start 300ms repeat + tick 改 score）
    const doc = loaded()
    doc.content.components.push({ id: 'timer1', type: 'timer', view: 'welcome' } as never)
    doc.content.logic.nodes.push(
      { id: 'b9_on_start', kind: 'on', event: 'level.started' },
      { id: 'b9_t_start', kind: 'call', target: 'timer1', method: 'start', args: ['{ms: 120, repeat: true}'] },
      { id: 'b9_on_tick', kind: 'on', event: 'timer1.tick' },
      { id: 'b9_t_add', kind: 'assign', target: 'score', value: { expr: 'v.score + 1' } },
    )
    doc.content.logic.edges.push(
      { id: 'b9_e1', from: 'b9_on_start', to: 'b9_t_start' },
      { id: 'b9_e2', from: 'b9_on_tick', to: 'b9_t_add' },
    )
    // 断点挂在 tick 处理器首节点上：第一次 tick 即挂起
    toggleDebugBreakpoint('b9_t_add')
    const err = await startDebugRun(doc)
    expect(err).toBeNull()
    await waitFor(() => getDebugSnapshot().mode === 'paused' && getDebugSnapshot().pausedAt === 'b9_t_add', 5000)
    const pausedVars = { ...getDebugSnapshot().vars }

    // 挂起期间等待一段时间：score 不应继续增长（计时器已冻结）
    await sleep(350)
    expect(getDebugSnapshot().vars.score).toBe(pausedVars.score)

    // 清除断点再恢复 → 计时器解冻，后续 tick 继续驱动 score 增长
    // （断点若保留，下一个 tick 会在 assign 前再次挂起，且暂停期间快照 vars 不刷新）
    toggleDebugBreakpoint('b9_t_add')
    resumeDebug()
    await waitFor(() => (getDebugSnapshot().vars.score ?? 0) > (pausedVars.score ?? 0), 5000)
  }, 15000)
})
