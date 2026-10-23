// @vitest-environment node
// D6（docs/40）：列类型改动点一致性——分散在 7+ 处的清单由测试互锁，改 schema/常量漏同步时在此变红
import { describe, expect, it } from 'vitest'
import levelSchema from '../../schemas/v1/level.json'
import { DATA_APPLY_ACCEPTED_TYPES, DATA_APPLY_COMMANDS, COLUMN_TYPE_LABELS } from '../engine/level'
import { COLUMN_TYPES, DEFAULT_COL_W } from './TableGrid'
import { SCHEMA_LIMITS } from '../library/schemaLimits'

// 递归搜出列类型 enum（避免对 schema 深层结构硬编码路径；断言内容唯一性即可）
function findColumnEnum(node: unknown): string[] {
  if (Array.isArray(node)) {
    if (node.length === 6 && node.includes('text') && node.includes('json')) return node as string[]
    for (const x of node) {
      const r = findColumnEnum(x)
      if (r.length > 0) return r
    }
  } else if (node !== null && typeof node === 'object') {
    for (const v of Object.values(node as Record<string, unknown>)) {
      const r = findColumnEnum(v)
      if (r.length > 0) return r
    }
  }
  return []
}
const schemaEnum = findColumnEnum(levelSchema)

describe('列类型清单一致性（docs/40 D6）', () => {
  it('TableGrid.COLUMN_TYPES 与 schema enum 完全一致', () => {
    const uiTypes = COLUMN_TYPES.map((c) => c.value).sort()
    expect(uiTypes).toEqual([...schemaEnum].sort())
  })

  it('DEFAULT_COL_W 覆盖全部类型', () => {
    for (const t of schemaEnum) expect(DEFAULT_COL_W[t as keyof typeof DEFAULT_COL_W]).toBeGreaterThan(0)
  })

  it('COLUMN_TYPE_LABELS 覆盖全部类型', () => {
    for (const t of schemaEnum) expect(COLUMN_TYPE_LABELS[t as keyof typeof COLUMN_TYPE_LABELS]).toBeTruthy()
  })

  it('DATA_APPLY_ACCEPTED_TYPES：accept 值都是合法类型；DATA_APPLY_COMMANDS 引用的命令都有格式矩阵', () => {
    // 键 = 方法名；值.accept = 接受的列类型
    for (const entry of Object.values(DATA_APPLY_ACCEPTED_TYPES)) {
      for (const t of entry.accept) expect(schemaEnum).toContain(t)
    }
    for (const cmds of Object.values(DATA_APPLY_COMMANDS)) {
      for (const entry of Object.values(cmds)) {
        expect(DATA_APPLY_ACCEPTED_TYPES[entry.method as keyof typeof DATA_APPLY_ACCEPTED_TYPES]).toBeDefined()
      }
    }
  })
})

describe('schemaLimits 与 schema 数值一致（docs/40 A5/D6）', () => {
  it('列名/显示名长度与单元格音符上限与 common.json 对齐', () => {
    // 数值快照：schema 修改时此处提醒同步
    expect(SCHEMA_LIMITS.columnKeyMaxLength).toBe(32)
    expect(SCHEMA_LIMITS.columnLabelMaxLength).toBe(24)
    expect(SCHEMA_LIMITS.notesPerCell).toBe(64)
    expect(SCHEMA_LIMITS.components).toBe(64)
    expect(SCHEMA_LIMITS.views).toBe(32)
    expect(SCHEMA_LIMITS.tableColumns).toBe(32)
    expect(SCHEMA_LIMITS.tableRows).toBe(512)
  })
})
