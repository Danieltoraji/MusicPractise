#!/usr/bin/env node
/**
 * R33（docs/44）：生产构建静态门禁（docs/45 EXT-4 的可在本环境执行部分）。
 *
 * 用法：npm run build && npm run verify:dist
 * 校验 dist/ 产物：
 *  - index.html 无内联 <script>（生产 CSP script-src 'self' 会拦截）；
 *  - skin-boot.js 外置且先于模块入口（首帧皮肤预置，docs/44 R25）；
 *  - _headers 含 CSP script-src 'self' 且 script-src 不含 unsafe-inline；
 *  - 引用的 /assets 脚本实际存在。
 * 注意：真实部署环境的 CSP 响应头/首帧 FOUC 仍需发布后冒烟（EXT-4 外部部分）。
 */
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const dist = resolve('dist')
const errors = []
const ok = []

function fail(msg) {
  errors.push(msg)
}
function pass(msg) {
  ok.push(msg)
}

const indexHtmlPath = resolve(dist, 'index.html')
if (!existsSync(indexHtmlPath)) {
  fail('dist/index.html 不存在：请先 npm run build')
} else {
  const html = readFileSync(indexHtmlPath, 'utf8')
  const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)]
  const inline = scripts.filter((m) => !/\bsrc\s*=/i.test(m[1]))
  if (inline.length > 0) fail(`index.html 存在 ${inline.length} 个内联 <script>（CSP 会拦截）`)
  else pass('index.html 无内联 script')

  const boot = scripts.find((m) => /\bsrc\s*=\s*["'][^"']*skin-boot\.js/.test(m[1]))
  const moduleEntry = scripts.find((m) => /type\s*=\s*["']module["']/.test(m[1]))
  if (!boot) fail('index.html 未引用 skin-boot.js（首帧 FOUC 预置缺失）')
  else if (!existsSync(resolve(dist, 'skin-boot.js'))) fail('dist/skin-boot.js 不存在')
  else if (moduleEntry && html.indexOf(boot[0]) > html.indexOf(moduleEntry[0])) {
    fail('skin-boot.js 必须位于模块入口之前（同步执行、先于首帧）')
  } else pass('skin-boot.js 外置且先于模块入口')

  if (!moduleEntry) fail('index.html 未找到 type="module" 的构建入口')
  else {
    const m = /src\s*=\s*["']([^"']+)["']/.exec(moduleEntry[1])
    if (!m) fail('模块入口缺少 src')
    else {
      const asset = resolve(dist, m[1].replace(/^\//, ''))
      if (!existsSync(asset)) fail(`模块入口资源不存在：${m[1]}`)
      else pass(`模块入口资源存在：${m[1]}`)
    }
  }
}

const headersPath = resolve(dist, '_headers')
if (!existsSync(headersPath)) {
  fail('dist/_headers 不存在（静态安全头缺失）')
} else {
  const headers = readFileSync(headersPath, 'utf8')
  const cspLine = headers.split('\n').find((line) => /Content-Security-Policy:/i.test(line)) ?? ''
  if (!cspLine) fail('_headers 缺少 Content-Security-Policy')
  else {
    if (!/script-src\s+'self'/.test(cspLine)) fail("CSP 缺少 script-src 'self'")
    else if (/script-src[^;]*'unsafe-inline'/.test(cspLine)) fail("script-src 含 'unsafe-inline'")
    else if (!/object-src\s+'none'/.test(cspLine)) fail("CSP 缺少 object-src 'none'")
    else pass('CSP script-src 仅 self、object-src none')
  }
}

for (const line of ok) console.log(`✓ ${line}`)
for (const line of errors) console.error(`✗ ${line}`)
if (errors.length > 0) {
  console.error(`\nverify:dist 失败（${errors.length} 项）`)
  process.exit(1)
}
console.log(`\nverify:dist 通过（${ok.length} 项静态生产门禁）`)
