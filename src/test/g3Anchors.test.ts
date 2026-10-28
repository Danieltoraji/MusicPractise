/**
 * G3（docs/40 / docs/44 R21；W9 翻转后 v4）：编辑器关键交互锚点静态契约。
 *
 * 目的：把「新增/修改交互必须带 data-testid」从口头约定变成可执行回归——
 * - 关键组件必须保留约定锚点（防止重构时静默删除）；
 * - 高频测试必须使用锚点查询（已迁移部分锁定，防止回退到 class/文案硬锁）。
 *
 * 只做 source 级静态断言（jsdom 无样式表，无法验证视觉）；视觉矩阵仍属发布前人工项。
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const source = (rel: string): string => readFileSync(new URL(rel, import.meta.url), 'utf8')

const V4_SHELL = source('../editor/v4/V4EditorShell.tsx')
const GRAPH_WORKBENCH = source('../editor/v4/graph/GraphWorkbench.tsx')
const GRAPH_CARD = source('../editor/v4/graph/GraphCard.tsx')
const INSPECTOR = source('../editor/v4/graph/NodeInspector.tsx')
const CONTENT_TAB = source('../editor/v4/ContentTab.tsx')
const AI_PANEL = source('../editor/v4/AiPanelV4.tsx')
const SHELL_TAB = source('../editor/v4/ShellTab.tsx')
const CANVAS_EDITOR = source('../editor/v4/CanvasEditor.tsx')
const PREVIEW_TAB = source('../editor/v4/PreviewTab.tsx')
const MODAL = source('../editor/Modal.tsx')

function staticAnchors(file: string, name: string): void {
  expect(file, `缺少静态锚点 data-testid="${name}"`).toContain(`data-testid="${name}"`)
}

/** 动态锚点：`data-testid={\`prefix...\`}` 形式（模板字符串） */
function dynamicAnchor(file: string, prefix: string): void {
  expect(file, `缺少动态锚点前缀 ${prefix}`).toContain(`data-testid={\`${prefix}`)
}

describe('G3 关键交互锚点契约（v4）', () => {
  it('V4EditorShell：标题/撤销/保存/试玩/AI 开关/六 Tab 锚点保留', () => {
    for (const id of ['v4-editor', 'editor-title', 'editor-undo', 'editor-redo', 'editor-save', 'editor-try-run', 'editor-ai-toggle']) {
      staticAnchors(V4_SHELL, id)
    }
    dynamicAnchor(V4_SHELL, 'editor-tab-')
  })

  it('GraphWorkbench：视图切换/面板开关/布局/lint/画布/停靠栏锚点保留', () => {
    for (const id of [
      'v4-graph-workbench',
      'v4-graph-view-graph',
      'v4-graph-view-script',
      'v4-graph-toggle-palette',
      'v4-graph-toggle-vars',
      'v4-graph-toggle-presets',
      'v4-graph-toggle-inspector',
      'v4-graph-arrange',
      'v4-graph-theme',
      'v4-graph-lint-toggle',
      'v4-graph-canvas',
      'v4-graph-dock-left',
      'v4-graph-dock-right',
      'v4-graph-palette',
      'v4-graph-vars-panel',
      'v4-graph-presets-panel',
      'v4-graph-issues',
    ]) {
      staticAnchors(GRAPH_WORKBENCH, id)
    }
    for (const prefix of ['palette-item-', 'palette-menu-item-', 'palette-group-']) {
      dynamicAnchor(GRAPH_WORKBENCH, prefix)
    }
    staticAnchors(INSPECTOR, 'v4-graph-field-error')
    dynamicAnchor(GRAPH_CARD, 'graph-card-')
    expect(GRAPH_CARD).toContain('data-node-kind')
  })

  it('ContentTab / 共享画布 / PreviewTab / AiPanel 锚点保留', () => {
    for (const prefix of ['v4-tgrid-row-', 'v4-type-select-']) dynamicAnchor(CONTENT_TAB, prefix)
    expect(CONTENT_TAB).toContain(`v4-tgrid-cell-`)
    staticAnchors(CONTENT_TAB, 'v4-tgrid-add-row')
    staticAnchors(SHELL_TAB, 'v4-shell-tab')
    for (const id of [
      'v4-canvas',
      'v4-canvas-palette',
      'v4-canvas-search',
      'v4-canvas-views',
      'v4-canvas-viewport',
      'v4-canvas-stage',
      'v4-canvas-inspector',
      'v4-canvas-empty',
      'v4-canvas-error',
      'v4-canvas-scale',
    ]) {
      staticAnchors(CANVAS_EDITOR, id)
    }
    for (const prefix of [
      'v4-canvas-add-',
      'v4-canvas-box-',
      'v4-canvas-view-',
      'v4-canvas-item-',
      'v4-canvas-binding-',
    ]) {
      dynamicAnchor(CANVAS_EDITOR, prefix)
    }
    staticAnchors(PREVIEW_TAB, 'v4-preview-tab')
    staticAnchors(PREVIEW_TAB, 'v4-preview-debug')
    for (const id of ['v4-ai', 'v4-ai-input', 'v4-ai-send', 'v4-ai-stop', 'v4-ai-error', 'v4-ai-capbar']) {
      staticAnchors(AI_PANEL, id)
    }
    dynamicAnchor(AI_PANEL, 'v4-ai-mode-')
    staticAnchors(MODAL, 'modal')
  })

  it('高频测试已迁到锚点查询：不再回退 class/文案硬锁（G3 渐进口径）', () => {
    const routeTest = source('../editor/editorRouteV4.test.tsx')
    expect(routeTest).toContain('[data-testid="editor-tab-')
    expect(routeTest).toContain('[data-testid="v4-graph-workbench"]')

    const graphTest = source('../editor/v4/graph/graphWorkbench.test.tsx')
    expect(graphTest, 'graphWorkbench.test 仍在锁 React Flow 内部节点类').not.toContain('.react-flow__node[data-id=')
    expect(graphTest).toContain("'graph-card-f_start'")
    expect(graphTest).toContain("'v4-graph-")

    const aiTest = source('../editor/v4/aiPanelV4.test.tsx')
    expect(aiTest).toContain('[data-testid="v4-ai-input"]')
    expect(aiTest).toContain('[data-testid="v4-ai-send"]')
    for (const fragile of ['.ai-panel-form textarea', '.ai-panel-error', '.ai-panel-capbar']) {
      expect(aiTest, `aiPanelV4.test 仍在锁 ${fragile}`).not.toContain(fragile)
    }
  })
})
