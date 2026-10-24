/**
 * G12（docs/40 / docs/44 R24）：共享弹窗外壳 `.modal-*` 通用契约 + `.tjson-*` 旧类名 alias。
 *
 * 历史：`.tjson-*`/`.tlist-*` 被数据表弹窗、云盘上传/发布、资源库管理跨页复用，
 * 类名与语义脱节。R24 起新增通用 `.modal-backdrop/.modal-shell/.modal-head`，
 * 保留旧类名 alias（既有测试/JS 查询不破坏）；全量迁移到 generic-only 留待后续批次。
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const source = (rel: string): string => readFileSync(new URL(rel, import.meta.url), 'utf8')

describe('G12 共享弹窗外壳契约（docs/44 R24）', () => {
  it('CSS 定义通用 .modal-* 且保留 .tjson-* alias（组合选择器）', () => {
    const css = source('../index.css')
    expect(css).toContain('.tjson-backdrop,\n.modal-backdrop')
    expect(css).toContain('.tjson-modal,\n.modal-shell')
    expect(css).toContain('.tjson-modal-head,\n.modal-head')
    expect(css).toContain('.modal-shell.tlist-modal')
  })

  it('统一 Modal 外壳使用通用类名（保留旧类名以兼容既有契约）', () => {
    const modal = source('../editor/Modal.tsx')
    expect(modal).toContain('tjson-backdrop modal-backdrop')
    expect(modal).toContain('tjson-modal modal-shell')
    expect(modal).toContain('tjson-modal-head modal-head')
  })

  it('跨页复用点（云盘上传/发布、资源库管理）已带通用类名', () => {
    for (const rel of ['../cloud/CloudPage.tsx', '../pages/LibraryPage.tsx']) {
      const file = source(rel)
      expect(file, `${rel} 缺少 modal-backdrop`).toContain('tjson-backdrop modal-backdrop')
      expect(file, `${rel} 缺少 modal-shell`).toContain('modal-shell')
      expect(file, `${rel} 缺少 modal-head`).toContain('tjson-modal-head modal-head')
    }
  })
})
