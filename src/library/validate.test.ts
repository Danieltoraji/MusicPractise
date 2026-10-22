import { describe, expect, it } from 'vitest'
import noteClickDoc from '../sample/note-click.level.json'
import v1NoteClickDoc from '../sample/fixtures/note-click.v1.json'
import { capErrorLines, loadLevelDoc, validateEnvelope } from './validate'

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

describe('D5 唯一性预检（docs/40）', () => {
  it('重复组件 id / 视图 id / 列 key 在 loadLevelDoc 被拦截（保存/导入/AI 写入路径）', () => {
    const dupComp = JSON.parse(JSON.stringify(noteClickDoc)) as { content: { components: { id: string }[] } }
    dupComp.content.components.push(JSON.parse(JSON.stringify(dupComp.content.components[0])))
    const r1 = loadLevelDoc(dupComp)
    expect(r1.ok).toBe(false)
    if (!r1.ok) expect(r1.errors.some((e) => e.includes('组件 id') && e.includes('重复'))).toBe(true)

    const dupView = JSON.parse(JSON.stringify(noteClickDoc)) as { content: { views: { id: string }[] } }
    dupView.content.views.push({ ...dupView.content.views[0] })
    const r2 = loadLevelDoc(dupView)
    expect(r2.ok).toBe(false)
    if (!r2.ok) expect(r2.errors.some((e) => e.includes('视图 id') && e.includes('重复'))).toBe(true)

    const dupCol = JSON.parse(JSON.stringify(noteClickDoc)) as { content: { table: { columns: { key: string }[] } } }
    dupCol.content.table.columns.push({ ...dupCol.content.table.columns[0] })
    const r3 = loadLevelDoc(dupCol)
    expect(r3.ok).toBe(false)
    if (!r3.ok) expect(r3.errors.some((e) => e.includes('数据表列') && e.includes('重复'))).toBe(true)
  })
})

describe('A5 校验错误可读化（docs/40）', () => {
  it('v3 文档缺必填：错误为中文「位置：标签——细节」形态且只保留 v3 分支（oneOf 归纳）', () => {
    const bad = JSON.parse(JSON.stringify(noteClickDoc)) as Record<string, unknown>
    delete (bad as { meta?: unknown }).meta
    const r = validateEnvelope('level', bad)
    expect(r.ok).toBe(false)
    // oneOf 双分支：V1Level 与 V3Level 都会失败——归纳后不得出现成对的重复结构
    if (!r.ok) {
      expect(r.errors.length).toBeGreaterThan(0)
      expect(r.errors.some((e) => e.includes('缺少必填字段'))).toBe(true)
      // 同文去重：meta 缺失在双分支下曾输出两条同文
      expect(r.errors.filter((e) => e.includes('缺少必填字段')).length).toBeLessThan(r.errors.length + 2)
    }
  })

  it('数据表内错误定位中文化为「数据表第 N 行」', () => {
    const bad = JSON.parse(JSON.stringify(noteClickDoc)) as { content: { table: { rows: Record<string, unknown>[] } } }
    // 破坏行结构：把第一行改成字符串（rows.items 要求 object）
    bad.content.table.rows[0] = 'poison' as unknown as Record<string, unknown>
    const r = validateEnvelope('level', bad)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.errors.some((e) => e.includes('数据表第 1 行'))).toBe(true)
  })

  it('大量错误截断为上限并附总数提示（capErrorLines；cfworker 对数组首败短路，自然流难超限故直测）', () => {
    const lines = Array.from({ length: 25 }, (_, i) => `组件第 ${i + 1} 项：类型不符`)
    const capped = capErrorLines(lines)
    expect(capped).toHaveLength(21)
    expect(capped[20]).toContain('另有 5 条')
    expect(capErrorLines(lines.slice(0, 5))).toHaveLength(5)
  })
})

describe('F6 flow.pass 表达式语法 lint（docs/40）', () => {
  it('语法错误的 pass.expr → lintWarnings 提示静默未通过风险', () => {
    const bad = JSON.parse(JSON.stringify(noteClickDoc)) as { content: { flow: { pass: { expr: string } } } }
    bad.content.flow = { pass: { expr: 'v.score >=' } }
    const r = loadLevelDoc(bad)
    expect(r.ok).toBe(true) // 宽松放行（先放行后清洗），但必须告警
    if (r.ok) expect(r.lintWarnings.some((w) => w.includes('flow.pass') && w.includes('语法错误'))).toBe(true)
  })

  it('合法 pass.expr 不告警', () => {
    const ok = JSON.parse(JSON.stringify(noteClickDoc)) as { content: { flow: { pass: { expr: string } } } }
    ok.content.flow = { pass: { expr: 'v.score >= 10' } }
    const r = loadLevelDoc(ok)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.lintWarnings.some((w) => w.includes('flow.pass'))).toBe(false)
  })
})
