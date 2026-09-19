import { describe, expect, it } from 'vitest'
import noteClickDoc from '../sample/note-click.level.json'
import { loadLevelDoc, validateEnvelope } from './validate'

describe('装载管线 loadLevelDoc', () => {
  it('合法关卡装载成功且无 lint 告警', () => {
    const r = loadLevelDoc(noteClickDoc)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.lintWarnings).toEqual([])
  })

  it('kind 不是 level 时拒绝并提示', () => {
    const r = loadLevelDoc({ ...(noteClickDoc as object), kind: 'series' })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.errors.some((e) => e.includes('kind'))).toBe(true)
  })

  it('schema 缺字段拒绝并列出原因', () => {
    const bad = structuredClone(noteClickDoc) as Record<string, unknown>
    delete (bad.content as Record<string, unknown>).questions
    const r = loadLevelDoc(bad)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.errors.length).toBeGreaterThan(0)
  })

  it('schemaVersion 不受支持时拒绝', () => {
    const bad = { ...(noteClickDoc as object), schemaVersion: 2 }
    const r = loadLevelDoc(bad)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.errors.some((e) => e.includes('schemaVersion'))).toBe(true)
  })

  it('lint 告警收集为警告而非拒绝', () => {
    const doc = structuredClone(noteClickDoc) as Record<string, unknown>
    const logic = (doc.content as Record<string, unknown>).logic as Record<string, unknown>
    // v2：未声明变量的 assign 节点（ghostVar 不在 variables 中）由 lint 捕获为警告
    ;(logic.nodes as Record<string, unknown>[]).push({
      id: 'ghost_setter',
      kind: 'assign',
      target: 'ghostVar',
      value: { expr: '1' },
    })
    const r = loadLevelDoc(doc)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.lintWarnings.some((w) => w.includes('ghostVar'))).toBe(true)
  })
})

describe('validateEnvelope', () => {
  it('已知 kind 校验、未知 kind 拒绝', () => {
    expect(validateEnvelope('level', noteClickDoc).ok).toBe(true)
    expect(validateEnvelope('series', noteClickDoc).ok).toBe(false)
    const r = validateEnvelope('patch', {})
    expect(r.ok).toBe(false)
    expect(r.errors[0]).toContain('未知的文档 kind')
  })
})
