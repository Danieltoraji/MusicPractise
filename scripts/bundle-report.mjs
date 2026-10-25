#!/usr/bin/env node
/**
 * R40：发布构建产物 gzip 记录（EXT-5）。
 *
 * 只读统计 dist/ 下 JS/CSS/HTML 的原始与 gzip 体积，用于发布前记录与回涨观察；
 * 不设硬失败阈值（docs/45 EXT-5 口径：记录优先，超阈值再立项）。
 *
 * 用法：node scripts/bundle-report.mjs [--json]
 */
import { gzipSync } from 'node:zlib'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { execSync } from 'node:child_process'

const ROOT = resolve(import.meta.dirname, '..')
const DIST = join(ROOT, 'dist')
const JSON_OUT = process.argv.includes('--json')

function walk(dir) {
  const out = []
  for (const name of readdirSync(dir)) {
    const file = join(dir, name)
    const st = statSync(file)
    if (st.isDirectory()) out.push(...walk(file))
    else out.push(file)
  }
  return out
}

function commit() {
  try {
    return execSync('git rev-parse --short HEAD', { encoding: 'utf8', cwd: ROOT }).trim()
  } catch {
    return 'unknown'
  }
}

const files = walk(DIST)
  .filter((f) => /\.(js|css|html)$/.test(f))
  .map((f) => {
    const raw = readFileSync(f)
    return {
      file: relative(DIST, f).replaceAll('\\', '/'),
      raw: raw.length,
      gzip: gzipSync(raw, { level: 9 }).length,
    }
  })
  .sort((a, b) => b.gzip - a.gzip)

const total = files.reduce((acc, f) => ({ raw: acc.raw + f.raw, gzip: acc.gzip + f.gzip }), { raw: 0, gzip: 0 })

// 首屏 eager 集合：index.html 直接引用的 script/modulepreload/stylesheet + 自身 + skin-boot。
// 其余（如 GraphEditor/AiPanel/vexflow）是路由/功能懒加载 chunk，不计入首屏。
const html = readFileSync(join(DIST, 'index.html'), 'utf8')
const refs = new Set([...html.matchAll(/(?:src|href)="\/([^"]+)"/g)].map((m) => m[1]))
const eager = files.filter((f) => f.file === 'index.html' || refs.has(f.file))
const eagerTotal = eager.reduce((acc, f) => ({ raw: acc.raw + f.raw, gzip: acc.gzip + f.gzip }), { raw: 0, gzip: 0 })

const report = {
  commit: commit(),
  generatedAt: new Date().toISOString(),
  files,
  total,
  eagerTotal,
  eagerFiles: eager.map((f) => f.file),
}

if (JSON_OUT) {
  console.log(JSON.stringify(report, null, 2))
} else {
  const kb = (n) => `${(n / 1024).toFixed(1)}KB`
  console.log(`# bundle report @ ${report.commit}`)
  console.log('')
  console.log('| 文件 | raw | gzip |')
  console.log('|---|---:|---:|')
  for (const f of files) console.log(`| ${f.file} | ${kb(f.raw)} | ${kb(f.gzip)} |`)
  console.log(`| **合计（JS/CSS/HTML）** | **${kb(total.raw)}** | **${kb(total.gzip)}** |`)
  console.log(`| **首屏 eager（index.html 直接引用）** | **${kb(eagerTotal.raw)}** | **${kb(eagerTotal.gzip)}** |`)
  console.log('')
  console.log(`首屏文件：${report.eagerFiles.join(', ')}`)
}
