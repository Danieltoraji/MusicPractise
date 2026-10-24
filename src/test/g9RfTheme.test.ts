/**
 * G9（docs/40 / docs/44 R28）：React Flow 主题色变量化守卫。
 *
 * 历史：Background/MiniMap 颜色走 JS props 裸 hex（#26355a/#41598c/#6f86b8），
 * 浅色主题仍用深色点阵/小地图色。R28 改为语义 token（RF 会把 color 值写入
 * --xy-background-pattern-color-props / --xy-minimap-node-*-props，CSS var 可嵌套解析）。
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const graphEditor = readFileSync(new URL('../editor/graph/GraphEditor.tsx', import.meta.url), 'utf8')

describe('G9 React Flow 主题色（docs/44 R28）', () => {
  it('Background 点阵颜色走 --ui-* token，不再裸 hex', () => {
    expect(graphEditor).toMatch(/<Background[^>]*color="var\(--ui-[a-z0-9-]+\)"/)
    expect(graphEditor).not.toMatch(/<Background[^>]*color="#[0-9a-fA-F]{3,8}"/)
  })

  it('MiniMap 节点填充/描边走 --ui-* token，不再裸 hex', () => {
    expect(graphEditor).toMatch(/<MiniMap[^>]*nodeColor="var\(--ui-[a-z0-9-]+\)"/)
    expect(graphEditor).toMatch(/<MiniMap[^>]*nodeStrokeColor="var\(--ui-[a-z0-9-]+\)"/)
    expect(graphEditor).not.toMatch(/<MiniMap[^>]*(nodeColor|nodeStrokeColor)="#[0-9a-fA-F]{3,8}"/)
  })

  it('所用 token 已在 graph-editor 语义层定义（浅/深成对）', () => {
    const css = readFileSync(new URL('../index.css', import.meta.url), 'utf8')
    for (const token of ['--ui-line:', '--ui-node-line:', '--ui-edge:']) {
      expect(css, `缺少语义 token ${token}`).toContain(token)
    }
    // 深色映射必须存在（--ui-X: var(--ge-X)）
    expect(css).toContain('--ui-node-line: var(--ge-node-line)')
    expect(css).toContain('--ui-edge: var(--ge-edge)')
  })
})
