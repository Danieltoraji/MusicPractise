import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { LevelDoc } from '../engine/level'
import { loadLevelDoc } from '../library/validate'
import { clearDebugBreakpoints, getDebugSnapshot, stopDebugRun } from '../editor/graph/debugRun'
import { DEBUG_TOOLS } from './tools-debug'
import type { ToolContext } from './tools'

import tutorialDoc from '../sample/tutorial-hello.level.json'

function loaded(): LevelDoc {
  const r = loadLevelDoc(tutorialDoc)
  expect(r.ok).toBe(true)
  return (r as { ok: true; doc: LevelDoc }).doc
}

function tool(name: string) {
  const t = DEBUG_TOOLS.find((x) => x.name === name)
  if (!t) throw new Error(`没有工具 ${name}`)
  return t
}

function harness(doc: LevelDoc, hooks: { images?: (imgs: string[]) => void; shot?: () => Promise<string | null> } = {}) {
  return {
    getDoc: () => doc,
    applyDoc: () => {},
    levelId: doc.id,
    emitImages: hooks.images ?? (() => {}),
    captureScreenshot: hooks.shot,
  } as ToolContext
}

beforeEach(() => {
  stopDebugRun()
  clearDebugBreakpoints()
})

describe('AI 调试工具组（批次5）', () => {
  it('debug_control start → debug_read state/log → stop', async () => {
    const doc = loaded()
    expect(((await tool('debug_read').exec({ part: 'state' }, harness(doc))) as string)).toContain('未运行')

    const started = (await tool('debug_control').exec({ action: 'start' }, harness(doc))) as string
    expect(started).toContain('✓')
    const state = (await tool('debug_read').exec({ part: 'state' }, harness(doc))) as string
    expect(state).toContain('模式=running')
    expect(state).toContain('视图=welcome')

    await tool('debug_dispatch').exec({ event: 'start_btn.clicked' }, harness(doc))
    const log = (await tool('debug_read').exec({ part: 'log', tail: 50 }, harness(doc))) as string
    expect(log).toContain('views.goto')

    stopDebugRun()
  })

  it('debug_dispatch 触发事件 → 断点命中 → debug_set_var → resume', async () => {
    const doc = loaded()
    await tool('debug_control').exec({ action: 'start' }, harness(doc))
    // 断点设在 start_btn 处理器后继（goto_step1）
    const on = doc.content.logic.nodes.find((n) => n.kind === 'on' && n.event === 'start_btn.clicked')
    const edge = doc.content.logic.edges.find((e) => e.from === on?.id)
    await tool('debug_breakpoints').exec({ nodeIds: [edge!.to] }, harness(doc))
    expect(getDebugSnapshot().breakpoints).toEqual([edge!.to])

    await tool('debug_dispatch').exec({ event: 'start_btn.clicked', waitMs: 200 }, harness(doc))
    expect(getDebugSnapshot().mode).toBe('paused')

    expect((await tool('debug_set_var').exec({ name: 'score', value: 99 }, harness(doc))) as string).toContain('✓')
    expect(getDebugSnapshot().vars.score).toBe(99)

    await tool('debug_control').exec({ action: 'resume' }, harness(doc))
    await vi.waitFor(() => expect(getDebugSnapshot().mode).toBe('running'), { timeout: 3000 })
    stopDebugRun()
  })

  it('debug_screenshot：截取结果经 emitImages 交给对话', async () => {
    const images: string[] = []
    const ctx = harness(loaded(), {
      images: (imgs) => images.push(...imgs),
      shot: async () => 'data:image/png;base64,QUFB',
    })
    const result = (await tool('debug_screenshot').exec({}, ctx)) as string
    expect(result).toContain('✓')
    expect(images).toEqual(['data:image/png;base64,QUFB'])
  })

  it('debug_screenshot：环境不支持时如实回报', async () => {
    const result = (await tool('debug_screenshot').exec({}, harness(loaded()))) as string
    expect(result).toContain('不支持截图')
  })
})

