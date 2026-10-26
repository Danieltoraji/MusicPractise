/**
 * v4 内置样例生成器 + 新鲜度测试（docs/52 W4.1 / docs/51 §6）。
 *
 * 用法：
 * - `UPDATE_SAMPLES=1 npx vitest run src/sample/v4/generate.test.ts` → 把 10 个 builder 结果
 *   写成 `src/sample/v4/<name>.level.json`（提交产物，W9 再覆盖 `src/sample/*.level.json`）；
 * - 默认运行 → 断言已提交 JSON 与 builder 输出**字节一致**（新鲜度），并做 schema 双校验
 *   （Ajv + cfworker 装载管线）与 lint 零告警检查。改数据行/题型后必须重跑 UPDATE_SAMPLES 生成。
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import Ajv2020 from 'ajv/dist/2020'
import { describe, expect, it } from 'vitest'
import { SCHEMA_RAW, SCHEMA_V4_LEVEL_ID, loadLevelDocV4 } from '../../library/validate'
import { SAMPLE_LEVELS } from './levels'

const UPDATE = process.env.UPDATE_SAMPLES === '1'
const SAMPLE_DIR = fileURLToPath(new URL('.', import.meta.url))

const ajv = new Ajv2020({ strict: false, allErrors: true })
for (const schema of SCHEMA_RAW) ajv.addSchema(schema as never)
const ajvValidate = ajv.getSchema(SCHEMA_V4_LEVEL_ID)!
void ajvValidate

function render(doc: unknown): string {
  return `${JSON.stringify(doc, null, 2)}\n`
}

describe('v4 内置样例 · 生成与新鲜度', () => {
  it('关卡清单：文件名 / 关卡 id / 标题唯一，且为 10 个内置样例', () => {
    expect(SAMPLE_LEVELS).toHaveLength(10)
    expect(new Set(SAMPLE_LEVELS.map((level) => level.file)).size).toBe(SAMPLE_LEVELS.length)
    expect(new Set(SAMPLE_LEVELS.map((level) => level.id)).size).toBe(SAMPLE_LEVELS.length)
    expect(new Set(SAMPLE_LEVELS.map((level) => level.title)).size).toBe(SAMPLE_LEVELS.length)
    for (const spec of SAMPLE_LEVELS) {
      expect(spec.file.endsWith('.level.json')).toBe(true)
      expect(spec.id).toMatch(/^res_[0-9A-HJKMNP-TV-Z]{26}$/)
    }
  })

  it('结构约定：每型一张实例表 / 缺省自动题单 / flow 单 start + finish', () => {
    for (const spec of SAMPLE_LEVELS) {
      const doc = spec.build()
      const typeIds = doc.content.types.map((type) => type.id)
      expect(Object.keys(doc.content.tables).sort()).toEqual([...typeIds].sort())
      expect(doc.content.manifest).toBeUndefined()
      expect(doc.content.run).toEqual({ order: 'manifest', count: null, seed: null, shuffleWithinPhase: true })
      expect(doc.content.flow.nodes.filter((node) => node.kind === 'start')).toHaveLength(1)
      expect(doc.content.flow.nodes.some((node) => node.kind === 'finish')).toBe(true)
      for (const type of doc.content.types) {
        const table = doc.content.tables[type.id]
        expect(table.rows.length).toBeGreaterThan(0)
        expect(table.columns.length).toBeGreaterThan(0)
        expect(type.behavior.nodes.some((node) => node.kind === 'on' && node.event === 'start')).toBe(true)
        expect(type.behavior.nodes.some((node) => node.kind === 'return')).toBe(true)
        expect(type.surface.components.length).toBeGreaterThan(0)
      }
      expect(doc.id).toBe(spec.id)
      expect(doc.meta.title).toBe(spec.title)
    }
  })

  for (const spec of SAMPLE_LEVELS) {
    it(`${spec.file}：schema 双校验 + lint 零告警 + 产物新鲜度`, () => {
      const doc = spec.build()
      expect(doc.schemaVersion).toBe(4)
      expect(doc.id).toBe(spec.id)
      expect(doc.version).toBe('1.0.0')
      expect(doc.meta.title).toBe(spec.title)
      // Ajv（测试侧全量错误）与 cfworker（装载管线）双校验
      const ajvOk = ajvValidate(doc)
      expect(ajvOk, JSON.stringify(ajvValidate.errors)).toBe(true)
      const loaded = loadLevelDocV4(doc)
      expect(loaded.ok, loaded.ok ? '' : loaded.errors.join(' / ')).toBe(true)
      if (loaded.ok) expect(loaded.lintWarnings).toEqual([])

      const file = join(SAMPLE_DIR, spec.file)
      const expected = render(doc)
      if (UPDATE) writeFileSync(file, expected, 'utf8')
      expect(readFileSync(file, 'utf8'), `产物已过期：请运行 UPDATE_SAMPLES=1 npx vitest run src/sample/v4/generate.test.ts`).toBe(expected)
    })
  }
})
