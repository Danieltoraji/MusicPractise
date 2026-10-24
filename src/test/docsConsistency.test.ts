/**
 * docs/40 I7/I8/I10/I12 的永久互锁（docs/44 R31）：
 * 文档里最容易再次漂移的「Tab 名、表达式作用域根、GraphEditor 持久化键、令牌清单」
 * 直接从代码读取真源做断言，改代码不改文档会在这里失败。
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const root = new URL('../../', import.meta.url)
const read = (rel: string): string => readFileSync(new URL(rel, root), 'utf8')

const README = read('README.md')
const AGENTS = read('AGENTS.md')
const EDITOR_PAGE = read('src/editor/EditorPage.tsx')
const GRAPH_EDITOR = read('src/editor/graph/GraphEditor.tsx')
const DOCS_29 = read('docs/29-节点图工作台面板化.md')
const DOCS_36 = read('docs/36-UI全量重设计.md')
const CSS = read('src/index.css')

describe('文档一致性（docs/40 I7/I8/I10/I12；docs/44 R31）', () => {
  it('README/AGENTS 的五 Tab 名称与 EditorPage 实际标签一致', () => {
    const labels = [...EDITOR_PAGE.matchAll(/\['(canvas|graph|script|table|json)', '([^']+)'\]/g)].map((m) => m[2])
    expect(labels).toEqual(['画布', '节点图', '脚本', '数据表', 'JSON'])
    expect(README).toContain(`五 Tab = ${labels.join(' / ')}`)
    expect(AGENTS).toContain(`五 Tab = ${labels.join('/')}`)
    // 旧名称不得再出现在 Tab 语境（「伪代码」仍可作 IR 投影的概念名，但 README 的 Tab 行不能写）
    const readmeTabLine = README.split('\n').find((line) => line.includes('五 Tab')) ?? ''
    expect(readmeTabLine).not.toContain('伪代码')
  })

  it('README 表达式作用域根不再写 `$` 前缀（v1 迁移专用）', () => {
    expect(README).not.toMatch(/\$q\.|\$event\.|\$v\./)
    expect(README).toContain('`q.` / `event.` / `v.`')
    expect(README).toContain('`$` 前缀仅 v1 迁移输入')
  })

  it('docs/29 的 localStorage 键清单覆盖 GraphEditor 现行键', () => {
    const keys = [
      'graph-panels',
      'graph-panel-w-left',
      'graph-panel-w-insp',
      'graph-panel-w-ai',
      'graph-dock',
      'graph-dock-h',
      'graph-dock-dbg-w',
      'graph-dock-dbg-h',
      'graph-summary-mode',
      'graph-theme',
    ]
    for (const key of keys) {
      expect(GRAPH_EDITOR, `GraphEditor 不再使用 ${key}？请同步 docs/29 与本测试`).toContain(key)
      expect(DOCS_29, `docs/29 键清单缺少 ${key}`).toContain(key)
    }
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
