// @vitest-environment jsdom
/**
 * EditorPage v4 路由分派集成测试（docs/52 W5 / docs/54 Round 7）：
 * - 库内 v4 文档 → EditorPage 懒加载 EditorPageV4（v3 的五个 Tab 不出现）；
 * - v4 编辑器可渲染内容 Tab（实例表）且不触发 v3 迁移器错误。
 */
import 'fake-indexeddb/auto'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { minimalLevelDoc } from '../engine/v4/fixtures'
import { db, putResource } from '../library/db'
import { EditorPage } from './EditorPage'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root | null = null
let container: HTMLElement | null = null

async function waitFor(predicate: () => boolean, label: string, timeoutMs = 4000): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 15))
    })
  }
  throw new Error(`等待超时：${label}`)
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

describe('EditorPage v4 路由分派', () => {
  it('v4 记录 → 渲染 EditorPageV4（编辑器 Tab 为 v4 六页，而非 v3 五页）', async () => {
    const doc = minimalLevelDoc()
    await putResource(doc, false)
    container = document.createElement('div')
    document.body.appendChild(container)
    await act(async () => {
      root = createRoot(container!)
      root!.render(<EditorPage id={doc.id} />)
    })
    await waitFor(() => container!.querySelector('[data-testid="v4-editor"]') !== null, 'v4 编辑器挂载')
    expect(container.querySelector('[data-testid="editor-tab-content"]')).not.toBeNull()
    expect(container.querySelector('[data-testid="editor-tab-flow"]')).not.toBeNull()
    expect(container.querySelector('[data-testid="editor-tab-canvas"]')).toBeNull()
    expect(container.textContent).not.toContain('无法打开这个关卡')
    expect(container.querySelector('[data-testid="v4-tgrid-row-row_01"]')).not.toBeNull()
    // AI 面板插槽（W8b）：默认打开即懒加载真实 AiPanelV4
    await waitFor(() => container!.querySelector('[data-testid="v4-ai"]') !== null, 'AI 面板插槽挂载')

    // 舞台/预览插槽接线（W7）：切 Tab 后懒加载组件挂载
    const shellTab = container.querySelector('[data-testid="editor-tab-shell"]') as HTMLButtonElement | null
    expect(shellTab).not.toBeNull()
    await act(async () => {
      shellTab!.click()
    })
    await waitFor(() => container!.querySelector('[data-testid="v4-shell-tab"]') !== null, '舞台插槽挂载')

    const previewTab = container.querySelector('[data-testid="editor-tab-preview"]') as HTMLButtonElement | null
    expect(previewTab).not.toBeNull()
    await act(async () => {
      previewTab!.click()
    })
    await waitFor(() => container!.querySelector('[data-testid="v4-preview-tab"]') !== null, '预览插槽挂载')

    // 流程图工作台插槽（W6）：懒加载挂载
    const flowTab = container.querySelector('[data-testid="editor-tab-flow"]') as HTMLButtonElement | null
    expect(flowTab).not.toBeNull()
    await act(async () => {
      flowTab!.click()
    })
    await waitFor(() => container!.querySelector('[data-testid="v4-graph-workbench"]') !== null, '流程图插槽挂载')

    // 预设画廊（W8a）：工具栏开关 → 左栏画廊挂载
    const presetsToggle = container.querySelector('[data-testid="v4-graph-toggle-presets"]') as HTMLButtonElement | null
    expect(presetsToggle).not.toBeNull()
    await act(async () => {
      presetsToggle!.click()
    })
    await waitFor(
      () => container!.querySelector('[data-testid="v4-graph-presets-panel"]') !== null,
      '预设画廊挂载',
    )
  })
})
