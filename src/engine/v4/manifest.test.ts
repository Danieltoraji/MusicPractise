import { describe, expect, it } from 'vitest'
import {
  ManifestError,
  buildAutoManifest,
  buildDeck,
  buildExplicitManifest,
  buildManifest,
  hashSeed,
  mulberry32,
  resolveSeed,
  shuffleWith,
  shuffleWithinPhase,
} from './manifest'
import { minimalLevelDoc, twoTypeLevelDoc } from './fixtures'

function refs(slots: { type: string; row: string }[]): string[] {
  return slots.map((s) => `${s.type}/${s.row}`)
}

describe('v4 manifest：自动题单', () => {
  it('排除 draft，按 (phase, order, 题型声明序, 行序) 排序', () => {
    const doc = twoTypeLevelDoc()
    expect(refs(buildAutoManifest(doc))).toEqual([
      'choice/row_01',
      'listen/row_12',
      'listen/row_11',
      'choice/row_02',
      'listen/row_13',
    ])
  })

  it('同 phase+order 平票时按题型声明顺序', () => {
    const doc = twoTypeLevelDoc()
    // listen.row_11 的 order 改成 0：与 choice.row_01 同为 (phase1, order0)
    const row = doc.content.tables.listen.rows.find((r) => r.id === 'row_11')
    if (!row) throw new Error('fixture 缺 row_11')
    row.order = 0
    expect(refs(buildAutoManifest(doc)).slice(0, 2)).toEqual(['choice/row_01', 'listen/row_11'])
  })

  it('行 order 支持显式覆盖（非行序）', () => {
    const doc = minimalLevelDoc()
    const row = doc.content.tables.choice.rows[1]
    row.order = 0
    // row_02 显式 order 0 → 排在默认 order 0（行序）的 row_01 之前？平票按题型/行序，故仍 row_01 在前
    expect(refs(buildAutoManifest(doc))).toEqual(['choice/row_01', 'choice/row_02'])
  })

  it('buildManifest 缺省走自动题单（explicit=false）', () => {
    const build = buildManifest(twoTypeLevelDoc())
    expect(build.explicit).toBe(false)
    expect(build.slots).toHaveLength(5)
  })
})

describe('v4 manifest：显式题单', () => {
  it('严格按 entries 顺序、draft 可引用、args 保留', () => {
    const doc = twoTypeLevelDoc()
    doc.content.manifest = {
      entries: [
        { type: 'listen', row: 'row_13', args: { difficulty: 2 } },
        { type: 'choice', row: 'row_03' },
      ],
    }
    const build = buildManifest(doc)
    expect(build.explicit).toBe(true)
    expect(refs(build.slots)).toEqual(['listen/row_13', 'choice/row_03'])
    expect(build.slots[0].args).toEqual({ difficulty: 2 })
    expect(build.slots[1].args).toBeUndefined()
    // phase/order 取行元数据
    expect(build.slots[0]).toMatchObject({ phase: 2, order: 2 })
    expect(build.slots[1]).toMatchObject({ phase: 1, order: 2 })
    // 显式题单存在时自动题单预览仍可取
    expect(buildAutoManifest(doc).length).toBeGreaterThan(build.slots.length - 1)
  })

  it('悬空题型/行 → ManifestError（可读中文）', () => {
    const doc = twoTypeLevelDoc()
    doc.content.manifest = { entries: [{ type: 'nope', row: 'row_01' }] }
    expect(() => buildExplicitManifest(doc)).toThrow(ManifestError)
    expect(() => buildExplicitManifest(doc)).toThrow(/不存在的题型/)
    doc.content.manifest = { entries: [{ type: 'choice', row: 'row_99' }] }
    expect(() => buildExplicitManifest(doc)).toThrow(/不存在的行/)
  })

  it('同一槽位可重复出现（args 不同，实例态共享由运行时处理）', () => {
    const doc = twoTypeLevelDoc()
    doc.content.manifest = {
      entries: [
        { type: 'choice', row: 'row_01', args: { a: 1 } },
        { type: 'choice', row: 'row_01', args: { a: 2 } },
      ],
    }
    const build = buildExplicitManifest(doc)
    expect(build).toHaveLength(2)
    expect(build[0].args).toEqual({ a: 1 })
    expect(build[1].args).toEqual({ a: 2 })
  })
})

