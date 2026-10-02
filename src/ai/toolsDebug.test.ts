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
