/**
 * G14（docs/40 / docs/44 R23；W9 翻转后 v4）：编辑器双用 hook class 静态契约。
 *
 * 锁定：
 * - `EDITOR_HOOKS` 的值 = JS/CSS/测试共同依赖的行为契约（改名需显式改测试与文档）；
 * - 消费点引用常量，而不是散落裸字符串。
 * W9 后 v3 AI 面板/舞台组件已删除，消费点改为 v4 外壳/工作台/舞台/列表编辑器。
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { EDITOR_HOOKS } from '../editor/editorHooks'

const source = (rel: string): string => readFileSync(new URL(rel, import.meta.url), 'utf8')

describe('G14 编辑器 hook class 集中登记（v4）', () => {
  it('常量值固定（改名 = 改契约，需同步 CSS/测试/文档）', () => {
    expect(EDITOR_HOOKS).toEqual({
      editorBody: 'editor-body',
      editorCanvas: 'editor-canvas',
      graphNodes: 'react-flow__nodes',
      graphFlow: 'react-flow',
      graphToggle: 'gtoggle',
      tlistModal: 'tlist-modal',
      stageViewport: 'stage-viewport',
      stageCanvas: 'stage-canvas',
      debugStageCanvas: 'gdb-stage-canvas',
    })
  })

  it('CSS 侧仍存在对应 hook 类（常量不能指向不存在的选择器）', () => {
    const css = source('../index.css')
    for (const cls of [
      EDITOR_HOOKS.editorBody,
      EDITOR_HOOKS.editorCanvas,
      EDITOR_HOOKS.tlistModal,
      EDITOR_HOOKS.stageViewport,
      EDITOR_HOOKS.stageCanvas,
      EDITOR_HOOKS.debugStageCanvas,
    ]) {
      expect(css, `CSS 缺少 .${cls}`).toContain(`.${cls}`)
    }
    // .gtoggle / .react-flow__* 是 JS/测试钩子（无样式或 RF 内部类），不做 CSS 断言
  })

  it('JS 消费点引用常量而非裸字符串（列表聚焦/舞台/工具栏/画布）', () => {
    const list = source('../editor/ListEditor.tsx')
    expect(list).toContain('EDITOR_HOOKS.tlistModal')
    expect(list).not.toContain(`'.tlist-modal .tlist-row input'`)

    const stage = source('../runtime/v4/LevelStageV4.tsx')
    expect(stage).toContain('EDITOR_HOOKS.stageViewport')
    expect(stage).toContain('EDITOR_HOOKS.stageCanvas')

    const shell = source('../editor/v4/V4EditorShell.tsx')
    expect(shell).toContain('EDITOR_HOOKS.editorBody')

    const shellTab = source('../editor/v4/ShellTab.tsx')
    expect(shellTab).toContain('EDITOR_HOOKS.editorCanvas')

    const graph = source('../editor/v4/graph/GraphWorkbench.tsx')
    expect(graph).toContain('EDITOR_HOOKS.graphToggle')

    for (const rel of ['../cloud/CloudPage.tsx', '../pages/LibraryPage.tsx']) {
      expect(source(rel), `${rel} 未引用 EDITOR_HOOKS.tlistModal（共享弹窗外壳）`).toContain('EDITOR_HOOKS.tlistModal')
    }
  })
})