describe('v4 manifest：牌堆', () => {
  it('默认顺序 = 题单顺序 + slotIndex 连续', () => {
    const doc = twoTypeLevelDoc()
    const build = buildDeck(doc)
    expect(build.explicit).toBe(false)
    expect(refs(build.deck)).toEqual(refs(buildAutoManifest(doc)))
    expect(build.deck.map((d) => d.slotIndex)).toEqual([0, 1, 2, 3, 4])
  })

  it('count 在洗牌后截断', () => {
    const doc = twoTypeLevelDoc()
    doc.content.run.count = 2
    const build = buildDeck(doc)
    expect(build.deck).toHaveLength(2)
    expect(build.deck.map((d) => d.slotIndex)).toEqual([0, 1])
  })

  it('shuffle + 固定 seed 可复现；同 seed 同牌堆、不同 seed 不同牌堆', () => {
    const doc = twoTypeLevelDoc()
    doc.content.run.order = 'shuffle'
    const a = buildDeck(doc, { seed: 42 })
    const b = buildDeck(doc, { seed: 42 })
    expect(a.deck).toEqual(b.deck)
    expect(a.seed).toBe(42)
    const c = buildDeck(doc, { seed: 43 })
    expect(refs(c.deck)).not.toEqual(refs(a.deck))
    // 牌堆是题单的排列（无增删）
    expect([...refs(a.deck)].sort()).toEqual([...refs(buildAutoManifest(doc))].sort())
  })

  it('shuffleWithinPhase=true：阶段顺序不变、组内洗牌', () => {
    const doc = twoTypeLevelDoc()
    doc.content.run.order = 'shuffle'
    const build = buildDeck(doc, { seed: 7 })
    expect(build.deck.map((d) => d.phase)).toEqual([1, 1, 1, 2, 2])
  })

  it('shuffleWithinPhase=false：允许跨阶段交错但仍是同一排列', () => {
    const doc = twoTypeLevelDoc()
    doc.content.run.order = 'shuffle'
    doc.content.run.shuffleWithinPhase = false
    const build = buildDeck(doc, { seed: 7 })
    expect(refs(build.deck).sort()).toEqual([...refs(buildAutoManifest(doc))].sort())
    expect(build.deck).toHaveLength(5)
  })

  it('seed=null 时用注入随机源生成并记录 seed', () => {
    const doc = minimalLevelDoc()
    doc.content.run.order = 'shuffle'
    const build = buildDeck(doc, { random: () => 0.5 })
    expect(build.seed).toBe(Math.floor(0.5 * 0x1_0000_0000) >>> 0)
    expect(build.deck).toHaveLength(2)
  })

  it('显式题单的 args 带入牌堆项', () => {
    const doc = twoTypeLevelDoc()
    doc.content.manifest = { entries: [{ type: 'choice', row: 'row_01', args: { difficulty: 3 } }] }
    const build = buildDeck(doc)
    expect(build.explicit).toBe(true)
    expect(build.deck[0].args).toEqual({ difficulty: 3 })
  })
})

describe('v4 manifest：seed / PRNG / 洗牌原语', () => {
  it('resolveSeed：数字取绝对值整数、字符串走 FNV、null 走随机源', () => {
    expect(resolveSeed(42)).toBe(42)
    expect(resolveSeed(-3)).toBe(3)
    expect(resolveSeed(3.9)).toBe(3)
    expect(resolveSeed(Number.NaN)).toBe(hashSeed('NaN'))
    expect(resolveSeed('abc')).toBe(hashSeed('abc'))
    expect(resolveSeed('abc')).toBe(resolveSeed('abc'))
    expect(resolveSeed(null, () => 0.25)).toBe(Math.floor(0.25 * 0x1_0000_0000) >>> 0)
  })

  it('hashSeed 稳定且不同输入不同结果', () => {
    expect(hashSeed('a')).toBe(hashSeed('a'))
    expect(hashSeed('a')).not.toBe(hashSeed('b'))
  })

  it('mulberry32 同 seed 同序列、值域 [0,1)', () => {
    const a = mulberry32(123)
    const b = mulberry32(123)
    for (let i = 0; i < 20; i++) {
      const x = a()
      expect(x).toBe(b())
      expect(x).toBeGreaterThanOrEqual(0)
      expect(x).toBeLessThan(1)
    }
  })

  it('shuffleWith 不修改入参且产出排列', () => {
    const input = [1, 2, 3, 4, 5]
    const out = shuffleWith(input, mulberry32(1))
    expect(input).toEqual([1, 2, 3, 4, 5])
    expect([...out].sort((x, y) => x - y)).toEqual([1, 2, 3, 4, 5])
  })

  it('shuffleWithinPhase 只组内重排并保持阶段先后', () => {
    const slots = [
      { type: 'a', row: 'r1', phase: 1, order: 0 },
      { type: 'a', row: 'r2', phase: 2, order: 0 },
      { type: 'a', row: 'r3', phase: 1, order: 1 },
    ]
    const out = shuffleWithinPhase(slots, mulberry32(5))
    expect(out.map((s) => s.phase)).toEqual([1, 1, 2])
    expect([...out].sort((x, y) => x.row.localeCompare(y.row)).map((s) => s.row)).toEqual(['r1', 'r2', 'r3'])
  })
})
