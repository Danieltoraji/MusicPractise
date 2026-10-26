// @vitest-environment jsdom
/**
 * v4 关卡页分发集成测试（docs/52 W3.3 / docs/54 Round 7）：
 * - `LevelPage` 按 doc.schemaVersion===4 走 loadLevelDocV4 + LevelRunnerV4（不经过 v3 装载管线）；
 * - 跑完一关后结算条出现、进度落库（saveProgress）、不再渲染 v3 的 #/graph 入口；
 * - 非法 v4 文档显示装载错误页。
 */
import 'fake-indexeddb/auto'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { minimalLevelDoc } from '../engine/v4/fixtures'
import type { BehaviorProgram, FlowNode, GraphEdge, LevelDocV4 } from '../engine/v4/model'
import { db, putResource } from '../library/db'
import { LevelPage } from './LevelPage'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

function flowProgram(nodes: FlowNode[], edges: GraphEdge[]): LevelDocV4['content']['flow'] {
  return {
    logicVersion: 3,
    kind: 'flow',
    nodes,
    edges,
    vars: [{ key: 'score', type: 'number', init: 0 }],
  }
}

function out(from: string, to: string, port?: 'true' | 'false'): GraphEdge {
  return { id: `e_${from}_${to}_${port ?? 'out'}`, from, to, ...(port ? { port } : {}) }
}

function makeV4Doc(): LevelDocV4 {
  const doc = minimalLevelDoc()
  doc.content.types[0].behavior = {
    logicVersion: 3,
    kind: 'behavior',
    nodes: [
      { id: 'b_start', kind: 'on', event: 'start' },
      { id: 'b_ret', kind: 'return', result: "{ status: 'answered', correct: true, scoreDelta: q.scoring }" },
    ],
    edges: [out('b_start', 'b_ret')],
  } satisfies BehaviorProgram
  doc.content.flow = flowProgram(
    [
      { id: 'f_start', kind: 'start' },
      { id: 'f_foreach', kind: 'foreach', items: 'run.questions', itemVar: 'slot' },
      { id: 'f_ask', kind: 'ask', target: 'local.slot', resultVar: 'result' },
      { id: 'f_apply', kind: 'assign', target: 'v.score', value: { expr: 'v.score + local.result.scoreDelta' } },
      { id: 'f_finish', kind: 'finish', passed: 'v.score >= 20' },
    ],
    [
      out('f_start', 'f_foreach'),
      out('f_foreach', 'f_ask', 'true'),
      out('f_foreach', 'f_finish', 'false'),
      out('f_ask', 'f_apply'),
      out('f_apply', 'f_foreach'),
    ],
  )
  return doc
}

let root: Root | null = null
let container: HTMLElement | null = null

async function renderPage(id: string): Promise<HTMLElement> {
  container = document.createElement('div')
  document.body.appendChild(container)
  await act(async () => {
    root = createRoot(container!)
    root!.render(<LevelPage id={id} />)
  })
  for (let i = 0; i < 60; i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10))
    })
    if (container?.querySelector('[data-testid="v4-result"]')) break
  }
  return container
}

beforeEach(async () => {
  await db.resources.clear()
  await db.progress.clear()
})

afterEach(async () => {
  await act(async () => {
    root?.unmount()
  })
  root = null
  container?.remove()
  container = null
})

describe('v4 关卡页分发', () => {
  it('schemaVersion=4 → 渲染 v4 舞台并完成通关，进度落库', async () => {
    const doc = makeV4Doc()
    await putResource(doc, false)
    const el = await renderPage(doc.id)
    expect(el.querySelector('[data-testid="v4-stage-viewport"]')).not.toBeNull()
    expect(el.querySelector('.stage-canvas')).not.toBeNull()
    expect(el.querySelector('.v4-shell')).not.toBeNull()
    const result = el.querySelector('[data-testid="v4-result"]')
    expect(result).not.toBeNull()
    expect(result!.textContent).toContain('得分 20')
    expect(el.querySelector(`a[href="#/graph/${doc.id}"]`)).toBeNull()
    const progress = await db.progress.get(doc.id)
    expect(progress).toMatchObject({ bestScore: 20, passed: 1, attempts: 1 })
  })

  it('非法 v4 文档 → 装载错误页（不走 v3 装载管线）', async () => {
    const doc = makeV4Doc() as unknown as Record<string, unknown>
    ;(doc.content as Record<string, unknown>).manifest = { entries: [{ type: 'ghost', row: 'nope' }] }
    await putResource(doc as never, false)
    const el = await renderPage(String(doc.id))
    expect(el.textContent).toContain('关卡无法加载')
    expect(el.textContent).toContain('不存在的题型')
  })
})
