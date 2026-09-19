import { describe, expect, it } from 'vitest'
import noteClickDoc from '../sample/note-click.level.json'
import v1NoteClickDoc from '../sample/fixtures/note-click.v1.json'
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
    delete (bad.content as Record<string, unknown>).table
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

  it('P1 回归：v1 文档装载后产出 v2 且输入对象不被变异', () => {
    // 用 v1 夹具深拷贝作为输入
    const raw = JSON.parse(JSON.stringify(v1NoteClickDoc))
    const snapshot = JSON.stringify(raw)
    const r = loadLevelDoc(raw)
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect((r.doc.content.logic as { logicVersion?: number }).logicVersion).toBe(2)
      expect(Array.isArray((r.doc.content.logic as { nodes?: unknown }).nodes)).toBe(true)
    }
    expect(JSON.stringify(raw)).toBe(snapshot)
  })

  it('P1 回归：迁移器拒绝的文档（规则 id 重复）转为装载错误而非抛出', () => {
    const raw = JSON.parse(JSON.stringify(v1NoteClickDoc)) as Record<string, unknown>
    const content = raw.content as Record<string, unknown>
    const logic = JSON.parse(JSON.stringify(content.logic)) as Record<string, unknown>
    const rules = logic.rules as unknown[]
    rules.push(structuredClone(rules[0]))
    content.logic = logic
    const r = loadLevelDoc(raw)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.errors.some((e) => e.includes('迁移失败'))).toBe(true)
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
