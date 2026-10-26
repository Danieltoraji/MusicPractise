/**
 * 装载管线测试（v4，W9 后唯一关卡格式）：
 * JSON Schema（cfworker）→ normalize → 结构/引用校验 → 语义 lint → {doc, lintWarnings}。
 * 覆盖：合法样例、kind/schemaVersion 拒绝、结构缺字段、重复 id、悬空引用、lint 告警回传、
 * series/topic 信封校验、错误可读化上限。
 */
import { describe, expect, it } from 'vitest'
import noteClickDoc from '../sample/note-click.level.json'
import starterSeries from '../sample/starter.series.json'
import starterTopic1 from '../sample/starter-topic1.topic.json'
import { capErrorLines, loadLevelDoc, validateEnvelope } from './validate'

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

type MutableDoc = {
  kind: string
  schemaVersion: number
  content: Record<string, unknown>
  [key: string]: unknown
}

describe('装载管线 loadLevelDoc（v4）', () => {
  it('合法内置样例装载成功且无 lint 告警', () => {
    const r = loadLevelDoc(noteClickDoc)
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.lintWarnings).toEqual([])
      expect(r.doc.schemaVersion).toBe(4)
      expect(r.doc.content.types.length).toBeGreaterThan(0)
    }
  })

  it('kind 不是 level 时拒绝并提示', () => {
    const r = loadLevelDoc({ ...(noteClickDoc as object), kind: 'series' })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.errors.some((e) => e.includes('kind'))).toBe(true)
  })

  it('非对象/数组输入拒绝', () => {
    for (const raw of [null, 42, 'x', []]) {
      const r = loadLevelDoc(raw)
      expect(r.ok).toBe(false)
    }
  })

  it('旧 schemaVersion 拒绝且提示当前格式为 4', () => {
    const r = loadLevelDoc({ ...(noteClickDoc as object), schemaVersion: 3 })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.errors[0]).toContain('4')
  })

  it('结构缺字段拒绝并列出可读原因（v4 路径定位）', () => {
    const bad = clone(noteClickDoc) as unknown as MutableDoc
    delete bad.content.flow
    const r = loadLevelDoc(bad)
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.errors.length).toBeGreaterThan(0)
      expect(r.errors.join('\n')).toContain('缺少必填字段')
    }
  })

  it('重复组件 id / 重复视图 id 被结构校验拦截', () => {
    const dupComp = clone(noteClickDoc) as unknown as MutableDoc
    const shell = dupComp.content.shell as {
      components: { id: string; type: string; view: string; layout: { x: number; y: number; w: number; h: number } }[]
    }
    shell.components.push({ ...shell.components[0] })
    expect(loadLevelDoc(dupComp).ok).toBe(false)

    const dupView = clone(noteClickDoc) as unknown as MutableDoc
    const shell2 = dupView.content.shell as { views: { id: string; name: string }[] }
    shell2.views.push({ ...shell2.views[0] })
    expect(loadLevelDoc(dupView).ok).toBe(false)
  })

  it('悬空引用（题型实例表引用的 type 不存在）被拦截', () => {
    const bad = clone(noteClickDoc) as unknown as MutableDoc
    const types = bad.content.types as { id: string }[]
    bad.content.types = types.map((t) => ({ ...t, id: `${t.id}-renamed` }))
    expect(loadLevelDoc(bad).ok).toBe(false)
  })

  it('语义 lint 问题以 lintWarnings 回传（编辑器可打开修复）', () => {
    const bad = clone(noteClickDoc) as unknown as {
      content: { flow: { nodes: { id: string; kind: string; [k: string]: unknown }[] } }
    }
    const assign = bad.content.flow.nodes.find((node) => node.kind === 'assign')
    expect(assign).toBeDefined()
    assign!.value = { expr: 'v.' } // 语法错误：lint 应捕获
    const r = loadLevelDoc(bad)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.lintWarnings.length).toBeGreaterThan(0)
  })

  it('validateEnvelope：series/topic 样例通过 v1 校验；未知 kind 拒绝', () => {
    expect(validateEnvelope('series', starterSeries).ok).toBe(true)
    expect(validateEnvelope('topic', starterTopic1).ok).toBe(true)
    const unknown = validateEnvelope('levelx', {})
    expect(unknown.ok).toBe(false)
    expect(unknown.errors[0]).toContain('kind')
  })

  it('capErrorLines 截断长错误列表并给剩余计数', () => {
    const lines = Array.from({ length: 30 }, (_, i) => `错误 ${i}`)
    const capped = capErrorLines(lines)
    expect(capped.length).toBeLessThanOrEqual(21)
    expect(capped[capped.length - 1]).toContain('另有')
  })

  it('装载不会变异输入对象', () => {
    const raw = clone(noteClickDoc)
    const snapshot = JSON.stringify(raw)
    expect(loadLevelDoc(raw).ok).toBe(true)
    expect(JSON.stringify(raw)).toBe(snapshot)
  })

  it('undefined 属性不击穿校验：转为可读装载错误而非抛出', () => {
    const bad = clone(noteClickDoc) as unknown as {
      content: { flow: { nodes: Record<string, unknown>[] } }
    }
    ;(bad.content.flow.nodes[0] as Record<string, unknown>).x = undefined
    expect(() => validateEnvelope('level', bad)).not.toThrow()
    expect(validateEnvelope('level', bad).ok).toBe(false)
  })
})
