// @vitest-environment node
/**
 * G6（docs/42 §5.1-6）：首帧皮肤预置的「静态链」回归——内联脚本在生产 CSP
 * `script-src 'self'` 下会被拦截（dev 通过、生产静默失效），必须外置为 public 静态脚本。
 * 同时互锁 skin-boot.js 的白名单与 skin/prefs.ts 的 SKIN_IDS（改一处漏另一处即变红）。
 */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { describe, expect, it } from 'vitest'
import { SKIN_IDS } from '../skin/prefs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const read = (rel: string): string => readFileSync(resolve(ROOT, rel), 'utf8')

const INDEX_HTML = read('index.html')
const BOOT_JS = read('public/skin-boot.js')

/** 扫出所有无 src 的 <script> 块（内联脚本；有 src 的外链脚本不算） */
function findInlineScripts(html: string): { attrs: string; body: string }[] {
  return [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)]
    .filter(([, attrs]) => !/\bsrc\s*=/i.test(attrs))
    .map(([, attrs, body]) => ({ attrs, body }))
}

/** 在隔离 vm 里跑首帧脚本（模拟 document/localStorage），返回 dataset.skin */
function runBoot(stored: string | null): { skin: string | undefined; threw: boolean } {
  const documentElement: { dataset: Record<string, string> } = { dataset: {} }
  const sandbox = {
    localStorage: { getItem: (key: string): string | null => (key === 'skin.prefs.v1' ? stored : null) },
    document: { documentElement },
  }
  let threw = false
  try {
    runInNewContext(BOOT_JS, sandbox)
  } catch {
    threw = true
  }
  return { skin: documentElement.dataset.skin, threw }
}

describe('G6 首帧皮肤预置（index.html / public/skin-boot.js）', () => {
  it('index.html 不再含内联 <script> 代码块（生产 CSP script-src self 下必被拦）', () => {
    const inline = findInlineScripts(INDEX_HTML)
    expect(inline.map((s) => s.body.trim()).filter(Boolean)).toEqual([])
  })

  it('index.html 在 head 内以 BASE_URL 或相对路径引用 skin-boot.js（经典同步脚本，非 module）', () => {
    const head = INDEX_HTML.slice(0, INDEX_HTML.toLowerCase().indexOf('</head>'))
    const tag = head.match(/<script\b[^>]*\bsrc="(?:%BASE_URL%|\.\/|\/)?skin-boot\.js"[^>]*><\/script>/i)?.[0]
    expect(tag, 'head 内应有 skin-boot.js 的 script 标签').toBeTruthy()
    // 必须同步执行：type="module" 会 defer 到解析后，FOUC 窗口重新出现
    expect(tag).not.toMatch(/type="module"/i)
    // main.tsx 模块入口仍是 Vite 管理的 src 引用（未被外置改造误伤）
    expect(INDEX_HTML).toContain('src="/src/main.tsx"')
  })

  it("两通道 CSP 均保持 script-src 'self'（外置脚本的前置条件）", () => {
    expect(read('public/_headers')).toContain("script-src 'self'")
    expect(read('worker/http.ts')).toContain("script-src 'self'")
  })

  it('public/skin-boot.js 存在且白名单与 skin/prefs.ts 的 SKIN_IDS 完全一致', () => {
    expect(existsSync(resolve(ROOT, 'public/skin-boot.js'))).toBe(true)
    const arr = BOOT_JS.match(/\[([^\]]*)\]\.indexOf\(/)
    expect(arr, 'skin-boot.js 应通过白名单数组 indexOf 校验 skinId').not.toBeNull()
    const ids = [...arr![1].matchAll(/'([^']+)'/g)].map((m) => m[1])
    expect(ids).toEqual([...SKIN_IDS])
  })

  it('运行行为：白名单 id 写 dataset.skin；未知 id / 损坏 JSON / 无存储均静默保持默认', () => {
    expect(runBoot(JSON.stringify({ skinId: 'violet' }))).toEqual({ skin: 'violet', threw: false })
    expect(runBoot(JSON.stringify({ skinId: 'evil' }))).toEqual({ skin: undefined, threw: false })
    expect(runBoot('{not json')).toEqual({ skin: undefined, threw: false })
    expect(runBoot(null)).toEqual({ skin: undefined, threw: false })
  })

  it('文档顺序：skin-boot.js 先于主模块入口（首帧绘制前设置 data-skin）', () => {
    const bootAt = INDEX_HTML.indexOf('skin-boot.js')
    const mainAt = INDEX_HTML.indexOf('/src/main.tsx')
    expect(bootAt, 'index.html 未引用 skin-boot.js').toBeGreaterThanOrEqual(0)
    expect(mainAt, 'index.html 未引用 main.tsx').toBeGreaterThan(bootAt)
    // 且脚本位于 <head> 内（Vite 构建会保留 head 中的同步外链脚本顺序）
    const headEnd = INDEX_HTML.toLowerCase().indexOf('</head>')
    expect(bootAt).toBeLessThan(headEnd)
  })
})
