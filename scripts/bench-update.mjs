#!/usr/bin/env node
/**
 * R18（docs/44）R11 写路径基准门控：混合 schema 满配文档的 update 管线耗时。
 *
 * docs/41「R11」曾用临时脚本测出纯文本型 350–438KB 文档 3.0–4.6ms，docs/42 复跑的
 * 混合列（json/list）381KB 满配为 4.97–8.9ms（多数 >5ms、方差大）——脚本未入库导致无法复跑。
 * 本脚本把口径固化：schema 上限（32 列 / 512 行 / 64 组件）+ 混合列类型，测 5 条写路径：
 *   - structuredClone（基线：所有 docState 变换的共同成本）
 *   - updateTableCell（逐键输入热路径）
 *   - updateComponent（画布 Inspector 热路径）
 *   - setMeta（标题逐键输入热路径）
 *   - updateTableColumnLabel（列名编辑）
 *
 * 运行：node scripts/bench-update.mjs [--iterations=40] [--json]
 * 输出：P50/P95/max/mean（ms）+ 文档字节数；--json 输出机器可读结果。
 *
 * 说明：这是 Node/V8 的服务端近似，不含 React 渲染与浏览器 GC 差异；结论用于门控方向判断，
 * 与 docs/42 的浏览器数据同量级比较时以 P95/相对倍数为准。
 */
import { createServer } from 'vite'
import { performance } from 'node:perf_hooks'

const args = process.argv.slice(2)
const iterationsArg = args.find((a) => a.startsWith('--iterations='))
const ITER = iterationsArg ? Math.max(5, Number(iterationsArg.split('=')[1])) : 40
const WARMUP = 8
const JSON_OUT = args.includes('--json')

const server = await createServer({
  logLevel: 'error',
  appType: 'custom',
  server: { middlewareMode: true },
})
const mod = await server.ssrLoadModule('/src/editor/docState.ts')
const { SCHEMA_LIMITS } = await server.ssrLoadModule('/src/library/schemaLimits.ts')
await server.close()

/** 混合类型满配文档：组件 64 + 视图 8 + 列 32（text/number/boolean/notes/list/json 轮转）+ 行 512 */
function makeFullDoc() {
  let doc = mod.blankLevelDoc()
  const types = ['text', 'number', 'boolean', 'notes', 'list', 'json']
  const columns = Array.from({ length: SCHEMA_LIMITS.tableColumns }, (_, i) => ({
    key: `c${i}`,
    label: `列${i}`,
    type: types[i % types.length],
  }))
  const rows = Array.from({ length: SCHEMA_LIMITS.tableRows }, (_, r) => {
    const row = {}
    for (let i = 0; i < columns.length; i += 1) {
      const type = types[i % types.length]
      const key = `c${i}`
      if (type === 'text') row[key] = `第${r + 1}题`
      else if (type === 'number') row[key] = r * 10 + i
      else if (type === 'boolean') row[key] = i % 2 === 0
      else if (type === 'notes') row[key] = 'C4:4n D4:4n E4:4n F4:4n G4:4n A4:4n'
      else if (type === 'list') row[key] = ['提示A', `第${r + 1}行`]
      else row[key] = { row: r, col: i }
    }
    return row
  })
  doc = mod.setTable(doc, { columns, rows })
  doc.content.views = [{ id: 'main', name: '主视图' }].concat(
    Array.from({ length: SCHEMA_LIMITS.views - 1 }, (_, i) => ({ id: `view${i + 2}`, name: `视图${i + 2}` })),
  )
  doc.content.components = Array.from({ length: SCHEMA_LIMITS.components }, (_, i) => ({
    id: `comp${i}`,
    type: 'button',
    view: i % 2 === 0 ? 'main' : `view${(i % (SCHEMA_LIMITS.views - 1)) + 2}`,
    name: `按钮${i}`,
    visible: true,
    layout: { x: 40 + (i % 8) * 120, y: 40 + Math.floor(i / 8) * 80, w: 100, h: 48 },
    props: { text: `按钮文案${i}`, tone: 'info' },
  }))
  doc.meta.title = '满配混合文档性能基准'
  return doc
}

function percentile(sorted, p) {
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))
  return sorted[idx]
}

function bench(label, fn) {
  for (let i = 0; i < WARMUP; i += 1) fn()
  const times = []
  for (let i = 0; i < ITER; i += 1) {
    const t0 = performance.now()
    fn()
    times.push(performance.now() - t0)
  }
  times.sort((a, b) => a - b)
  const mean = times.reduce((s, t) => s + t, 0) / times.length
  return {
    label,
    p50: Number(percentile(times, 50).toFixed(3)),
    p95: Number(percentile(times, 95).toFixed(3)),
    max: Number(times[times.length - 1].toFixed(3)),
    mean: Number(mean.toFixed(3)),
  }
}

const doc = makeFullDoc()
const bytes = Buffer.byteLength(JSON.stringify(doc))
const midRow = Math.floor(doc.content.table.rows.length / 2)
const midComp = doc.content.components[Math.floor(doc.content.components.length / 2)].id

const results = [
  bench('structuredClone（基线）', () => structuredClone(doc)),
  bench('updateTableCell（单元格逐键）', () => mod.updateTableCell(doc, midRow, { c0: `改-${Math.random()}` })),
  bench('updateComponent（画布 Inspector）', () => mod.updateComponent(doc, midComp, { name: '改名' })),
  bench('setMeta（标题逐键）', () => mod.setMeta(doc, { title: `标题-${Math.random()}` })),
  bench('updateTableColumnLabel（列名）', () => mod.updateTableColumnLabel(doc, 'c1', `标签-${Math.random()}`)),
]

const summary = {
  generatedAt: new Date().toISOString(),
  docBytes: bytes,
  docKB: Number((bytes / 1024).toFixed(1)),
  rows: doc.content.table.rows.length,
  columns: doc.content.table.columns.length,
  components: doc.content.components.length,
  iterations: ITER,
  results,
}

if (JSON_OUT) {
  console.log(JSON.stringify(summary, null, 2))
} else {
  console.log('R11 写路径基准（混合 schema 满配）')
  console.log(`文档：${summary.docKB}KB（${summary.rows} 行 × ${summary.columns} 列，${summary.components} 组件）`)
  console.log(`迭代：${ITER} 次（warmup ${WARMUP}）`)
  console.log('')
  console.log('| 路径 | P50 | P95 | max | mean |')
  console.log('|---|---:|---:|---:|---:|')
  for (const r of results) {
    console.log(`| ${r.label} | ${r.p50.toFixed(2)}ms | ${r.p95.toFixed(2)}ms | ${r.max.toFixed(2)}ms | ${r.mean.toFixed(2)}ms |`)
  }
  console.log('')
  const clone = results[0]
  const cell = results[1]
  console.log(`判读：structuredClone P95=${clone.p95.toFixed(2)}ms；单元格热路径 P95=${cell.p95.toFixed(2)}ms`)
  console.log('门控：P95 < 5ms 且各次运行稳定 → 可维持现有实现/或按需 patch；否则 patch 化收益成立。')
}
