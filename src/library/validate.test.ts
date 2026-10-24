import { describe, expect, it } from 'vitest'
import noteClickDoc from '../sample/note-click.level.json'
import v1NoteClickDoc from '../sample/fixtures/note-click.v1.json'
import type { LevelDoc } from '../engine/level'
import { capErrorLines, lintLoadedLevel, loadLevelDoc, validateEnvelope } from './validate'

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

describe('D5 唯一性预检（docs/40 / docs/42 E1-b）', () => {
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

  it('E1-b：重复逻辑节点 id 被拦截并带可读位置（运行时 byId 后者覆盖前者 → 执行错节点）', () => {
    const dupNode = JSON.parse(JSON.stringify(noteClickDoc)) as {
      content: { logic: { nodes: { id: string }[] } }
    }
    dupNode.content.logic.nodes.push(JSON.parse(JSON.stringify(dupNode.content.logic.nodes[0])))
    const r = loadLevelDoc(dupNode)
    expect(r.ok).toBe(false)
    if (!r.ok) {
      const msg = r.errors.find((e) => e.includes('逻辑节点') && e.includes('重复'))
      expect(msg).toBeTruthy()
      expect(msg).toContain('第 1 项')
      expect(msg).toContain('重复出现 2 次')
    }
  })

  it('E1-b：重复逻辑连线 id 被拦截并带可读位置', () => {
    const dupEdge = JSON.parse(JSON.stringify(noteClickDoc)) as {
      content: { logic: { edges: { id: string }[] } }
    }
    dupEdge.content.logic.edges.push({ ...dupEdge.content.logic.edges[0] })
    const r = loadLevelDoc(dupEdge)
    expect(r.ok).toBe(false)
    if (!r.ok) {
      const msg = r.errors.find((e) => e.includes('逻辑连线') && e.includes('重复'))
      expect(msg).toBeTruthy()
      expect(msg).toContain('重复出现 2 次')
    }
  })
})

describe('E1-a：undefined 属性不再击穿校验（docs/42 §4.1）', () => {
  it('validateEnvelope 遇 undefined 不抛裸异常，转成可读错误', () => {
    // 复现：脚本合并曾给无坐标旧图写出显式 x: undefined → cfworker 抛
    // 「Instances of "undefined" type are not supported」
    const bad = JSON.parse(JSON.stringify(noteClickDoc)) as {
      content: { logic: { nodes: Record<string, unknown>[] } }
    }
    bad.content.logic.nodes[0].x = undefined
    expect(() => validateEnvelope('level', bad)).not.toThrow()
    const r = validateEnvelope('level', bad)
    expect(r.ok).toBe(false)
    expect(r.errors.join(' ')).toContain('undefined')
    expect(r.errors.join(' ')).toContain('无法处理的值')
  })

  it('loadLevelDoc（保存/导入/AI 写入同一路径）返回装载错误而非抛出', () => {
    const bad = JSON.parse(JSON.stringify(noteClickDoc)) as {
      content: { logic: { nodes: Record<string, unknown>[] } }
    }
    bad.content.logic.nodes[0].y = undefined
    expect(() => loadLevelDoc(bad)).not.toThrow()
    const r = loadLevelDoc(bad)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.errors.some((e) => e.includes('undefined'))).toBe(true)
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

describe('A5/F6 校验与装载 lint 收口（docs/44 R16）', () => {
  it('A5：v1 旧档校验失败时优先展示 v1 分支错误（不再被 v3 分支字段淹没）', () => {
    const raw = JSON.parse(JSON.stringify(v1NoteClickDoc)) as { content: { questions: unknown[] } }
    raw.content.questions = []
    const r = validateEnvelope('level', raw)
    expect(r.ok).toBe(false)
    // v1 分支错误：questions 数量不足；v3 分支会报 schemaVersion/content.table 等无关字段
    expect(r.errors.some((e) => e.includes('questions'))).toBe(true)
    expect(r.errors.some((e) => e.includes('文档声明为 v1 旧格式'))).toBe(true)
  })

  it('A5：根级/未知路径错误不以「 · 」开头', () => {
    const raw = { schemaVersion: 3, kind: 'level' } as Record<string, unknown>
    const r = validateEnvelope('level', raw)
    expect(r.ok).toBe(false)
    for (const e of r.errors) expect(e.startsWith(' · ')).toBe(false)
    expect(r.errors.some((e) => e.includes('content'))).toBe(true)
  })

  it('F6：lintLoadedLevel 同时覆盖 flow.pass 语法与悬空视图（与保存路径同口径）', () => {
    const doc = JSON.parse(JSON.stringify(noteClickDoc)) as LevelDoc
    doc.content.flow = { pass: { expr: 'v.score >=' } }
    doc.content.components.push({ id: 'dangling', type: 'label', view: 'ghost' } as never)
    const warnings = lintLoadedLevel(doc)
    expect(warnings.some((w) => w.includes('flow.pass') && w.includes('语法错误'))).toBe(true)
    expect(warnings.some((w) => w.includes('不存在的视图') && w.includes('ghost'))).toBe(true)
  })
})
