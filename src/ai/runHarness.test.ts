/** 无头试运行驱动（批次3）测试：对真实内置样例跑 LevelSession + 事件注入 */
import { describe, expect, it } from 'vitest'
import type { LevelDoc } from '../engine/level'
import { loadLevelDoc } from '../library/validate'
import { formatRunReport, runLevelHeadless, type RunReport } from './runHarness'

import tutorialDoc from '../sample/tutorial-hello.level.json'

function loaded(doc: unknown): LevelDoc {
  const r = loadLevelDoc(doc)
  expect(r.ok).toBe(true)
  return (r as { ok: true; doc: LevelDoc }).doc
}

describe('runLevelHeadless（无头试运行）', () => {
  it('教程关：注入按钮/滑块/选答事件 → 走完全流程并结算', async () => {
    const doc = loaded(tutorialDoc)
    const report = await runLevelHeadless(doc, {
      events: [
        { event: 'start_btn.clicked' },
        { event: 'try_btn.clicked' },
        { event: 's1_next.clicked' },
        { event: 'slider1.changed', payload: { value: 30 } },
        { event: 'slider1.changed', payload: { value: 42 } },
        { event: 's2_next.clicked' },
        { event: 'play_btn.clicked' },
        { event: 'choice1.chosen', payload: { index: 2, value: 'Mi' }, waitMs: 200 },
        { event: 's3_next.clicked', waitMs: 200 },
      ],
      timeoutMs: 8000,
    })
    expect(report.ran).toBe(true)
    expect(report.timedOut).toBe(false)
    expect(report.viewsVisited).toEqual(expect.arrayContaining(['welcome', 'done']))
    expect(report.finished).not.toBeNull()
    expect(report.finished).toMatchObject({ score: 10, passed: true })
    expect(report.finalVars.score).toBe(10)
    expect(report.errors).toEqual([])
  }, 20000)

  it('坏逻辑：注入触发事件 → 事件环被预算拦截为错误', async () => {
    const doc = loaded(tutorialDoc)
    // 造一个 emit 事件环（互相唤醒）→ 引擎预算拦截为错误
    doc.content.logic.nodes.push(
      { id: 'e_a', kind: 'emit', event: 'x:a' } as never,
      { id: 'e_b', kind: 'emit', event: 'x:b' } as never,
      { id: 'on_a', kind: 'on', event: 'x:a' } as never,
      { id: 'on_b', kind: 'on', event: 'x:b' } as never,
    )
    doc.content.logic.edges.push(
      { id: 'ea1', from: 'on_a', to: 'e_b' },
      { id: 'eb1', from: 'on_b', to: 'e_a' },
    )
    const report = await runLevelHeadless(doc, { events: [{ event: 'x:a', waitMs: 200 }], timeoutMs: 8000 })
    expect(report.ran).toBe(true)
    expect(report.errors.length).toBeGreaterThan(0)
    const text = formatRunReport(report)
    expect(text).toContain('运行错误')
    expect(text).toContain('预算')
  })

  it('装载被拒：不运行、返回 loadErrors', async () => {
    const doc = loaded(tutorialDoc)
    doc.schemaVersion = 99 as unknown as LevelDoc['schemaVersion']
    const report = await runLevelHeadless(doc)
    expect(report.ran).toBe(false)
    expect(report.loadErrors!.length).toBeGreaterThan(0)
    expect(formatRunReport(report)).toContain('未通过装载校验')
  })

  it('超时中止后驱动循环不再注入事件、返回后报告冻结（F12）', async () => {
    const doc = loaded(tutorialDoc)
    // 每步都等待 120ms，总超时 80ms：首步等待期间必超时
    const events = Array.from({ length: 20 }, () => ({ event: 'ghost.nope', waitMs: 120 }))
    const report = await runLevelHeadless(doc, { events, timeoutMs: 80 })
    expect(report.timedOut).toBe(true)
    expect(report.ran).toBe(false)
    const frozen = {
      steps: report.steps,
      views: report.viewsVisited.length,
      errors: report.errors.length,
      commands: report.commands.length,
      duration: report.durationMs,
    }
    // 返回后再等超过数步间隔：修复前 run() 仍在后台继续 dispatch/等待并改写同一 report 对象
    await new Promise((r) => setTimeout(r, 500))
    expect(report.steps).toBe(frozen.steps)
    expect(report.viewsVisited).toHaveLength(frozen.views)
    expect(report.errors).toHaveLength(frozen.errors)
    expect(report.commands).toHaveLength(frozen.commands)
    expect(report.durationMs).toBe(frozen.duration)
    expect(report.timedOut).toBe(true)
  }, 10000)

  it('formatRunReport：超时阈值用实际 timeoutMs（不再写死 >5000ms）', () => {
    const report: RunReport = {
      ran: false,
      errors: [],
      commands: [],
      rowsVisited: [],
      viewsVisited: [],
      finished: null,
      finalVars: {},
      steps: 1,
      durationMs: 5,
      timedOut: true,
    }
    expect(formatRunReport(report, { timeoutMs: 3200 })).toContain('>3200ms')
    expect(formatRunReport(report)).toContain('>5000ms') // 未传时回落默认值
  })

  it('formatRunReport：无命中的注入事件单独成段（探测信号）', () => {
    const report: RunReport = {
      ran: true,
      errors: [],
      commands: [],
      rowsVisited: [],
      viewsVisited: [],
      finished: null,
      finalVars: {},
      steps: 3,
      durationMs: 5,
      timedOut: false,
    }
    const text = formatRunReport(report, { unmatchedEvents: ['ghost.nope', 'nope2.x'] })
    expect(text).toContain('没有任何处理器命中')
    expect(text).toContain('- ghost.nope')
    expect(text).toContain('- nope2.x')
    // 无未命中时不出现该段
    expect(formatRunReport(report)).not.toContain('没有任何处理器命中')
  })
})
