/**
 * G3（docs/40 / docs/44 R21）：编辑器关键交互锚点静态契约。
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

const AI_PANEL = source('../editor/ai/AiPanel.tsx')
const GRAPH_EDITOR = source('../editor/graph/GraphEditor.tsx')
const NODE_LIBRARY = source('../editor/graph/NodeLibrary.tsx')
const NODE_TYPES = source('../editor/graph/nodeTypes.tsx')
const EDITOR_PAGE = source('../editor/EditorPage.tsx')
const TABLE_GRID = source('../editor/TableGrid.tsx')
const MODAL = source('../editor/Modal.tsx')

function staticAnchors(file: string, name: string): void {
  expect(file, `缺少静态锚点 data-testid="${name}"`).toContain(`data-testid="${name}"`)
}

/** 动态锚点：`data-testid={\`prefix...\`}` 形式（模板字符串） */
function dynamicAnchor(file: string, prefix: string): void {
  expect(file, `缺少动态锚点前缀 ${prefix}`).toContain(`data-testid={\`${prefix}`)
}

describe('G3 关键交互锚点契约（docs/44 R21）', () => {
  it('EditorPage：工具栏/标题/五 Tab 锚点保留', () => {
    for (const id of ['editor-title', 'editor-undo', 'editor-redo', 'editor-save', 'editor-try-run', 'editor-ai-toggle']) {
      staticAnchors(EDITOR_PAGE, id)
    }
    dynamicAnchor(EDITOR_PAGE, 'editor-tab-')
  })

  it('AiPanel：输入/发送/停止/模式/错误/计划/轮数上限/附件/用量锚点保留', () => {
    for (const id of [
      'ai-panel',
      'ai-input',
      'ai-send',
      'ai-stop',
      'ai-form',
      'ai-attach',
      'ai-usage',
      'ai-rollback',
      'ai-error',
      'ai-error-retry',
      'ai-error-close',
      'ai-plan-card',
      'ai-plan-run',
      'ai-plan-abandon',
      'ai-plan-items',
      'ai-capbar',
      'ai-cap-run',
      'ai-cap-close',
    ]) {
      staticAnchors(AI_PANEL, id)
    }
    dynamicAnchor(AI_PANEL, 'ai-mode-tab-')
  })

  it('GraphEditor：面板开关/布局/视图切换/主题/全屏/lint 锚点保留', () => {
    for (const id of [
      'graph-editor',
      'graph-panel-toggle-library',
      'graph-panel-toggle-events',
      'graph-panel-toggle-vars',
      'graph-panel-toggle-inspector',
      'graph-panel-toggle-ai',
      'graph-panel-toggle-debug',
      'graph-arrange-all',
      'graph-arrange-missing',
      'graph-toggle-script',
      'graph-toggle-log',
      'graph-toggle-map',
      'graph-toggle-summary',
      'graph-toggle-theme',
      'graph-toggle-fullscreen',
      'graph-lint-toggle',
    ]) {
      staticAnchors(GRAPH_EDITOR, id)
    }
  })

  it('节点库/节点卡/数据表/弹窗锚点保留', () => {
    for (const prefix of ['palette-template-', 'palette-item-', 'palette-menu-item-']) dynamicAnchor(NODE_LIBRARY, prefix)
    dynamicAnchor(NODE_TYPES, 'graph-card-')
    staticAnchors(TABLE_GRID, 'tgrid-add-row')
    dynamicAnchor(TABLE_GRID, 'tgrid-row-')
    dynamicAnchor(TABLE_GRID, 'tgrid-cell-')
    staticAnchors(MODAL, 'modal')
  })

  it('高频测试已迁到锚点查询：不再回退 class/文案硬锁（G3 渐进口径）', () => {
    const aiPanelTest = source('../editor/ai/aiPanel.test.tsx')
    for (const fragile of ['.ai-panel-form textarea', '.ai-panel-error', '.ai-plan-card', '.ai-panel-capbar']) {
      expect(aiPanelTest, `aiPanel.test 仍在锁 ${fragile}`).not.toContain(fragile)
    }
    expect(aiPanelTest).toContain('[data-testid="ai-input"]')
    expect(aiPanelTest).toContain('[data-testid="ai-error-close"]')

    const graphTest = source('../editor/graph/graphEditorUi.test.tsx')
    expect(graphTest, 'graphEditorUi.test 仍在锁 React Flow 内部节点类').not.toContain('.react-flow__node[data-id=')
    expect(graphTest).toContain('[data-testid="graph-card-on1"]')
    expect(graphTest).toContain('[data-testid^="graph-panel-toggle-"]')
  })
})