describe('AI 调试工具批量参数（工具粒度治理）', () => {
  it('debug_dispatch.events：一次顺序触发多步剧本；空事件与未知事件报错', async () => {
    const doc = loaded()
    await tool('debug_control').exec({ action: 'start' }, harness(doc))
    const res = (await tool('debug_dispatch').exec(
      { events: [{ event: 'start_btn.clicked', waitMs: 200 }, { event: 'try_btn.clicked', waitMs: 200 }] },
      harness(doc),
    )) as string
    expect(res).toContain('已按剧本触发 2 个事件')
    expect(res).toContain('start_btn.clicked → try_btn.clicked')
    expect(getDebugSnapshot().view).toBe('step1')

    const empty = (await tool('debug_dispatch').exec({ events: [] }, harness(doc))) as string
    expect(empty).toContain('不能为空')
    // 会话停止后剧本触发走到 dispatchDebugEvent 的失败分支（剧本第 1 个事件即失败）
    stopDebugRun()
    const idle = (await tool('debug_dispatch').exec({ events: [{ event: 'start_btn.clicked' }] }, harness(doc))) as string
    expect(idle).toContain('触发失败')
    expect(idle).toContain('未运行')
  })

  it('debug_set_var.vars：一次设置多个运行时变量', async () => {
    const doc = loaded()
    await tool('debug_control').exec({ action: 'start' }, harness(doc))
    const res = (await tool('debug_set_var').exec({ vars: { score: 88, answered: 2 } }, harness(doc))) as string
    expect(res).toContain('✓')
    expect(res).toContain('2 个变量')
    expect(getDebugSnapshot().vars.score).toBe(88)
    expect(getDebugSnapshot().vars.answered).toBe(2)

    // 系统变量仍被拒（批量中报错并说明已设置保留）
    const bad = (await tool('debug_set_var').exec({ vars: { score: 1, __row: 0 } }, harness(doc))) as string
    expect(bad).toContain('赋值失败')
    expect(bad).toContain('__row')
    stopDebugRun()
  })
})

describe('update_plan（plan-act 进度工具）', () => {
  it('标记进度/非法标记拒绝/全部完成自动置 done/无计划报错', async () => {
    const { getSession, patchSession } = await import('./session')
    const { PLAN_TOOLS } = await import('./tools-plan')
    const up = PLAN_TOOLS.find((t) => t.name === 'update_plan')!
    const doc = loaded()
    const ctx = harness(doc)
    // 无计划
    const noPlan = (await up.exec({ marks: [{ index: 0, status: 'done' }] }, ctx)) as string
    expect(noPlan).toContain('没有执行中的计划')

    // 造 executing 计划
    patchSession(doc.id, {
      plan: {
        raw: '',
        status: 'executing',
        items: [
          { text: '甲', status: 'pending', enabled: true },
          { text: '乙', status: 'pending', enabled: true },
        ],
      },
    })
    const bad = (await up.exec({ marks: [{ index: 0, status: 'weird' }] }, ctx)) as string
    expect(bad).toContain('没有合法的标记')

    const ok = (await up.exec({ marks: [{ index: 0, status: 'in_progress' }] }, ctx)) as string
    expect(ok).toContain('1.→')
    const done = (await up.exec({ marks: [{ index: 0, status: 'done' }, { index: 1, status: 'skipped' }] }, ctx)) as string
    expect(done).toContain('计划全部完成')
    expect(getSession(doc.id).plan!.status).toBe('done')
    expect(getSession(doc.id).plan!.items[1].status).toBe('skipped')
    stopDebugRun()
  })
})

describe('debug_screenshot 优先级（批次9）', () => {
  it('优先截调试画面；失败回落节点图', async () => {
    const { DEBUG_TOOLS } = await import('./tools-debug')
    const tool = DEBUG_TOOLS.find((t) => t.name === 'debug_screenshot')!
    const calls: string[] = []
    const seen: string[] = []
    const ctx: ToolContext = {
      getDoc: () => ({}) as LevelDoc,
      applyDoc: () => {},
      levelId: 'dbg9',
      captureScreenshot: async (target) => {
        calls.push(target ?? 'default')
        return target === 'debug' ? null : 'data:image/png;base64,GRAPH'
      },
      emitImages: (imgs) => seen.push(...imgs),
    }
    const res = (await tool.exec({}, ctx)) as string
    expect(calls).toEqual(['debug', 'graph'])
    expect(seen).toEqual(['data:image/png;base64,GRAPH'])
    expect(res).toContain('已捕获')

    // 全失败：明确失败文案且不 emit
    const ctx2: ToolContext = { ...ctx, captureScreenshot: async () => null, emitImages: () => {} }
    const seen2: string[] = []
    ctx2.emitImages = (imgs) => seen2.push(...imgs)
    const res2 = (await tool.exec({}, ctx2)) as string
    expect(res2).toContain('失败')
    expect(seen2).toEqual([])
  })
})
