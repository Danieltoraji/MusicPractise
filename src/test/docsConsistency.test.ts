/**
 * 文档一致性永久互锁（docs/40 I7/I8/I10/I12；docs/44 R31；W9 翻转后 v4）：
 * 文档里最容易再次漂移的「编辑器 Tab 名、表达式作用域根、图工作台持久化键、令牌清单」
 * 直接从代码读取真源做断言，改代码不改文档会在这里失败。
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const root = new URL('../../', import.meta.url)
const read = (rel: string): string => readFileSync(new URL(rel, root), 'utf8')

const README = read('README.md')
const AGENTS = read('AGENTS.md')
const V4_SHELL = read('src/editor/v4/V4EditorShell.tsx')
const GRAPH_WORKBENCH = read('src/editor/v4/graph/GraphWorkbench.tsx')
const DOCS_53 = read('docs/53-关卡运行时v4规格冻结.md')
const DOCS_36 = read('docs/36-UI全量重设计.md')
const CSS = read('src/index.css')

describe('文档一致性（v4）', () => {
  it('README/AGENTS 的 v4 六 Tab 名称与 V4EditorShell 实际标签一致', () => {
    const labels = [...V4_SHELL.matchAll(/\{ id: '(content|flow|types|shell|preview|json)', label: '([^']+)' \}/g)].map(
      (m) => m[2],
    )
    expect(labels).toEqual(['内容', '流程', '题型', '画布', '预览', 'JSON'])
    expect(README).toContain(`v4 编辑器六 Tab = ${labels.join(' / ')}`)
    expect(AGENTS).toContain(`v4 编辑器六 Tab = ${labels.join('/')}`)
    // W13：编辑器 Tab 恢复「画布」（内部 id shell；运行时播放面仍叫舞台）
    expect(README).toContain('画布=shell')
  })

  it('图工作台持久化键 graph-theme 与文档一致', () => {
    expect(GRAPH_WORKBENCH).toContain("'graph-theme'")
    expect(AGENTS).toContain('graph-theme')
    expect(DOCS_53).toContain('graph-theme')
  })

  it('docs/36 令牌清单与 index.css 一致（不再声称未实现的 --sp-8/--surface/--shell-ink）', () => {
    expect(CSS).toContain('--sp-7:')
    expect(CSS).not.toContain('--sp-8:')
    expect(DOCS_36).not.toContain('--sp-8:')
    expect(DOCS_36).not.toContain('--sp-1..8')
    expect(DOCS_36).not.toContain('`--surface`')
    expect(DOCS_36).not.toContain('`--shell-ink`')
  })
})
